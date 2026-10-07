/**
 * 賞与の配分（docs/wage-system.md 第7節）。
 *
 *   単価 = 原資 ÷ 合計点 → 各人 = 点数 × 単価（千円切り上げ）
 *
 * 業績連動は**原資の決定**に集約している。配分側に係数は掛けない。
 *
 * 試算だけだと「誰にいくら払ったか」が残らず、翌年の参考にできないため、
 * 確定した配分を jpBonuses に凍結して保存する。
 *
 * - GET    … 過去の支給記録＋直近改定の評語（初期値に使う）
 * - POST   … 配分を確定して保存
 * - DELETE … 確定の取り消し（2026-10-07。押し間違えたときに、記録と有給の買取記録をまとめて戻す）
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers, isAlreadyRetired, effectiveRateForYm } from '@/lib/workers'
import { allocateBonus, nextRevisionDate, lastRevisionDate, FIVE_DAY_RESERVE, FIXED_BONUS_STEP_DOWN, type BonusMember, type Hyogo, type JpGrade } from '@/lib/jp-wage'
import { MIGRATION_2026 } from '@/lib/jp-wage-migration.server'
import { todayJstIso } from '@/lib/date-utils'
import { getEndedPeriodBalance } from '@/lib/leave-balance'
import { logActivity } from '@/lib/activity'

export const dynamic = 'force-dynamic'

/**
 * 処遇固定の人（移行表の fixed・梶原さん）は賞与の点数を FIXED_BONUS_STEP_DOWN 段下げて数える
 * （2026-10-07 代表決定「4G の半分くらい」）。GET（画面の試算）と POST（確定）で同じ関数を使う。
 */
const FIXED_IDS = new Set(MIGRATION_2026.filter(m => m.fixed).map(m => m.id))
function bonusStepDownOf(workerId: number): number {
  return FIXED_IDS.has(workerId) ? FIXED_BONUS_STEP_DOWN : 0
}

/**
 * 精勤賞与（有給の買取）の日額 = **買い取る期の最後の日に払っていた日額**（2026-10-07 代表決定）。
 * 9/30 に終わった期の買取なら、10/1 改定前の日額（prevRate）。改定後の日額では買い取らない。
 * 終わった期が無い人は買取 0日なので、表示用に今の日額を返す。
 */
function buyoutDailyRate(
  w: { rate?: number; rateFrom?: string; prevRate?: number },
  periodLastDay: string,
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodLastDay)) return w.rate || 0
  return effectiveRateForYm(w, periodLastDay.slice(0, 7))
}

/**
 * 1人分の賞与の内訳（2026-08-31 拡張）。
 * 実際の支給は「利益分配 + 精勤(有給買取) + 禁煙手当 + 子ども手当」の合算。
 */
interface BonusLine {
  workerId: number
  name: string
  grade: string
  hyogo: Hyogo
  points: number
  /** 処遇固定のため点数を何段下げて数えたか（0 / 省略 = 下げていない） */
  stepDown?: number
  /** ① 利益分配賞与（点数配分の額。代表が個別に上書きすることがある） */
  amount: number
  /** ② 精勤賞与（有給の買取） */
  attendanceDays?: number
  attendanceRate?: number
  attendanceAmount?: number
  /** ③ 禁煙手当 */
  nonSmokerAmount?: number
  /** ④ 子ども手当 */
  childCount?: number
  childAmount?: number
  /** ①〜④の合計 */
  totalAmount?: number
  /** 支給方法（振込 / 現金）。出向者は出向先から支給されることがある */
  payMethod?: 'transfer' | 'cash'
  /** 出向先から支給される場合の出向先名（合計から分ける） */
  paidBy?: string
}

interface BonusRecord {
  id: string
  label: string
  paidOn: string
  pool: number
  totalPoints: number
  unit: number
  allocations: BonusLine[]
  total: number
  /** 手当込みの支給総額（自社負担分。出向先が支給する人を除く） */
  grandTotal?: number
  actor: string
  savedAt: string
}

export async function GET(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）

  const snap = await getDocs(collection(db, 'jpBonuses'))
  const records: BonusRecord[] = []
  snap.forEach(d => records.push({ id: d.id, ...(d.data() as Omit<BonusRecord, 'id'>) }))
  records.sort((a, b) => b.paidOn.localeCompare(a.paidOn))

  // 評語は年次改定で決めたものを初期値にする。賞与と昇給で別の評価を付けない。
  // 2026-08-27 修正（給与総点検）: 取得元を「直近の基準日 → 無ければ次回の下書き」に。
  //   旧: 常に次回基準日を見ていたため、10/1 を過ぎた冬季賞与（12月）で
  //   確定したばかりの評語が読まれず全員デフォルトAになっていた
  const today = todayJstIso()
  const candidates = [lastRevisionDate(today), nextRevisionDate(today)]
  let effective = candidates[0]
  let entries: Record<string, { hyogo?: Hyogo }> = {}
  for (const cand of candidates) {
    const revSnap = await getDoc(doc(db, 'jpWageRevisions', cand))
    if (revSnap.exists()) {
      entries = (revSnap.data() as { entries?: Record<string, { hyogo?: Hyogo }> }).entries || {}
      effective = cand
      break
    }
  }
  const hyogo: Record<string, Hyogo> = {}
  for (const [id, e] of Object.entries(entries)) if (e.hyogo) hyogo[id] = e.hyogo

  // 賞与の手当を画面で自動計算するための材料（2026-08-31 追加）。
  //   有給残は買取（精勤賞与）の日数、children/nonSmoker は手当の判定に使う。
  const workers = await getWorkers()
  // 退職「予定」（退職日が未来）の人は対象に残す（2026-10-02 総合点検。旧: !w.retired で予定の人も表から消えていた）
  const targets = workers
    .filter(w => !isAlreadyRetired(w.retired, today))
    .filter(w => !w.visaType || w.visaType === 'none')
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
  // ── 精勤賞与の買い取る期（2026-10-02 総合点検で見直し）──
  //   精勤賞与は「終わった期の最後の日に残った有給」の買取（docs/paid-leave.md: 期末買取）。
  //   買い取る期 = 支給日の時点で終わっている直近の期（getEndedPeriodBalance）。休暇管理の「前の期の残り
  //   （賞与で買取予定）」・手動の期末買取と同じ関数で同じ数字を出す。
  //   旧（2026-08-31〜）: 期末を 9/30 固定にして「9/30 時点で有効なレコード」の残を見ていた。
  //     - 入社6ヶ月後・以後1年ごとの日本人（期が 11/30 等に終わる）は、期の途中の残を買い取ることになる
  //     - 付与日を前に寄せた人（2025-12-01 → 2026-10-01）は前の期を丸1年で数え、10〜11月の有給を両方の期で数えて
  //       買取日数が画面より少なかった
  //   まだ終わっていない期は買い取らない（残0・期末なし）。期末買取が記録済みの期も残0で出す
  //   支給日は画面の入力（?paidOn=）に合わせる（既定は今日）
  const paidOnParam = request.nextUrl.searchParams.get('paidOn') || ''
  const bonusAsOf = /^\d{4}-\d{2}-\d{2}$/.test(paidOnParam) ? paidOnParam : today
  const memberInfo = await Promise.all(targets.map(async w => {
    let leaveRemaining = 0
    let leaveGrantDate = ''
    let leavePeriodEnd = ''
    let leaveBuyoutRecorded = false
    try {
      const b = await getEndedPeriodBalance(w.id, bonusAsOf)
      if (b) {
        leaveGrantDate = b.grantDate
        leavePeriodEnd = b.periodLastDay
        leaveBuyoutRecorded = b.yearEndBuyoutRecorded
        leaveRemaining = b.yearEndBuyoutRecorded ? 0 : b.remaining
      }
    } catch { /* 有給が読めなくても賞与の他の項目は出す */ }
    return {
      workerId: w.id,
      name: w.name,
      grade: w.jpGrade || '',
      // 精勤賞与の日額（買い取る期の最後の日の日額・2026-10-07）
      rate: buyoutDailyRate(w, leavePeriodEnd),
      stepDown: bonusStepDownOf(w.id),
      nonSmoker: w.nonSmoker === true,
      children: w.children || [],
      dispatchTo: w.dispatchTo || '',
      leaveRemaining,
      leaveGrantDate,
      leavePeriodEnd,
      leaveBuyoutRecorded,
    }
  }))

  return NextResponse.json({ records, hyogoFrom: effective, hyogo, members: memberInfo })
}

export async function POST(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }  // 賃金は代表・管理者のみ（2026-08-27）
  const body = await request.json()
  const label = String(body.label || '').trim()
  const paidOn = String(body.paidOn || todayJstIso())
  const pool = Number(body.pool) || 0
  const hyogoMap = (body.hyogo || {}) as Record<string, Hyogo>
  // 画面で組み立てた明細（手当込み）。未指定なら従来どおり点数配分だけで保存する
  const linesIn = Array.isArray(body.lines) ? (body.lines as Partial<BonusLine>[]) : null

  if (!label) return NextResponse.json({ error: '支給名が必要です' }, { status: 400 })
  if (pool <= 0) return NextResponse.json({ error: '原資を入力してください' }, { status: 400 })

  const workers = await getWorkers()
  // GET（表）と同じ対象（退職「予定」の人は残す・2026-10-02 総合点検）
  const targets = workers
    .filter(w => !isAlreadyRetired(w.retired, todayJstIso()))
    .filter(w => !w.visaType || w.visaType === 'none')
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
    .filter(w => w.jpGrade)

  if (targets.length === 0) return NextResponse.json({ error: '対象者がいません' }, { status: 409 })

  const members: BonusMember[] = targets.map(w => ({
    workerId: w.id,
    grade: w.jpGrade as JpGrade,
    hyogo: hyogoMap[String(w.id)] || 'A',
    stepDown: bonusStepDownOf(w.id),
  }))
  const { unit, totalPoints, allocations } = allocateBonus(pool, members)

  const id = `${paidOn}-${Date.now()}`
  const auth = await getApiAuthUser(request)
  const lines: BonusLine[] = allocations.map(a => {
    const w = targets.find(x => x.id === a.workerId)
    const sent = linesIn?.find(l => Number(l.workerId) === a.workerId)
    const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0))
    const profit = sent && sent.amount !== undefined ? num(sent.amount) : a.amount
    const attendanceAmount = num(sent?.attendanceAmount)
    const nonSmokerAmount = num(sent?.nonSmokerAmount)
    const childAmount = num(sent?.childAmount)
    return {
      workerId: a.workerId,
      name: w?.name || '',
      grade: a.grade, hyogo: a.hyogo, points: a.points,
      ...(a.stepDown ? { stepDown: a.stepDown } : {}),
      amount: profit,
      attendanceDays: num(sent?.attendanceDays),
      attendanceRate: num(sent?.attendanceRate),
      attendanceAmount,
      nonSmokerAmount,
      childCount: num(sent?.childCount),
      childAmount,
      totalAmount: profit + attendanceAmount + nonSmokerAmount + childAmount,
      payMethod: sent?.payMethod === 'cash' ? 'cash' : 'transfer',
      paidBy: sent?.paidBy ? String(sent.paidBy) : (w?.dispatchTo || ''),
    }
  })

  // ── 精勤賞与（有給買取）のサーバ側検証（2026-09-02 追加・有給総点検 第4回）──
  //   旧はクライアントの attendanceDays をそのまま記録していたため、残数超・年5日枠（残−5日）超・
  //   期中（夏季賞与など）の year-end 記録が素通りだった。
  // 2026-10-02 総合点検: 買い取る期 = 支給日の時点で終わっている直近の期（getEndedPeriodBalance・GET と同じ）。
  //   期の途中（まだ終わっていない）は買い取れない。期末買取が記録済みの期にも重ねて記録しない。
  //   上限「残−5日」（付与日 >= 2026-10-01 の期）の式は代表の判断待ちのため変えていない
  const buyoutTargets = new Map<number, Awaited<ReturnType<typeof getEndedPeriodBalance>>>()
  {
    const errs: string[] = []
    for (const line of lines) {
      const days = line.attendanceDays || 0
      if (days <= 0) {
        // 買い取らない人の精勤賞与は 0 円（画面から金額だけ来ても載せない）
        line.attendanceAmount = 0
        line.totalAmount = line.amount + (line.nonSmokerAmount || 0) + (line.childAmount || 0)
        continue
      }
      const bal = await getEndedPeriodBalance(line.workerId, paidOn)
      if (!bal) { errs.push(`${line.name}: 支給日 ${paidOn} の時点で終わっている有給の期がありません（期の途中では買い取れません）`); continue }
      if (bal.yearEndBuyoutRecorded) { errs.push(`${line.name}: この期（付与日 ${bal.grantDate}〜${bal.periodLastDay}）の期末買取は記録済みです`); continue }
      const cap = bal.grantDate >= '2026-10-01' ? Math.max(0, bal.remaining - FIVE_DAY_RESERVE) : bal.remaining
      if (days > cap) {
        errs.push(`${line.name}: 買取 ${days}日 は上限 ${cap}日 を超えています（期 ${bal.grantDate}〜${bal.periodLastDay}・残 ${bal.remaining}日${bal.grantDate >= '2026-10-01' ? '・年5日分を除く' : ''}）`)
      }
      buyoutTargets.set(line.workerId, bal)
      // 日額と金額はサーバで決め直す（画面の値を信じない・買い取る期の最後の日の日額）
      const w = targets.find(x => x.id === line.workerId)
      const rate = w ? buyoutDailyRate(w, bal.periodLastDay) : 0
      line.attendanceRate = rate
      line.attendanceAmount = days * rate
      line.totalAmount = line.amount + line.attendanceAmount + (line.nonSmokerAmount || 0) + (line.childAmount || 0)
    }
    if (errs.length > 0) {
      return NextResponse.json({ error: '精勤賞与（有給買取）の日数に問題があります', details: errs }, { status: 400 })
    }
  }

  const record: Omit<BonusRecord, 'id'> = {
    label, paidOn, pool, totalPoints, unit,
    allocations: lines,
    total: lines.reduce((s, a) => s + a.amount, 0),
    // 出向先が支給する人は自社の支給総額から除く（2025年の大川さん＝山岡建設工業のケース）
    grandTotal: lines.filter(l => !l.paidBy).reduce((s, l) => s + (l.totalAmount || 0), 0),
    actor: auth.authorized ? String(auth.actor) : 'unknown',
    savedAt: new Date().toISOString(),
  }
  await setDoc(doc(db, 'jpBonuses', id), record)
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-bonus-${id}`), { type: 'jpWage.bonus', ...record })
  } catch (e) {
    console.error('[jp-wage/bonus] auditTrail 書込失敗:', e)
  }

  // ── 精勤賞与 → 有給の買取記録へ自動連動（2026-08-31 代表決定）──
  //   従来は賞与を確定しても plData の buyoutHistory に反映されず、
  //   「買い取ったはずの日を期末までに有給として取得できる」二重取りの余地が残っていた。
  //   確定と同時に、買い取る期（期末9/30時点で有効な付与レコード）へ買取を記録する。
  //
  //   安全弁:
  //   - 同じ期に year-end の買取が既にある人はスキップ（賞与を保存し直しても二重記録しない）。
  //     やり直したい場合は先に休暇管理から既存の買取記録を取り消すこと
  //   - 買取記録の失敗は賞与の保存を巻き戻さない（結果を buyoutResults で返し画面に出す）
  //   - 出向者（山岡支給の大川さん等）も記録する（有給の帳簿は日比側にあるため）
  const buyoutResults: Array<{ workerId: number; name: string; days: number; status: 'recorded' | 'skipped' | 'error'; note?: string }> = []
  const actorStr = auth.authorized ? String(auth.actor) : 'unknown'
  for (const line of lines) {
    const days = line.attendanceDays || 0
    if (days <= 0) continue
    try {
      const docRef = doc(db, 'demmen', 'main')
      const snap = await getDoc(docRef)
      const plData = (snap.exists() ? (snap.data().plData || {}) : {}) as Record<string, Record<string, unknown>[]>
      const wRecords = plData[String(line.workerId)] || []
      // 検証で決めた「終わった期」のレコード（付与日で引く・2026-10-02 総合点検。旧: 9/30 時点で有効なレコード）
      const target = buyoutTargets.get(line.workerId)
      const rec = (target ? wRecords.find(r => r.grantDate === target.grantDate) : undefined) as Record<string, unknown> | undefined
      if (!rec) {
        buyoutResults.push({ workerId: line.workerId, name: line.name, days, status: 'skipped', note: '対象期の付与レコードが見つかりません' })
        continue
      }
      type BuyoutEntry = { at: string; by: string; days: number; amount?: number; reason?: string; bonusId?: string }
      const history = (rec.buyoutHistory as BuyoutEntry[] | undefined) ?? []
      if (history.some(h => h.reason === 'year-end')) {
        buyoutResults.push({ workerId: line.workerId, name: line.name, days, status: 'skipped', note: 'この期の期末買取は記録済み（二重記録を防止）' })
        continue
      }
      const nowIso = new Date().toISOString()
      history.push({
        at: paidOn, by: actorStr, days,
        amount: line.attendanceAmount || 0,
        reason: 'year-end',
        bonusId: id,
      })
      rec.buyoutHistory = history
      rec.buyoutDays = history.reduce((sum, h) => sum + h.days, 0)
      rec.lastEditedAt = nowIso
      rec.lastEditedBy = actorStr
      // race-fix: dot-notation で 1 worker 単位に局所化（/api/leave の buyout と同じパターン）
      await updateDoc(docRef, { [`plData.${String(line.workerId)}`]: wRecords })
      await logActivity('admin', 'leave.buyout',
        `workerId=${line.workerId} 賞与「${label}」の精勤賞与から期末買取 ${days}日 ¥${line.attendanceAmount || 0}（操作者: ${actorStr}）`)
      buyoutResults.push({ workerId: line.workerId, name: line.name, days, status: 'recorded' })
    } catch (e) {
      console.error(`[jp-wage/bonus] 買取記録失敗 workerId=${line.workerId}:`, e)
      buyoutResults.push({ workerId: line.workerId, name: line.name, days, status: 'error', note: '記録に失敗しました。休暇管理から手動で記録してください' })
    }
  }

  return NextResponse.json({ ok: true, record: { id, ...record }, buyoutResults })
}

/**
 * 確定の取り消し（2026-10-07 追加）。
 *
 * 年次改定には「確定を取り消す」があるのに賞与には無く、押し間違えると記録が残り、
 * 精勤賞与から自動で付けた有給の買取記録も1人ずつ休暇管理で取り消すしかなかった。
 * ここで「この賞与（bonusId）が付けた買取記録」だけを外し、賞与の記録を消す。
 * 手で付けた買取（bonusId なし）や、別の賞与が付けた記録には触れない。
 * 消した内容は auditTrail に残す（日次バックアップにも jpBonuses は入っている）。
 */
export async function DELETE(request: NextRequest) {
  { const denied = await requireExecutiveAuth(request); if (denied) return denied }
  const id = request.nextUrl.searchParams.get('id') || ''
  if (!id) return NextResponse.json({ error: '取り消す賞与の id が必要です' }, { status: 400 })
  const ref = doc(db, 'jpBonuses', id)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: 'この賞与の記録が見つかりません（取り消し済みかもしれません）' }, { status: 404 })
  const record = snap.data() as Omit<BonusRecord, 'id'>
  const auth = await getApiAuthUser(request)
  const actorStr = auth.authorized ? String(auth.actor) : 'unknown'

  // ① 有給の買取記録を外す（先に外す。途中で失敗しても賞与の記録が残るので、もう一度押せばやり直せる）
  const mainRef = doc(db, 'demmen', 'main')
  const mainSnap = await getDoc(mainRef)
  const plData = (mainSnap.exists() ? (mainSnap.data().plData || {}) : {}) as Record<string, Record<string, unknown>[]>
  type BuyoutEntry = { at: string; by: string; days: number; amount?: number; reason?: string; bonusId?: string }
  const removed: Array<{ workerId: number; name: string; days: number }> = []
  for (const line of record.allocations || []) {
    const wRecords = plData[String(line.workerId)]
    if (!Array.isArray(wRecords)) continue
    let changed = false
    let days = 0
    for (const rec of wRecords) {
      const history = (rec.buyoutHistory as BuyoutEntry[] | undefined) ?? []
      const keep = history.filter(h => h.bonusId !== id)
      if (keep.length === history.length) continue
      days += history.filter(h => h.bonusId === id).reduce((s, h) => s + (h.days || 0), 0)
      rec.buyoutHistory = keep
      rec.buyoutDays = keep.reduce((s, h) => s + h.days, 0)
      rec.lastEditedAt = new Date().toISOString()
      rec.lastEditedBy = actorStr
      changed = true
    }
    if (!changed) continue
    // 1人分だけ書き換える（POST の記録と同じ dot-notation）
    await updateDoc(mainRef, { [`plData.${String(line.workerId)}`]: wRecords })
    await logActivity('admin', 'leave.buyout',
      `workerId=${line.workerId} 賞与「${record.label}」の取り消しで期末買取 ${days}日 を外した（操作者: ${actorStr}）`)
    removed.push({ workerId: line.workerId, name: line.name, days })
  }

  // ② 賞与の記録を消す（中身は auditTrail に残す）
  try {
    await setDoc(doc(db, 'auditTrail', `jpwage-bonus-cancel-${id}-${Date.now()}`), {
      type: 'jpWage.bonus.cancel', bonusId: id, record, removedBuyouts: removed,
      actor: actorStr, at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[jp-wage/bonus] 取り消しの auditTrail 書込失敗:', e)
  }
  await deleteDoc(ref)
  return NextResponse.json({ ok: true, removedBuyouts: removed })
}

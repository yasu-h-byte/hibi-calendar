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
 * - GET  … 過去の支給記録＋直近改定の評語（初期値に使う）
 * - POST … 配分を確定して保存
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs } from '@/lib/fsdb'
import { getWorkers } from '@/lib/workers'
import { allocateBonus, nextRevisionDate, lastRevisionDate, type BonusMember, type Hyogo, type JpGrade } from '@/lib/jp-wage'
import { todayJstIso } from '@/lib/date-utils'
import { getLeaveBalance } from '@/lib/leave-balance'

export const dynamic = 'force-dynamic'

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
  const targets = workers
    .filter(w => !w.retired)
    .filter(w => !w.visaType || w.visaType === 'none')
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
  const memberInfo = await Promise.all(targets.map(async w => {
    let leaveRemaining = 0
    let leaveGrantDate = ''
    try {
      const b = await getLeaveBalance(w.id, today)
      leaveRemaining = b.noGrant ? 0 : b.remaining
      leaveGrantDate = b.noGrant ? '' : b.grantDate
    } catch { /* 有給が読めなくても賞与の他の項目は出す */ }
    return {
      workerId: w.id,
      name: w.name,
      grade: w.jpGrade || '',
      rate: w.rate || 0,
      nonSmoker: w.nonSmoker === true,
      children: w.children || [],
      dispatchTo: w.dispatchTo || '',
      leaveRemaining,
      leaveGrantDate,
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
  const targets = workers
    .filter(w => !w.retired)
    .filter(w => !w.visaType || w.visaType === 'none')
    .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
    .filter(w => w.jpGrade)

  if (targets.length === 0) return NextResponse.json({ error: '対象者がいません' }, { status: 409 })

  const members: BonusMember[] = targets.map(w => ({
    workerId: w.id,
    grade: w.jpGrade as JpGrade,
    hyogo: hyogoMap[String(w.id)] || 'A',
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

  return NextResponse.json({ ok: true, record: { id, ...record } })
}

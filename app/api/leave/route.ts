import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, setDoc } from '@/lib/fsdb'
import { getMainData, getMultiMonthAttData, parseDKey, isDispatchedAt } from '@/lib/compute'
import { ymKey, setAttendanceEntry, computeAttendanceDeleteFields } from '@/lib/attendance'
import { isAlreadyRetired } from '@/lib/workers'
import { addMonthsSafe, todayJstIso, calcExpiryIso, calcLastUsableDayIso, isLeaveExpiredAsOf, daysBetween } from '@/lib/date-utils'
import { computePeriodUsed, judgeFiveDayObligation, calcLegalPL, computeUsedDays, computeRemainingDays, calcLegalCarryOver, hasManualCarryOverOverride, selectActiveGrantRecord, validateGrantInput, grantPeriodsOverlap , jpNextGrantAfter } from '@/lib/leave-compute'
import { updateMapByKey } from '@/lib/firestore-safe'
import { logActivity } from '@/lib/activity'

/**
 * 前期残日数から新FY付与時の carryOver 値を計算する共通ヘルパー
 * - 日本人（visa='none'）: 常に 0（期末買取制）
 * - 外国人: 前期（new grantDate より前で最新の grantDate を持つレコード）から
 *   grantDays + carryOver - adjustment - periodUsed を計算し、0〜20 で丸める
 */
type PLRecLite = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
function calcCarryOverForWorker(
  workerId: number,
  newGrantDate: string,
  records: PLRecLite[],
  allAtt: Record<string, Record<string, unknown>>,
  isJapanese: boolean,
): number {
  if (isJapanese) return 0
  const newGrantTime = new Date(newGrantDate).getTime()
  if (isNaN(newGrantTime)) return 0

  // ⚠️ 2026-05-08 修正: archived（時効処理済）レコードは前期判定から除外
  const prevRecs = records
    .filter(r => !(r as PLRecLite & { _archived?: boolean })._archived)
    .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
    .filter(r => {
      const t = new Date(r.grantDate!).getTime()
      return !isNaN(t) && t < newGrantTime
    })
    .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
  const prevRec = prevRecs[prevRecs.length - 1]
  if (!prevRec) return 0

  const prevStart = new Date(prevRec.grantDate!)
  const prevEnd = new Date(prevStart)
  prevEnd.setFullYear(prevEnd.getFullYear() + 1)

  // 多現場の同日重複（multi-site dup）を排除して1日1カウントに正規化
  const seenDates = new Set<string>()
  let periodUsed = 0
  for (const [key, entry] of Object.entries(allAtt)) {
    if (!entry) continue
    const e = entry as { p?: number | boolean }
    if (!e.p) continue
    const pk = parseDKey(key)
    if (parseInt(pk.wid) !== workerId) continue
    const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
    if (d < prevStart || d >= prevEnd) continue
    const dk = `${pk.ym}_${pk.day}`
    if (seenDates.has(dk)) continue
    seenDates.add(dk)
    periodUsed++
  }

  const prevGrant = prevRec.grantDays ?? prevRec.grant ?? 0
  const prevCarry = prevRec.carryOver ?? prevRec.carry ?? 0
  const prevAdj = prevRec.adjustment ?? prevRec.adj ?? 0
  // 前期の買取済み日数（cached buyoutDays 優先、なければ履歴合算）
  const prevRecFull = prevRec as PLRecLite & { buyoutDays?: number; buyoutHistory?: Array<{ days?: number }> }
  const prevBuyout = prevRecFull.buyoutDays ?? (prevRecFull.buyoutHistory || []).reduce((s, h) => s + (h.days || 0), 0)
  // 労基法115条準拠: 前々期付与分(prevCarry)は時効消滅するため、繰越上限は prevGrant（共通ヘルパー）
  return calcLegalCarryOver({ prevGrant, prevCarry, prevAdj, prevBuyout, periodUsed })
}

/**
 * 付与期間を内包するのに必要な月群（YYYYMM）を返す
 *
 * 2026-08-27 修正（有給総点検・第3回）: 2年 → 3年に拡大。
 *   時効処理は付与から2年後に走るため、「今年−2年の1月」始まりだと
 *   12月付与のレコード（例: 2024-12-15 付与を 2027-01 に処理）の
 *   付与月の消化を取りこぼし、失効日数が過大に記録されていた。
 *   本関数は手動の管理アクション（時効処理・半自動付与）でのみ使われるため
 *   読み取り増（+12 doc）は許容範囲。
 */
function relevantAttMonths(): string[] {
  const now = new Date()
  const y = now.getFullYear()
  const out: string[] = []
  for (let yy = y - 3; yy <= y; yy++) {
    for (let mm = 1; mm <= 12; mm++) out.push(ymKey(yy, mm))
  }
  return out
}

// 2026-06-XX 修正 (MI-1): calcLegalPL は lib/leave-compute.ts に統合済み
//   旧: ここに重複実装があった → leave-auto.ts と微妙にズレるリスク
//   新: 共通ヘルパーから import

export async function POST(request: NextRequest) {
  const authResult = await getApiAuthUser(request)
  if (!authResult.authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = authResult.actor  // number | 'admin' | 'super-admin'
  // 2026-08-27 追加（有給総点検・第3回）: 本ルートの POST は全て管理アクション
  //   （付与・時季指定・買取・時効処理・レコード編集）。管理者・事業責任者のみに制限する。
  //   旧実装は「誰のパスワードでも可」で、個人パスワードを持つ職長が自分に付与→
  //   時季指定で出面に p を書くまで一人で完結できた（承認フロー原則違反）。
  //   revoke（leave-request 側）と同一基準。
  if (!(actor === 'admin' || actor === 'super-admin' || actor === 1)) {
    return NextResponse.json({ error: '有給の管理操作は管理者・事業責任者のみ実行できます' }, { status: 403 })
  }
  try {
    const body = await request.json()
    const { action } = body

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // 現在時刻 (ISO) と 操作者識別子
    const nowIso = new Date().toISOString()

    // 本日のJST日付を YYYY-MM-DD で返す（Vercelサーバーは UTC のため補正）
    const todayJST = () => {
      const now = new Date()
      const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
      return jst.toISOString().slice(0, 10)
    }

    if (action === 'recordBuyout') {
      // Phase 6: 買取記録（日本人期末買取 or 退職時清算）
      const { workerId, fy, days, amount, reason, at } = body as {
        workerId: number
        fy: string
        days: number
        amount?: number
        reason?: 'year-end' | 'retirement' | 'other'
        at?: string  // ISO date (optional, default: today)
      }
      if (!workerId || !fy || !days || days < 0) {
        return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 })
      }

      const data = snap.data()
      const plData = (data.plData || {}) as Record<string, Record<string, unknown>[]>
      const wRecords = plData[String(workerId)] || []
      const idx = wRecords.findIndex(r => String(r.fy) === String(fy))
      if (idx < 0) {
        return NextResponse.json({ error: 'Record not found for this fy' }, { status: 404 })
      }

      const rec = wRecords[idx]
      // 買取記録を追加 (累積可能にする: buyoutHistory 配列で管理)
      type BuyoutEntry = { at: string; by: number | string; days: number; amount?: number; reason?: string }
      const history = (rec.buyoutHistory as BuyoutEntry[] | undefined) ?? []
      history.push({
        at: at || nowIso,
        by: actor,
        days,
        amount,
        reason,
      })
      rec.buyoutHistory = history
      // 累計買取日数を `buyoutDays` に更新（最新の集計値）
      const totalBuyout = history.reduce((sum, h) => sum + h.days, 0)
      rec.buyoutDays = totalBuyout
      rec.lastEditedAt = nowIso
      rec.lastEditedBy = actor

      // race-fix: dot-notation で 1 worker 単位に局所化（他 worker の plData と衝突しない）
      await updateDoc(docRef, { [`plData.${String(workerId)}`]: wRecords })
      await logActivity('admin', 'leave.buyout', `workerId=${workerId} FY${fy} 買取 ${days}日${amount ? ` ¥${amount}` : ''}（操作者: ${actor}）`)
      return NextResponse.json({ success: true, totalBuyout })
    }

    if (action === 'designateLeaves') {
      // Phase 5: 時季指定（年5日取得義務）または管理者による手動P入力
      // 管理者が指定日に P を自動入力し、PLRecord の designatedLeaves に履歴記録
      const { workerId, dates, siteId, note, overwriteHomeLeave, kind } = body as {
        workerId: number
        dates: string[]          // ["2026-05-01", "2026-05-02", ...]
        siteId: string           // 出面書き込み先の現場ID
        note?: string
        overwriteHomeLeave?: boolean  // 帰国マーカー(hk)を削除してPに置き換えるか
        kind?: 'designation' | 'manual-entry'  // 時季指定 or 管理者手動入力 (区別用)
      }
      if (!workerId || !Array.isArray(dates) || dates.length === 0 || !siteId) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      const data = snap.data()
      const plData = (data.plData || {}) as Record<string, Record<string, unknown>[]>
      const wRecords = plData[String(workerId)] || []

      // 対象FYレコード: 「今日時点で有効な」付与レコード（2026-08-04 修正）
      //   旧: grantDate 最大 = 先に作られた未来の付与レコードを掴み、履歴がそちらに残る
      //   （残数チェックが未来枠を見ていたトゥアン事案と同型のバグ）
      const activeRec = selectActiveGrantRecord(
        wRecords as { grantDate?: string; grantDays?: number; grant?: number; _archived?: boolean }[],
        todayJST(),
      )
      const targetRec = (activeRec as Record<string, unknown> | null)
        ?? wRecords.filter(r => r.grantDate && ((r.grantDays as number | undefined) ?? 0) > 0).slice(-1)[0]
      if (!targetRec) {
        return NextResponse.json({ error: 'No granted record found for worker' }, { status: 404 })
      }

      // ── 有給残数チェック（2026-08-04 追加 / トゥアン事案の横展開）──
      //   この経路（時季指定・管理者手動入力）はこれまで残数を一切見ておらず、
      //   4月の9日連続入力のような枠超過の主要経路だった。
      //   残数 < 入力日数 は既定で拒否。前借り等の意図的な超過は
      //   allowOverdraft:true を明示した場合のみ通し、activityLog に必ず残す。
      {
        const { getLeaveBalance } = await import('@/lib/leave-balance')
        const bal = await getLeaveBalance(Number(workerId))
        if (bal.remaining < dates.length && body.allowOverdraft !== true) {
          const wName = (data.workers as { id: number; name?: string }[] | undefined)
            ?.find(w => w.id === Number(workerId))?.name || `ID:${workerId}`
          return NextResponse.json({
            error: bal.noGrant
              ? `${wName} さんは有給が付与されていません（付与レコードなし）`
              : `${wName} さんの有給残は ${bal.remaining}日 です（枠 ${bal.total}日 / 消化 ${bal.used}日）。${dates.length}日 は登録できません`,
            code: 'LEAVE_OVERDRAFT',
            balance: bal,
            requestedDays: dates.length,
          }, { status: 409 })
        }
        if (bal.remaining < dates.length && body.allowOverdraft === true) {
          const wName = (data.workers as { id: number; name?: string }[] | undefined)
            ?.find(w => w.id === Number(workerId))?.name || `ID:${workerId}`
          await logActivity('admin', 'leave.overdraft',
            `${wName} 有給${dates.length}日を残数超過で登録（残 ${bal.remaining}日 / 枠 ${bal.total}日、操作者: ${actor}）`)
        }
      }

      // 出面に P を書き込み
      type DesignatedEntry = { date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string; kind?: string; overwroteHomeLeave?: boolean }
      const history = (targetRec.designatedLeaves as DesignatedEntry[] | undefined) ?? []
      const written: string[] = []

      // 2026-08-27 修正（有給総点検・第3回）: 残骸掃除を追加。
      //   既に出勤入力がある日を時季指定で有給化すると残業(o)・時刻(st/et)等が
      //   残っていた（承認経路と同じ deleteFields 方式に統一）。
      //   帰国期間の上書きが必要な場合は hk も削除対象（computeAttendanceDeleteFields は
      //   entry に無い既知フィールドを全て挙げるので hk も自動的に含まれる）
      const desigEntry = { w: 0, p: 1 }
      const desigDelete = computeAttendanceDeleteFields(desigEntry)
      const setOptions = { deleteFields: overwriteHomeLeave ? desigDelete : desigDelete.filter(f => f !== 'hk') }

      // 2026-06-12 (監査 Sprint2-B): 時季指定・管理者手動入力にも request と同じガードを適用
      //   ① ロック済み月は拒否（給与確定後のデータ変更防止）
      //   ② カレンダー非稼働日への P は拒否（有給日給の過払い防止）
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const { isScheduledWorkDay } = await import('@/lib/attendance')
        const wOrgRec = (data.workers as { id: number; org?: string }[] | undefined)?.find(w => w.id === Number(workerId))
        for (const dateStr of dates) {
          const d0 = new Date(dateStr)
          if (isNaN(d0.getTime())) continue
          const ymCheck = ymKey(d0.getFullYear(), d0.getMonth() + 1)
          const lockErr = await checkMonthLocked(ymCheck, wOrgRec?.org)
          if (lockErr) return NextResponse.json({ error: `${dateStr}: ${lockErr}` }, { status: 409 })
          if (!await isScheduledWorkDay(siteId, dateStr)) {
            return NextResponse.json({ error: `${dateStr} は出勤予定日ではないため有給にできません（休日・所定休は対象外）` }, { status: 400 })
          }
        }
      }

      for (const dateStr of dates) {
        const d = new Date(dateStr)
        if (isNaN(d.getTime())) continue
        const ym = ymKey(d.getFullYear(), d.getMonth() + 1)
        const day = d.getDate()
        // 出面書き込み: { w: 0, p: 1 } (overwriteHomeLeave時はhkを削除)
        await setAttendanceEntry(siteId, workerId, ym, day, desigEntry, setOptions)
        history.push({
          date: dateStr,
          designatedAt: nowIso,
          designatedBy: actor,
          note,
          siteId,
          kind: kind || 'designation',
          overwroteHomeLeave: overwriteHomeLeave === true,
        })
        written.push(dateStr)
      }

      targetRec.designatedLeaves = history
      targetRec.lastEditedAt = nowIso
      targetRec.lastEditedBy = actor

      // race-fix: dot-notation で 1 worker 単位に局所化（他 worker の plData と衝突しない）
      await updateDoc(docRef, { [`plData.${String(workerId)}`]: wRecords })
      await logActivity('admin', 'leave.designate', `workerId=${workerId} に有給P入力 ${written.length}日 (${written.join(', ')})（操作者: ${actor}）`)
      return NextResponse.json({ success: true, written })
    }

    if (action === 'processExpiry') {
      // Phase 3: 時効（2年）処理を実行
      // grantDate + 2年 - 1日 < today のレコードで、まだ失効処理されていないものに
      // expiredDays / expiredAt / expiredBy / _archived を記録する
      const data = snap.data()
      const plData = (data.plData || {}) as Record<string, Record<string, unknown>[]>
      const today = todayJST()

      // 出面データをロード（残日数計算用）
      const allAtt: Record<string, Record<string, unknown>> = {}
      Object.assign(allAtt, (await getMultiMonthAttData(relevantAttMonths())).d)  // 並列読み（性能改善 2026-07-09）

      const expiredList: { workerId: number; workerName: string; fy: string; grantDate: string; expiredDays: number }[] = []
      const workersArr = (data.workers || []) as { id: number; name: string }[]
      const nameOf = (wid: number) => workersArr.find(w => w.id === wid)?.name || `id=${wid}`

      for (const [wid, records] of Object.entries(plData)) {
        const workerId = Number(wid)
        for (const r of records) {
          // 既に処理済みはスキップ
          if (r._archived || r.expiredAt) continue
          if (!r.grantDate) continue
          // 有効期限判定は isLeaveExpiredAsOf に統一（民法143条2項・うるう年対応）
          if (!isLeaveExpiredAsOf(r.grantDate as string, today)) continue  // まだ期限内

          // 期限切れ → 残日数計算
          // 2026-06-XX 修正 (audit #5+#6): computeUsedDays / computeRemainingDays に統一
          //   旧: expiredDays = grantDays + carryOver - adjustment - buyoutDays - periodUsed
          //   新: computeRemainingDays(total, rec, periodUsed) で画面表示と式統一
          //   両者は数学的に等価だが、ヘルパー経由にすることで定義の食い違いを構造的に防ぐ
          const grantDays = (r.grantDays as number | undefined) ?? 0
          const carryOver = (r.carryOver as number | undefined) ?? 0
          const periodStart = new Date(r.grantDate as string)
          const periodEnd = new Date(periodStart)
          periodEnd.setFullYear(periodEnd.getFullYear() + 1)
          // 多現場の同日重複を排除して1日1カウントに正規化
          const seenDatesExpiry = new Set<string>()
          let periodUsed = 0
          for (const [key, entry] of Object.entries(allAtt)) {
            if (!entry) continue
            const e = entry as { p?: number | boolean }
            if (!e.p) continue
            const pk = parseDKey(key)
            if (parseInt(pk.wid) !== workerId) continue
            const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
            if (d < periodStart || d >= periodEnd) continue
            const dk = `${pk.ym}_${pk.day}`
            if (seenDatesExpiry.has(dk)) continue
            seenDatesExpiry.add(dk)
            periodUsed++
          }
          // 2026-08-27 修正（有給総点検・第3回）: 次期へ繰り越した分を失効に数えない。
          //   繰越は残数を次期レコードへ移す処理なので、次期の carryOver を
          //   差し引かないと繰越分が「失効」として二重記録され、台帳の
          //   失効日数列が過大になっていた（残数計算は正しく、記録のみの問題）
          const nextRec = records
            .filter(x => x !== r && typeof x.grantDate === 'string' && (x.grantDate as string) > (r.grantDate as string))
            .sort((a, b) => String(a.grantDate).localeCompare(String(b.grantDate)))[0]
          const carriedOut = nextRec
            ? ((nextRec.carryOver as number | undefined) ?? (nextRec.carry as number | undefined) ?? 0)
            : 0
          const expiredDays = Math.max(0, computeRemainingDays(
            grantDays + carryOver,
            r as Parameters<typeof computeUsedDays>[0],
            periodUsed,
          ) - carriedOut)

          r.expiredDays = expiredDays
          r.expiredAt = nowIso
          r.expiredBy = actor
          r._archived = true

          expiredList.push({
            workerId,
            workerName: nameOf(workerId),
            fy: String(r.fy ?? ''),
            grantDate: r.grantDate as string,
            expiredDays,
          })
        }
      }

      // race-warning: 同時実行は要注意（全 worker の plData を一括書き換えるため、
      //   他の編集 action と並行実行すると後勝ちで上書きが発生し得る。実行ロックを推奨）
      // 2026-06-XX 修正 (CR-5): dot-notation で worker 単位更新（plData={} 罠を回避）
      await updateMapByKey(docRef, 'plData', plData)
      // 2026-06-XX 追加: 健全性チェック用に最終実行時刻を記録
      try {
        const sysRef = doc(db, 'demmen', 'system')
        await setDoc(sysRef, { lastExpiryRun: new Date().toISOString() }, { merge: true })
      } catch (sysErr) {
        console.warn('[processExpiry] lastExpiryRun 記録失敗:', sysErr)
      }
      return NextResponse.json({
        success: true,
        processed: expiredList.length,
        expired: expiredList,
      })
    }

    if (action === 'migrate') {
      // Phase 1 データ正規化マイグレーション
      // 冪等な処理 — 何度実行しても結果は同じ
      // body.autoFixMismatches: true で、fy と grantDate の年ズレを自動修正
      //   (fy を grantDate の年に合わせる。grantDate を認定データとして扱う)
      const autoFixMismatches = body.autoFixMismatches === true
      const data = snap.data()
      // 2026-06-XX 修正: retired は YYYY-MM-DD 文字列であり boolean ではない
      //   旧型宣言だと「未来日の退職予定が入った瞬間に対象から消える」バグの温床になる
      type Worker = { id: number; name: string; retired?: string; job?: string; visa?: string; hireDate?: string }
      type PLRecFull = {
        fy: string | number
        grantDate?: string
        grantDays?: number
        carryOver?: number
        adjustment?: number
        used?: number
        expiry?: string
        _archived?: boolean
        grant?: number
        carry?: number
        adj?: number
      }
      const workers = (data.workers || []) as Worker[]
      const plData = (data.plData || {}) as Record<string, PLRecFull[]>
      const today = todayJST()

      const stats = {
        workersProcessed: 0,
        recordsProcessed: 0,
        legacyFieldsUpgraded: 0,
        fyNormalized: 0,
        grantDatesInferred: 0,
        duplicatesMerged: 0,
        recordsArchived: 0,
        mismatches: [] as { workerId: number; name: string; fy: string; grantDate: string; note: string }[],
        warnings: [] as { workerId: number; name: string; note: string }[],
      }

      for (const [wid, origRecords] of Object.entries(plData)) {
        const workerId = Number(wid)
        const worker = workers.find(w => w.id === workerId)
        const workerName = worker?.name || `id=${wid}`
        const isJp = !worker?.visa || worker.visa === 'none'
        let records = [...origRecords] as PLRecFull[]
        stats.workersProcessed++
        stats.recordsProcessed += records.length

        // STEP 1: 旧フィールド昇格 & fy正規化
        records = records.map(r => {
          const clean = { ...r } as Record<string, unknown>
          let upgraded = false
          if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
            clean.grantDays = clean.grant
            upgraded = true
          }
          if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
            clean.carryOver = clean.carry
            upgraded = true
          }
          if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
            clean.adjustment = clean.adj
            upgraded = true
          }
          if (clean.grant !== undefined || clean.carry !== undefined || clean.adj !== undefined) {
            delete clean.grant
            delete clean.carry
            delete clean.adj
          }
          if (upgraded) stats.legacyFieldsUpgraded++
          // fy正規化
          if (clean.fy !== undefined && typeof clean.fy !== 'string') {
            clean.fy = String(clean.fy)
            stats.fyNormalized++
          }
          return clean as PLRecFull
        })

        // STEP 2: grantDate欠落の補完
        //   日本人: fy があれば ${fy}-10-01 を補完
        //   外国人: 同一fyの他レコードにgrantDateがあれば採用、なければwarning
        for (let i = 0; i < records.length; i++) {
          const r = records[i]
          if (r.grantDate) continue
          if (!(r.grantDays && r.grantDays > 0)) continue  // 空データは補完せずスキップ
          const fyStr = String(r.fy || '')
          if (!fyStr) {
            stats.warnings.push({ workerId, name: workerName, note: 'grantDate/fyともに欠落したレコードあり (補完不可)' })
            continue
          }
          if (isJp) {
            r.grantDate = `${fyStr}-10-01`
            stats.grantDatesInferred++
          } else {
            // 外国人: 他の同一fyレコードから補完可能か
            const sibling = records.find(x => String(x.fy) === fyStr && x.grantDate)
            if (sibling && sibling.grantDate) {
              r.grantDate = sibling.grantDate
              stats.grantDatesInferred++
            } else {
              stats.warnings.push({ workerId, name: workerName, note: `外国人 fy=${fyStr} のgrantDate欠落 (推定不可、管理画面で設定が必要)` })
            }
          }
        }

        // STEP 3: 同一fyの重複集約
        //   戦略: 最新の grantDate を持つレコードを「真」とし、古い重複は捨てる
        //   (古いレコードから max値をマージすると、legacy値の混入で二重計上が発生する)
        const fyGroups = new Map<string, PLRecFull[]>()
        for (const r of records) {
          const k = String(r.fy ?? '')
          if (!fyGroups.has(k)) fyGroups.set(k, [])
          fyGroups.get(k)!.push(r)
        }
        const merged: PLRecFull[] = []
        for (const [, group] of fyGroups) {
          if (group.length === 1) {
            merged.push(group[0])
            continue
          }
          stats.duplicatesMerged += group.length - 1
          // 並び順の優先度:
          //  1. grantDays > 0 を優先（空データより本物のレコードを選ぶ）
          //  2. grantDate が新しい方を優先（最新の編集を「真」とする）
          //  3. grantDays が大きい方を優先（タイブレイク）
          const sorted = group.slice().sort((a, b) => {
            const gdA = a.grantDays ?? 0
            const gdB = b.grantDays ?? 0
            if ((gdA > 0) !== (gdB > 0)) return gdB - gdA
            const dateA = a.grantDate ? new Date(a.grantDate).getTime() : 0
            const dateB = b.grantDate ? new Date(b.grantDate).getTime() : 0
            if (dateB !== dateA) return dateB - dateA
            return gdB - gdA
          })
          merged.push(sorted[0])  // 他のレコードは捨てる (最新のものが真)
        }
        records = merged

        // STEP 4: fy と grantDate の年ズレ検出・修正
        for (const r of records) {
          if (!r.grantDate) continue
          const gdYear = r.grantDate.slice(0, 4)
          const fyStr = String(r.fy ?? '')
          if (!fyStr) continue
          if (gdYear !== fyStr) {
            stats.mismatches.push({ workerId, name: workerName, fy: fyStr, grantDate: r.grantDate, note: `fy=${fyStr} だがgrantDate=${r.grantDate}${autoFixMismatches ? ' → fy=' + gdYear + 'に自動修正' : ''}` })
            if (autoFixMismatches) {
              r.fy = gdYear
            }
          }
        }

        // STEP 4.5: fy修正後に再度重複が発生していないかチェック・集約
        if (autoFixMismatches) {
          const fyGroups2 = new Map<string, PLRecFull[]>()
          for (const r of records) {
            const k = String(r.fy ?? '')
            if (!fyGroups2.has(k)) fyGroups2.set(k, [])
            fyGroups2.get(k)!.push(r)
          }
          const merged2: PLRecFull[] = []
          for (const [, group] of fyGroups2) {
            if (group.length === 1) {
              merged2.push(group[0])
              continue
            }
            stats.duplicatesMerged += group.length - 1
            const sorted = group.slice().sort((a, b) => {
              const gdA = a.grantDays ?? 0
              const gdB = b.grantDays ?? 0
              if ((gdA > 0) !== (gdB > 0)) return gdB - gdA
              const dateA = a.grantDate ? new Date(a.grantDate).getTime() : 0
              const dateB = b.grantDate ? new Date(b.grantDate).getTime() : 0
              if (dateB !== dateA) return dateB - dateA
              return gdB - gdA
            })
            merged2.push(sorted[0])
          }
          records = merged2
        }

        // STEP 5: 期限切れレコードのアーカイブ
        //   grantDate+2年 < today なら _archived: true
        //   表示ロジックは _archived を除外
        for (const r of records) {
          if (r._archived) continue
          if (!r.grantDate) continue
          if (isLeaveExpiredAsOf(r.grantDate, today)) {
            r._archived = true
            stats.recordsArchived++
          }
        }

        // STEP 6: method が未設定なレコードに 'legacy' を付与（監査用）
        for (const r of records) {
          const rr = r as Record<string, unknown>
          if (rr.method === undefined) {
            rr.method = 'legacy'
          }
        }

        plData[wid] = records
      }

      // race-warning: 同時実行は要注意（全 worker の plData を一括書き換えるため、
      //   他の編集 action と並行実行すると後勝ちで上書きが発生し得る。実行ロックを推奨）
      // 2026-06-XX 修正 (CR-5): dot-notation で worker 単位更新（plData={} 罠を回避）
      await updateMapByKey(docRef, 'plData', plData)
      return NextResponse.json({ success: true, stats })
    }

    if (action === 'getPendingGrants') {
      // 付与時期を迎えているが未付与のワーカー一覧を返す（半自動付与用）
      const data = snap.data()
      // 2026-06-XX 修正: retired は YYYY-MM-DD 文字列
      type Worker = { id: number; name: string; retired?: string; job?: string; visa?: string; hireDate?: string }
      type PLRecord = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
      const workers = (data.workers || []) as Worker[]
      const plData = (data.plData || {}) as Record<string, PLRecord[]>

      const today = todayJST()
      const todayDate = new Date(today)

      // アラート表示の事前通知ウィンドウ: 付与日の 30日前 から通知開始
      //   (旧: 付与日が来てから通知 → 直前まで気付かない問題があった)
      const ALERT_LEAD_DAYS = 30
      const isWithinAlertWindow = (grantDateStr: string): boolean => {
        const grant = new Date(grantDateStr)
        if (isNaN(grant.getTime())) return false
        const alertStart = new Date(grant)
        alertStart.setDate(alertStart.getDate() - ALERT_LEAD_DAYS)
        const alertStartStr = alertStart.toISOString().slice(0, 10)
        return alertStartStr <= today
      }

      // 入社日 + 6ヶ月の日付文字列 (YYYY-MM-DD) を返す。空文字なら null。
      // 労基法上、初回付与は必ず入社から6ヶ月以上経過後 (39条1項)
      // 2026-06-XX 修正 (IM-1): addMonthsSafe で月末入社バグを解消
      //   旧: setMonth(+6) で 2025-08-31 → 2026-03-03（誤、3月に繰越）
      //   新: 行政解釈準拠 → 2026-02-28（応当日がなければ前月末日）
      const hirePlus6Months = (hireDate: string): string | null => {
        if (!hireDate) return null
        const safe = addMonthsSafe(hireDate, 6)
        return safe || null
      }

      type PendingGrant = {
        workerId: number
        name: string
        visa: string
        hireDate: string
        tenureText: string
        nextGrantDate: string
        fy: string
        legalDays: number
        reason: string
        needsAttention: boolean  // hireDate未登録など、手動確認が必要なフラグ
        attentionNote?: string
      }
      const pending: PendingGrant[] = []

      // 在籍月数テキスト
      const tenureTextOf = (hireDate: string, at: string): string => {
        if (!hireDate) return '入社日未登録'
        const h = new Date(hireDate)
        const a = new Date(at)
        if (isNaN(h.getTime()) || isNaN(a.getTime())) return '入社日未登録'
        let months = (a.getFullYear() - h.getFullYear()) * 12 + (a.getMonth() - h.getMonth())
        if (a.getDate() < h.getDate()) months -= 1
        if (months < 0) return '入社前'
        const y = Math.floor(months / 12)
        const m = months % 12
        if (y === 0) return `在籍 ${m}ヶ月`
        if (m === 0) return `在籍 ${y}年`
        return `在籍 ${y}年${m}ヶ月`
      }

      // 「付与判定」: 以下のいずれかで「付与済み」とみなす
      //   (a) 既存レコードの付与期間と重なる（grantPeriodsOverlap）→ 通常パターン
      //   (b) grantDateが欠落していても fy が一致する → 「本田文人」のような移行期データに対応
      // 2026-08-04 修正（新規付与まわりの点検）: (a) は旧「±7日近傍」から期間重複判定に変更。
      //   年途中入社の日本人は初回付与（入社+6ヶ月）が 10/1 統一起点とズレるため、
      //   初回付与直後に「10/1 の付与が未実施」と誤検知し、実行すると期間の重なる
      //   二重付与になっていた（例: 濱上さん 入社2026-06-01 → 初回12/1 の直後に10/1分を誤付与）。
      //   期間が重なる限り付与済み扱いにし、統一起点への合流は前期間の満了後に行う。
      const hasGrantForExpected = (records: PLRecord[], expectedFy: string, expectedGrantDate: string): boolean => {
        return records.some(r => {
          if (!((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0)) return false
          if (r.grantDate) {
            return grantPeriodsOverlap(r.grantDate, expectedGrantDate)
          }
          // grantDate 欠落 → fy一致で判定
          return String(r.fy) === expectedFy
        })
      }

      for (const w of workers) {
        // 2026-06-XX 修正: 「今日時点で退職済み」のみ除外（未来日退職予定者は通知対象）
        if (isAlreadyRetired(w.retired, today)) continue
        if (w.job === 'yakuin' || w.job === 'jimu') continue

        const records = plData[String(w.id)] || []
        const isJp = !w.visa || w.visa === 'none'

        if (isJp) {
          // 日本人: 10/1 起点だが、入社が直近の場合は hireDate + 6ヶ月を初回付与日とする
          //   (労基法 39条1項: 初回付与は入社から6ヶ月経過後)
          //   - 例: 入社 6/1 → hire+6m = 12/1 → 次の 10/1 (来年) より前 → 初回は 12/1
          //   - 例: 入社 1/1 → hire+6m = 7/1 → 同年 10/1 より前 → 同年 10/1 でOK
          //   - 例: 入社 5/1 (3年前)など → 既に複数年経過なら 10/1 起点で OK
          const y = todayDate.getFullYear()
          const m = todayDate.getMonth() + 1
          const currentFyStart = m >= 10 ? y : y - 1
          const fyGrantDate = `${currentFyStart}-10-01`
          const hirePlus6 = w.hireDate ? hirePlus6Months(w.hireDate) : null

          // 初回付与かどうかの判定: 過去に付与レコードが一切なければ初回。
          //   2回目以降は「前回付与日」から次の付与日を導出する（fy一致判定は使わない）
          const effGrantDate = (r: PLRecord): string =>
            r.grantDate || (r.fy !== undefined && r.fy !== null ? `${r.fy}-10-01` : '')
          const latestGrant = records
            .filter(r => (r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0)
            .map(effGrantDate).filter(Boolean).sort().slice(-1)[0] || null

          let expectedGrantDate: string
          let expectedFy: string
          let reason: string
          // 前倒し合流時の法定日数計算に使う「みなし勤続」基準日（通常は付与日そのもの）
          let deemedDateForDays: string

          if (!latestGrant) {
            if (hirePlus6 && hirePlus6 > fyGrantDate) {
              // 初回付与で、入社+6ヶ月が FY 起点より遅い → 入社+6ヶ月を採用
              expectedGrantDate = hirePlus6
              expectedFy = expectedGrantDate.slice(0, 4)
              reason = '初回付与（入社6ヶ月経過）'
            } else {
              expectedGrantDate = fyGrantDate
              expectedFy = String(currentFyStart)
              reason = `FY ${expectedFy} (${expectedGrantDate}~)の付与が未実施`
            }
            deemedDateForDays = expectedGrantDate
          } else {
            // ── 2回目以降: 前回付与日の後の最初の 10/1 へ「前倒し合流」──
            // 2026-08-27 修正（有給総点検・第3回）:
            //   旧実装は現FYの10/1 と前回付与期間の「重複」で抑止していたため、
            //   年途中入社の日本人は次回付与が最大22ヶ月後になっていた。
            //   労基法39条は継続勤務1年ごとの付与を要求し、基準日の統一は
            //   **前倒しのみ**許される（後ろ倒しは法定割れ）。
            //   例: 初回 2026-12-01 → 次回は 2027-10-01（2ヶ月前倒しで統一基準日へ合流）
            //   前倒し分の勤続は本来の応当日まで勤続したものとみなす（斉一的取扱い）
            //   ため、法定日数は max(合流日, 前回+1年) 時点の勤続で計算する。
            const next = jpNextGrantAfter(latestGrant)
            expectedGrantDate = next.grantDate
            expectedFy = expectedGrantDate.slice(0, 4)
            deemedDateForDays = next.deemedDate
            reason = latestGrant.slice(5) === '10-01'
              ? `FY ${expectedFy} (${expectedGrantDate}~)の付与が未実施`
              : `統一基準日へ前倒し合流（前回付与 ${latestGrant}）`
          }

          // アラートウィンドウ (付与日の30日前～) かつ未付与なら対象に。
          //   「未付与」= expectedGrantDate 以降の付与レコードが無いこと
          //   （latestGrant < expectedGrantDate は構成上保証されるので実質ウィンドウ判定のみ）
          const alreadyGranted = records.some(r =>
            ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0) && effGrantDate(r) >= expectedGrantDate)
          if (isWithinAlertWindow(expectedGrantDate) && !alreadyGranted) {
            const hasHire = !!w.hireDate
            const legalDays = hasHire ? calcLegalPL(w.hireDate!, deemedDateForDays) : 10
            pending.push({
              workerId: w.id,
              name: w.name,
              visa: w.visa || 'none',
              hireDate: w.hireDate || '',
              tenureText: tenureTextOf(w.hireDate || '', expectedGrantDate),
              nextGrantDate: expectedGrantDate,
              fy: expectedFy,
              legalDays,
              reason,
              needsAttention: !hasHire,
              attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
            })
          }
        } else {
          // 外国人: 最新 grantDate + 1年
          const withGrant = records
            .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
            .slice()
            .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
          const lastRec = withGrant[withGrant.length - 1]

          if (!lastRec) {
            // 初回付与候補: hireDate + 6ヶ月、ただし30日前から事前通知
            if (w.hireDate) {
              const firstGrantStr = hirePlus6Months(w.hireDate)
              if (firstGrantStr && isWithinAlertWindow(firstGrantStr)) {
                const legalDays = calcLegalPL(w.hireDate, firstGrantStr)
                pending.push({
                  workerId: w.id,
                  name: w.name,
                  visa: w.visa || '',
                  hireDate: w.hireDate,
                  tenureText: tenureTextOf(w.hireDate, firstGrantStr),
                  nextGrantDate: firstGrantStr,
                  fy: firstGrantStr.slice(0, 4),
                  legalDays,
                  reason: '初回付与（入社6ヶ月経過）',
                  needsAttention: false,
                })
              }
            }
            continue
          }

          const lastGrant = new Date(lastRec.grantDate!)
          if (isNaN(lastGrant.getTime())) continue
          const nextGrant = new Date(lastGrant)
          nextGrant.setFullYear(nextGrant.getFullYear() + 1)
          const nextGrantStr = nextGrant.toISOString().slice(0, 10)

          const nextFyForCheck = String(nextGrant.getFullYear())
          // アラートウィンドウ (付与日の30日前～) かつ未付与なら対象に
          if (isWithinAlertWindow(nextGrantStr) && !hasGrantForExpected(records, nextFyForCheck, nextGrantStr)) {
            const nextFy = nextFyForCheck
            const hasHire = !!w.hireDate
            const legalDays = hasHire ? calcLegalPL(w.hireDate!, nextGrantStr) : 10
            pending.push({
              workerId: w.id,
              name: w.name,
              visa: w.visa || '',
              hireDate: w.hireDate || '',
              tenureText: tenureTextOf(w.hireDate || '', nextGrantStr),
              nextGrantDate: nextGrantStr,
              fy: nextFy,
              legalDays,
              reason: `前回付与(${lastRec.grantDate})から1年経過`,
              needsAttention: !hasHire,
              attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
            })
          }
        }
      }

      return NextResponse.json({ pending })
    }

    if (action === 'executePendingGrants') {
      // 一括付与実行
      const { grants } = body as {
        grants: { workerId: number; fy: string; grantDate: string; grantDays: number }[]
      }
      if (!Array.isArray(grants) || grants.length === 0) {
        return NextResponse.json({ error: 'No grants to execute' }, { status: 400 })
      }

      const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays?: number; carryOver?: number; adjustment?: number; grant?: number; carry?: number; adj?: number }[]>
      const workersArr = ((snap.data().workers || []) as { id: number; name?: string; visa?: string; hireDate?: string }[])
      const isJpOf = (id: number) => {
        const w = workersArr.find(x => x.id === id)
        return !w?.visa || w.visa === 'none'
      }

      // ── 入力値バリデーション（2026-08-04 追加 / 新規付与まわりの点検）──
      //   半自動付与モーダルは付与日数を自由に編集できるのに、サーバ側は
      //   grantDays を素通ししていた。法定超（勤続年数に対する法定・上限20日）を弾く。
      //   1件でも不正があれば全体を拒否する（部分実行は「どれが付与されたか」の混乱を生む）。
      for (const g of grants) {
        const w = workersArr.find(x => x.id === g.workerId)
        const v = validateGrantInput({
          grantDays: Number(g.grantDays) || 0,
          hireDate: w?.hireDate,
          grantDate: g.grantDate || undefined,
        })
        if (!v.ok) {
          return NextResponse.json({
            error: `${w?.name || `ID:${g.workerId}`}: ${v.error}`,
          }, { status: 400 })
        }
      }

      // 期間の重なる既存付与があるかチェック（二重付与防止用）
      // 2026-06-XX 修正 (IM-12): ±7日 だけだと別日付の連打で同FY二重付与を防げない
      // 2026-08-04 修正（新規付与まわりの点検）: isSameFiscalYear は一方向判定のため、
      //   「既存の付与日より前へ遡る付与」（期間が重なる）を止められなかった。
      //   grantPeriodsOverlap（双方向の期間重複）に統一。ちょうど1年後の通常サイクルは重ならない。
      type PLRec = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
      // 2026-08-27 修正（有給総点検・第3回）: 期間重複での判定をやめ、
      //   「targetDate 以降（同日含む）の付与が既にあるか」で判定する。
      //   前倒し合流（例: 初回12/1 → 翌10/1）は前回期間と重なるのが正常であり、
      //   旧判定だとこの正当な付与まで弾いて法定割れ（付与ギャップ）を招いていた。
      //   過去へ遡る付与・同日の再実行は「既存付与 >= target」で従来どおり弾ける。
      const hasGrantNear = (records: PLRec[], targetDate: string): boolean => {
        if (!targetDate) return false
        return records.some(r => {
          if (!((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0)) return false
          const d = r.grantDate || (r.fy !== undefined && r.fy !== null ? `${r.fy}-10-01` : '')
          return !!d && d >= targetDate
        })
      }

      // 外国人の繰越計算用: 出面データを事前に一括ロード
      const needsAttLoad = grants.some(g => !isJpOf(g.workerId))
      const allAtt: Record<string, Record<string, unknown>> = {}
      if (needsAttLoad) {
        const months = relevantAttMonths()
        Object.assign(allAtt, (await getMultiMonthAttData(months)).d)  // 並列読み（性能改善 2026-07-09）
      }

      let granted = 0
      for (const g of grants) {
        const key = String(g.workerId)
        let records = plData[key] || []

        // 旧互換フィールドのクリーンアップ & fy正規化
        records = records.map(r => {
          const clean = { ...r } as Record<string, unknown>
          if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) clean.grantDays = clean.grant
          if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) clean.carryOver = clean.carry
          if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) clean.adjustment = clean.adj
          delete clean.grant
          delete clean.carry
          delete clean.adj
          if (clean.fy !== undefined) clean.fy = String(clean.fy)
          return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
        })

        // 「付与日近傍」に既存レコードがあればスキップ（真の二重付与防止）
        if (hasGrantNear(records, g.grantDate)) {
          plData[key] = records
          continue
        }

        // 繰越を前期残日数から自動計算（外国人のみ）
        const carryOverVal = calcCarryOverForWorker(
          g.workerId,
          g.grantDate,
          records,
          allAtt,
          isJpOf(g.workerId),
        )

        const newRec = {
          fy: String(g.fy),
          grantDate: g.grantDate,
          grantDays: Number(g.grantDays) || 0,
          carryOver: carryOverVal,
          adjustment: 0,
          used: 0,
          // 監査情報
          grantedAt: nowIso,
          grantedBy: actor,
          method: 'auto-pending' as const,
        }
        records.push(newRec)
        plData[key] = records
        granted++
      }

      // race-warning: 同時実行は要注意（複数 worker の plData を一括書き換えるため、
      //   他の編集 action と並行実行すると後勝ちで上書きが発生し得る。実行ロックを推奨）
      // 2026-06-XX 修正 (CR-5): dot-notation で worker 単位更新（plData={} 罠を回避）
      await updateMapByKey(docRef, 'plData', plData)
      return NextResponse.json({ success: true, granted })
    }

    if (action === 'updateGrantMonth') {
      const { workerId, grantMonth } = body
      const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
      const wIdx = workers.findIndex(w => w.id === Number(workerId))
      if (wIdx < 0) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
      if (grantMonth === null || grantMonth === '' || grantMonth === undefined) {
        delete workers[wIdx].grantMonth
      } else {
        workers[wIdx].grantMonth = Number(grantMonth)
      }
      await updateDoc(docRef, { workers })
      return NextResponse.json({ success: true })
    }

    if (action === 'grant') {
      const { workerId, fy, grantDays, grantMonth, grantDate, carryOver: bodyCarryOver } = body
      const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>
      const key = String(workerId)
      let records = plData[key] || []

      // === 旧アプリ互換フィールドの一括クリーンアップ & 重複FY集約 ===
      records = records.map(r => {
        const clean = { ...r } as Record<string, unknown>
        if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
          clean.grantDays = clean.grant
        }
        if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
          clean.carryOver = clean.carry
        }
        if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
          clean.adjustment = clean.adj
        }
        delete clean.grant
        delete clean.carry
        delete clean.adj
        if (clean.fy !== undefined) clean.fy = String(clean.fy)
        return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      })
      // 同じfyで重複があれば集約
      type PLRec = { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      const fyMap = new Map<string, PLRec>()
      for (const rRaw of records) {
        const r = rRaw as PLRec
        const k = String(r.fy)
        const existing = fyMap.get(k)
        if (!existing) {
          fyMap.set(k, r)
        } else {
          const winner = r.grantDays >= existing.grantDays ? r : existing
          const loser = r.grantDays >= existing.grantDays ? existing : r
          fyMap.set(k, { ...loser, ...winner, grantDate: winner.grantDate || loser.grantDate || '' })
        }
      }
      records = Array.from(fyMap.values())

      const idx = records.findIndex(r => String(r.fy) === String(fy))

      // 繰越: ユーザーが明示的に指定している場合はそれを優先。
      // 未指定の場合は前期残日数から自動計算（日本人は強制0）
      const workersArrG = ((snap.data().workers || []) as { id: number; visa?: string; hireDate?: string }[])
      const workerG = workersArrG.find(x => x.id === Number(workerId))
      const isJpG = !workerG?.visa || workerG.visa === 'none'

      // ── 入力値バリデーション（2026-08-04 追加 / 有給システム総点検）──
      //   これまで法定超の付与も繰越上限超も素通りだった。詳細は validateGrantInput。
      {
        const prevRecsG = records
          .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0) && !(r as { _archived?: boolean })._archived)
          .filter(r => !grantDate || (r.grantDate as string) < grantDate)
          .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))
        const prevGrantG = prevRecsG.length > 0 ? (prevRecsG[prevRecsG.length - 1].grantDays ?? 0) : null
        const v = validateGrantInput({
          grantDays: Number(grantDays) || 0,
          carryOver: bodyCarryOver != null ? Number(bodyCarryOver) || 0 : undefined,
          hireDate: workerG?.hireDate,
          grantDate: grantDate || undefined,
          prevGrant: prevGrantG,
          isJapanese: isJpG,
        })
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

        // 同一期間への二重付与ガード: 新規作成（同 fy のレコードなし）で、
        // 既存の別 fy レコードの付与期間と重なる場合は拒否。
        // （半自動付与 executePendingGrants には同等のガードがあるのに手動側に無かった）
        if (grantDate && idx < 0) {
          const overlapping = records.find(r =>
            r.grantDate && ((r.grantDays ?? 0) > 0) && !(r as { _archived?: boolean })._archived &&
            grantPeriodsOverlap(r.grantDate as string, grantDate)
          )
          if (overlapping) {
            return NextResponse.json({
              error: `付与日 ${grantDate} は既存の付与（${overlapping.grantDate}・FY${overlapping.fy}）の期間内です。同一期間への二重付与はできません。既存レコードの編集で対応してください`,
            }, { status: 409 })
          }
        }
      }

      let carryOverVal: number
      if (bodyCarryOver != null) {
        carryOverVal = Number(bodyCarryOver) || 0
      } else if (grantDate) {
        // 自動計算には出面データが必要
        const allAttG: Record<string, Record<string, unknown>> = {}
        Object.assign(allAttG, (await getMultiMonthAttData(relevantAttMonths())).d)  // 並列読み（性能改善 2026-07-09）
        carryOverVal = calcCarryOverForWorker(Number(workerId), grantDate, records, allAttG, isJpG)
      } else {
        carryOverVal = 0
      }

      const record = {
        fy: String(fy),
        grantDate: grantDate || '',
        grantDays: Number(grantDays) || 0,
        carryOver: carryOverVal,
        adjustment: 0,
        used: 0,
        // 監査情報
        grantedAt: nowIso,
        grantedBy: actor,
        method: 'manual' as const,
      }
      if (idx >= 0) {
        // 既存レコードの更新: 初回grantedAtは残す、method='manual-edit'に
        const existing = records[idx] as { grantedAt?: string; grantedBy?: number | string; method?: string }
        const merged = {
          ...records[idx],
          ...record,
          grantedAt: existing.grantedAt || nowIso,  // 初回付与時刻を保持
          grantedBy: existing.grantedBy || actor,
          method: existing.method || 'manual',
          lastEditedAt: nowIso,
          lastEditedBy: actor,
        }
        records[idx] = merged as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      } else {
        records.push(record)
      }

      // race-fix: dot-notation で 1 worker 単位に局所化（他 worker の plData と衝突しない）
      // workers 配列は全体置換が必要だが、それは plData とは独立したフィールドなので
      // plData の他 worker への影響はない。
      if (grantMonth) {
        const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
        const wIdx = workers.findIndex(w => w.id === Number(workerId))
        if (wIdx >= 0) {
          workers[wIdx].grantMonth = Number(grantMonth)
          await updateDoc(docRef, { [`plData.${key}`]: records, workers })
        } else {
          await updateDoc(docRef, { [`plData.${key}`]: records })
        }
      } else {
        await updateDoc(docRef, { [`plData.${key}`]: records })
      }

      await logActivity('admin', 'leave.grant', `workerId=${workerId} に有給付与/編集（操作者: ${actor}）`)
      return NextResponse.json({ success: true })
    }

    if (action === 'carryOver') {
      // 「繰越自動計算」ボタン — 全ワーカーの「最新付与レコード」の繰越値を再計算する。
      // ワーカーごとに異なるサイクル（日本人=10/1、外国人=各grantDate）に対応。
      // 以前は10/1アンカー固定で計算していたため、4/23や7/1サイクルの外国人で
      // 前期期間が誤計算される問題があった。
      const plData = (snap.data().plData || {}) as Record<string, PLRecLite[]>
      const workersList = ((snap.data().workers || []) as { id: number; visa?: string }[])
      const isJapaneseOf = (wid: number) => {
        const w = workersList.find(x => x.id === wid)
        return !w?.visa || w.visa === 'none'
      }

      // 出面データを一括ロード
      const allAtt: Record<string, Record<string, unknown>> = {}
      Object.assign(allAtt, (await getMultiMonthAttData(relevantAttMonths())).d)  // 並列読み（性能改善 2026-07-09）

      let updated = 0
      let skipped = 0
      const skippedNames: string[] = []
      for (const [wid, records] of Object.entries(plData)) {
        const workerId = Number(wid)
        // 日本人社員は期末買取制のため繰越なし → 強制0
        const isJp = isJapaneseOf(workerId)

        // 最新付与レコード（grantDate最大 かつ grantDays>0）を特定
        // ⚠️ ここは selectActiveGrantRecord に置き換えないこと。
        //   繰越の自動計算は「次期の付与レコードに繰越日数を書き込む」処理なので、
        //   **未来の付与レコードを対象にするのが正しい**。今日時点で有効なレコードに
        //   書くと当期の枠が書き換わってしまう。
        const granted = records
          .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
          .slice()
          .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
        const latest = granted[granted.length - 1]
        if (!latest) continue

        const idx = records.findIndex(r => r === latest)
        if (idx < 0) continue

        // ★ 手動で調整済みの繰越は上書きしない（管理者の手動調整を尊重する）。
        //   日本人は繰越なしのため 0 を強制する必要があり、スキップ対象外。
        if (!isJp && hasManualCarryOverOverride(records[idx])) {
          skipped++
          const nm = workersList.find(w => w.id === workerId)
          skippedNames.push((nm as { name?: string } | undefined)?.name || `id${workerId}`)
          continue
        }

        const newCarry = calcCarryOverForWorker(workerId, latest.grantDate!, records, allAtt, isJp)

        // 最新レコードの carryOver を更新
        const before = (records[idx].carryOver ?? records[idx].carry ?? 0)
        if (before !== newCarry) {
          (records[idx] as { carryOver: number }).carryOver = newCarry
          // 旧フィールドも掃除しておく
          delete (records[idx] as Record<string, unknown>).carry
          updated++
        }
      }

      // race-warning: 同時実行は要注意（全 worker の plData を一括書き換えるため、
      //   他の編集 action と並行実行すると後勝ちで上書きが発生し得る。実行ロックを推奨）
      // 2026-06-XX 修正 (CR-5): dot-notation で worker 単位更新（plData={} 罠を回避）
      await updateMapByKey(docRef, 'plData', plData)
      return NextResponse.json({ success: true, updated, skipped, skippedNames })
    }

    // Default: edit PL record
    const { workerId, fy, grantDays, carryOver, adjustment, grantDate } = body
    const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>
    const key = String(workerId)
    let records = plData[key] || []

    // === 旧アプリ互換フィールドの一括クリーンアップ & 重複FYの集約 ===
    // すべてのレコードで grant→grantDays / carry→carryOver / adj→adjustment に昇格し、
    // 旧フィールドを削除する。また fy も String に正規化する。
    records = records.map(r => {
      const clean = { ...r } as Record<string, unknown>
      if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
        clean.grantDays = clean.grant
      }
      if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
        clean.carryOver = clean.carry
      }
      if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
        clean.adjustment = clean.adj
      }
      delete clean.grant
      delete clean.carry
      delete clean.adj
      if (clean.fy !== undefined) clean.fy = String(clean.fy)
      return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    })

    // 同じfyで重複レコードがあれば集約（過去のfy型ブレバグで発生した重複の修復）
    type PLRec2 = { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    const fyMap2 = new Map<string, PLRec2>()
    for (const rRaw of records) {
      const r = rRaw as PLRec2
      const k = String(r.fy)
      const existing = fyMap2.get(k)
      if (!existing) {
        fyMap2.set(k, r)
      } else {
        const winner = r.grantDays >= existing.grantDays ? r : existing
        const loser = r.grantDays >= existing.grantDays ? existing : r
        fyMap2.set(k, {
          ...loser,
          ...winner,
          grantDate: winner.grantDate || loser.grantDate || '',
        })
      }
    }
    records = Array.from(fyMap2.values())

    const idx = records.findIndex(r => String(r.fy) === String(fy))

    // ── 入力値バリデーション（2026-08-04 追加 / 有給システム総点検）──
    //   変更されたフィールドだけ検証する。既存レコードに移行期の変則値
    //   （法定と一致しない付与日数など）が入っていても、それを触らない編集
    //   （調整だけ直す等）まで巻き添えで弾かないため。
    {
      const workersArrE = ((snap.data().workers || []) as { id: number; visa?: string; hireDate?: string }[])
      const workerE = workersArrE.find(x => x.id === Number(workerId))
      const isJpE = !workerE?.visa || workerE.visa === 'none'
      const existing = idx >= 0 ? records[idx] as Record<string, unknown> : null
      const newGrantDays = Number(grantDays) || 0
      const newCarryOver = Number(carryOver) || 0
      const effGrantDate = (grantDate !== undefined ? grantDate : existing?.grantDate) as string | undefined
      const grantDaysChanged = !existing || (Number(existing.grantDays) || 0) !== newGrantDays
      const carryOverChanged = !existing || (Number(existing.carryOver) || 0) !== newCarryOver

      const prevRecsE = records
        .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0) && !(r as { _archived?: boolean })._archived)
        .filter(r => String(r.fy) !== String(fy))
        .filter(r => !effGrantDate || (r.grantDate as string) < effGrantDate)
        .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))
      const prevGrantE = prevRecsE.length > 0 ? (prevRecsE[prevRecsE.length - 1].grantDays ?? 0) : null

      const v = validateGrantInput({
        grantDays: newGrantDays,
        // 検証は「変更されたときだけ」。据え置き値は移行期データの可能性があるため素通し
        carryOver: carryOverChanged ? newCarryOver : undefined,
        hireDate: grantDaysChanged ? workerE?.hireDate : undefined,
        grantDate: grantDaysChanged ? (effGrantDate || undefined) : undefined,
        prevGrant: prevGrantE,
        isJapanese: isJpE,
      })
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    }

    const record: Record<string, unknown> = {
      fy: String(fy),
      grantDays: Number(grantDays) || 0,
      carryOver: Number(carryOver) || 0,
      adjustment: Number(adjustment) || 0,
      used: 0,
    }
    // grantDate が指定されたら更新（空文字の場合はクリア）
    if (grantDate !== undefined) {
      record.grantDate = grantDate || ''
    }
    if (idx >= 0) {
      // 既存レコードの編集: 値変更を adjustmentHistory に記録
      const existing = records[idx] as Record<string, unknown>
      type HistoryEntry = { at: string; by: number | string; field: string; before: string | number; after: string | number }
      const history = (existing.adjustmentHistory as HistoryEntry[] | undefined) ?? []
      const trackFields: Array<{ key: 'grantDays' | 'carryOver' | 'adjustment' | 'grantDate'; before: unknown; after: unknown }> = [
        { key: 'grantDays', before: existing.grantDays ?? 0, after: record.grantDays },
        { key: 'carryOver', before: existing.carryOver ?? 0, after: record.carryOver },
        { key: 'adjustment', before: existing.adjustment ?? 0, after: record.adjustment },
      ]
      if (grantDate !== undefined) {
        trackFields.push({ key: 'grantDate', before: (existing.grantDate as string) ?? '', after: record.grantDate })
      }
      for (const t of trackFields) {
        if (t.before !== t.after) {
          history.push({
            at: nowIso,
            by: actor,
            field: t.key,
            before: String(t.before ?? ''),
            after: String(t.after ?? ''),
          })
        }
      }
      const merged: Record<string, unknown> = {
        ...existing,
        ...record,
        lastEditedAt: nowIso,
        lastEditedBy: actor,
      }
      if (history.length > 0) merged.adjustmentHistory = history
      records[idx] = merged as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    } else {
      // 新規レコード: 監査情報も付与
      records.push({
        ...(record as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }),
        grantedAt: nowIso,
        grantedBy: actor,
        method: 'manual',
      } as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number })
    }

    // race-fix: dot-notation で 1 worker 単位に局所化（他 worker の plData と衝突しない）
    await updateDoc(docRef, { [`plData.${key}`]: records })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const calendarMode = request.nextUrl.searchParams.get('calendar') === 'true'
  const debugMode = request.nextUrl.searchParams.get('debug') === 'true'

  try {
    const main = await getMainData()

    // デバッグモード: 生のplDataを返す
    if (debugMode) {
      return NextResponse.json({ plData: main.plData })
    }

    // 全期間の出面データからPL消化を集計（付与日から1年間はスタッフごとに異なるため、広めに取得）
    const now = new Date()
    const currentYear = now.getFullYear()
    const allMonths: string[] = []
    // 過去2年 + 今年分をカバー
    for (let y = currentYear - 2; y <= currentYear; y++) {
      for (let m = 1; m <= 12; m++) allMonths.push(ymKey(y, m))
    }

    const allAtt: Record<string, Record<string, unknown>> = {}
    Object.assign(allAtt, (await getMultiMonthAttData(allMonths)).d)  // 並列読み（性能改善 2026-07-09・GET経路の主因）

    // Worker name map for calendar tooltips
    const workerNames: Record<number, string> = {}
    main.workers.forEach(w => { workerNames[w.id] = w.name })

    // 出向中の判定用に現在のYM
    const nowForDispatch = new Date()
    const currentYm = ymKey(nowForDispatch.getFullYear(), nowForDispatch.getMonth() + 1)

    // Build worker PL data — 現在FYに該当するレコードを優先して使用
    // 2026-06-XX 修正 (CR-2): 出向中スタッフも年5日義務の監視対象に含める
    //   労基法上、在籍出向の場合は出向元の使用者に5日義務が課せられる
    //   旧: !isDispatchedAt で完全除外 → 監視外 → 罰金リスク
    //   新: 出向中も含めて監視（出向先での消化が plData に反映されている前提）
    // 2026-06-XX 修正: 「今日時点で退職済み」のみ除外（未来日退職予定者は5日義務監視対象）
    const todayIso = todayJstIso()
    // 基準日 (asOf): 指定日「時点」の残数を計算する。省略時は今日。
    //   奥寺さん対応(2026-07-09): 月末残高の突合用。例 asOf=2026-06-30 で「6月末時点の残数」。
    const asOfParam = request.nextUrl.searchParams.get('asOf')
    const asOfIso = (asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) ? asOfParam : todayIso
    const workers = main.workers
      .filter(w => !isAlreadyRetired(w.retired, todayIso) && w.job !== 'yakuin' && w.job !== 'jimu')
      .map(w => {
        const plRecordsRaw = (main.plData[String(w.id)] || []) as { fy: number | string; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number; _archived?: boolean }[]
        // アーカイブ済みレコードは表示対象から除外（期限切れで2年以上経過）
        const plRecords = plRecordsRaw.filter(r => !r._archived)

        // 現在FYを判定
        // - 日本人社員（職長・とび等）: 全員「10/1起点」（決算期サイクル統一）
        // - 外国人（実習生・特定技能）: 個別の grantDate..+1年 に今日が含まれるレコードのfy
        const isJp = !w.visa || w.visa === 'none'
        const nowY = now.getFullYear()
        const nowM = now.getMonth() + 1

        let targetFy: string | null = null
        if (isJp) {
          // 日本人は全員 10/1 起点で統一
          targetFy = String(nowM >= 10 ? nowY : nowY - 1)
        } else {
          // 外国人: grantDate..+1y に今日を含むレコードのfyを使用
          const activeRec = plRecords.find(r => {
            if (!r.grantDate) return false
            const gd = new Date(r.grantDate)
            if (isNaN(gd.getTime())) return false
            const end = new Date(gd); end.setFullYear(end.getFullYear() + 1)
            return now >= gd && now < end
          })
          if (activeRec) targetFy = String(activeRec.fy)
        }

        // targetFy に一致するレコードのうち「最後のもの」を採用（push順で最新）
        let fyRecord: typeof plRecords[number] | undefined
        if (targetFy !== null) {
          const matching = plRecords.filter(r => String(r.fy) === targetFy)
          if (matching.length > 0) {
            const cand = matching[matching.length - 1]
            // 2026-08-27 修正（有給総点検・第3回）: fy一致でも付与日が未来なら未付与扱い。
            //   年途中入社の日本人（例: 初回付与12/1・fy=当FY）が 10/1〜付与日前の間、
            //   まだ来ていない枠を「現在の残数」として表示していた（トゥアン事案と同型）
            if (!cand.grantDate || cand.grantDate <= asOfIso) fyRecord = cand
          }
        }

        // フォールバック（2026-08-17 修正）
        // ⚠️ 旧コードは「付与日数があるレコードの最後」を取っていたため、
        //   全レコードが未来付与のケースで**まだ来ていない枠**を掴み残数が過大になった
        //   （トゥアン事案と同種。詳細は lib/leave-compute.ts の selectActiveGrantRecord）。
        //   今日時点で有効な付与が無ければ fyRecord は未確定のまま = 残0 として扱う。
        if (!fyRecord) {
          fyRecord = selectActiveGrantRecord(plRecords, todayJstIso()) ?? undefined
          // grantDate を持たない移行期データのみ、最後のレコードで救済する
          if (!fyRecord && plRecords.length > 0 && plRecords.every(r => !r.grantDate)) {
            fyRecord = plRecords[plRecords.length - 1]
          }
        }

        // 新フィールド優先、なければ旧フィールドにフォールバック
        // （旧データから新フォーマットに移行する過渡期で、両フィールドが混在することがある。
        //  以前は「旧フィールドがあれば旧形式」と判定していたが、これだと新フィールドに
        //  正しい値があっても旧フィールド未定義で 0 扱いになる致命的バグがあった）
        const grantDays   = fyRecord?.grantDays  ?? fyRecord?.grant  ?? 0
        const rawCarryOver = fyRecord?.carryOver ?? fyRecord?.carry  ?? 0
        const adjustment  = fyRecord?.adjustment ?? fyRecord?.adj    ?? 0
        // 日本人社員は期末買取制のため繰越なし（強制0）
        const isJapanese = !w.visa || w.visa === 'none'
        const carryOver = isJapanese ? 0 : rawCarryOver
        let grantDate = fyRecord?.grantDate || ''
        let inferredFromDefault = false

        // 日本人社員（visa='none'）でgrantDate未設定の場合、決算期サイクル(10/1起点)をデフォルト適用
        // ただし「Pエントリがある期」を優先して選ぶ（過去のデータを失わないため）
        if (!grantDate && (!w.visa || w.visa === 'none')) {
          const m = now.getMonth() + 1
          const currentFyStartYear = m >= 10 ? now.getFullYear() : now.getFullYear() - 1

          // 10/1起点でPエントリのFYを判定
          const fyCandidates = new Set<number>()
          for (const [key, entry] of Object.entries(allAtt)) {
            if (!entry) continue
            const e = entry as { p?: number | boolean }
            if (!e.p) continue
            const pk = parseDKey(key)
            if (parseInt(pk.wid) !== w.id) continue
            const ey = parseInt(pk.ym.slice(0, 4))
            const em = parseInt(pk.ym.slice(4, 6))
            const fyStart = em >= 10 ? ey : ey - 1
            fyCandidates.add(fyStart)
          }

          // 直近のFYを選ぶ（Pエントリがあれば最新FY、なければ当期）
          let selectedFyStart = currentFyStartYear
          if (fyCandidates.size > 0) {
            if (fyCandidates.has(currentFyStartYear)) {
              selectedFyStart = currentFyStartYear
            } else {
              selectedFyStart = Math.max(...Array.from(fyCandidates))
            }
          }
          grantDate = `${selectedFyStart}-10-01`
          inferredFromDefault = true
        }

        const total = grantDays + carryOver

        // 付与日から1年間のPL消化日数を集計（残日数計算用）+ 月別内訳は全期間
        // ⚠️ 多現場の同日重複（multi-site dup）を排除して1日1カウントに正規化
        let periodUsed = 0
        let actualPeriodUsed = 0 // 実消化（今日以前に実際に取得済み・参考列用。残数管理は periodUsed=申請ベースのまま）
        let asOfUsed = 0         // 基準日(asOf)までに取得済みの消化日数（月末残高の突合用）
        const plCalendarLocal: string[] = []
        const monthlyUsage: Record<string, number> = {} // YYYYMM -> count（全期間、重複排除済）

        const hasPeriod = !!grantDate
        const gd = hasPeriod ? new Date(grantDate) : null
        const gdEnd = hasPeriod ? new Date(gd!) : null
        if (gdEnd) gdEnd.setFullYear(gdEnd.getFullYear() + 1)

        const seenAllPeriod = new Set<string>()      // 全期間 (monthly/calendar 用)
        const seenCurrentFy = new Set<string>()      // 当期 (periodUsed 用)
        //
        // 設計ポリシー（2026-05-18 確定）:
        //   有給残日数は「申請ベース」で全画面・全帳票統一する。
        //   = 出面に書き込まれた p:1（過去・未来とも）をすべて使用済みとして集計。
        //   理由: 申請承認時点で日数はコミット済みリソースとなるため、
        //         スタッフ・管理者ともに「申請可能な残り」として見るのが直感的。
        //   ※ 帰国予定の有給申請（未来日付）も承認時に出面 p:1 になるが、これも当然使用済み扱い。
        //
        for (const [key, entry] of Object.entries(allAtt)) {
          if (!entry) continue
          const e = entry as { p?: number | boolean }
          // 旧データ互換: e.p === 1 だけでなく truthy な値をすべて有給として扱う
          if (!e.p) continue
          const pk = parseDKey(key)
          const wid = parseInt(pk.wid)
          if (wid !== w.id) continue
          const entryDate = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
          const dk = `${pk.ym}_${pk.day}`

          // monthlyUsage と plCalendarLocal は全期間集計（月別タブやPLカレンダー表示用）
          if (!seenAllPeriod.has(dk)) {
            seenAllPeriod.add(dk)
            monthlyUsage[pk.ym] = (monthlyUsage[pk.ym] || 0) + 1
            plCalendarLocal.push(`${pk.ym}${pk.day}`)
          }

          // periodUsed は当期（grantDate〜+1年）のみカウント（残日数計算用、申請ベース）
          if (hasPeriod && (entryDate < gd! || entryDate >= gdEnd!)) continue
          if (seenCurrentFy.has(dk)) continue
          seenCurrentFy.add(dk)
          periodUsed++
          // 実消化（参考・2026-06）: 申請ベース(periodUsed)とは別に「今日以前に実際に取得済み」の
          //   有給だけを数える。残数管理・スマホ残日数・年5日義務は従来どおり申請ベースのまま。
          //   担当者の実績把握用に一覧へ参考列として並べる（computePeriodUsed.actualPeriodUsed と同義）。
          const entryIso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
          if (entryIso <= todayIso) actualPeriodUsed++
          if (entryIso <= asOfIso) asOfUsed++  // 基準日までに取得済みの分
        }
        // 2026-06-XX 修正 (audit #5+#6): computeUsedDays ヘルパー経由で計算
        //   旧: used = adjustment + periodUsed （buyoutDays が抜けていた）
        //   新: used = adjustment + buyoutDays + periodUsed （時効処理と式を統一）
        //   結果: 買取後も画面残数に買取分が含まれていたバグを根治
        //   注: fyRecord が undefined の場合 (新規スタッフで履歴なし等) は
        //       空オブジェクト渡してヘルパー内のデフォルト値を使う
        const safeRec = (fyRecord as Parameters<typeof computeUsedDays>[0] | undefined) ?? {}
        const used = computeUsedDays(safeRec, periodUsed)
        const remaining = computeRemainingDays(total, safeRec, periodUsed)
        // 実消化ベース残（参考・2026-06）: 申請ベース(periodUsed)ではなく、今日までに実際に取得した
        //   分(actualPeriodUsed)だけ引いた残日数。承認済みの未来有給は引かないので remaining 以上になる。
        const remainingActual = computeRemainingDays(total, safeRec, actualPeriodUsed)
        // 基準日(asOf)時点の残数: 基準日までに取得した分だけを引く（月末残高の突合用）。
        //   asOf 省略時は今日なので remainingActual と同値。
        const asOfRemaining = computeRemainingDays(total, safeRec, asOfUsed)

        // 最終利用可能日（= 付与日 + 2年 - 1日）。calcLastUsableDayIso に統一。
        let expiryDate = ''
        let expiryStatus: 'ok' | 'warning' | 'expired' = 'ok'
        if (grantDate) {
          const lastUsable = calcLastUsableDayIso(grantDate)
          if (lastUsable) {
            expiryDate = lastUsable.replace(/-/g, '/')
            const todayStr = todayJstIso()
            if (isLeaveExpiredAsOf(grantDate, todayStr)) expiryStatus = 'expired'
            else if (daysBetween(todayStr, lastUsable) <= 60) expiryStatus = 'warning'
          }
        }

        // Legal PL calculation info
        const legalPL = w.hireDate ? calcLegalPL(w.hireDate, grantDate || new Date().toISOString().split('T')[0]) : 0

        // 年5日取得義務チェック（労基法第39条第7項）
        // 2026-06-XX 改訂: requestedPeriodUsed（承認済み未来日も含む申請ベース）で判定
        //   背景:
        //     - 承認済み有給は att に p:1 が書かれ「コミット済み取得予定」として扱える
        //     - 取り消しは admin revoke action 必須（容易には起きない）
        //     - 「6月後半5日承認済みなのに警告が出る」UX問題（過剰警告）を解消
        //   安全網:
        //     - 万一 revoke で承認が取り消された場合、次回ページ更新時に
        //       requestedPeriodUsed が減って警告が再表示される
        //     - 経過9ヶ月以上 OR 残3ヶ月以内 OR 退職予定が期限前 で警告（早期通知維持）
        let fiveDayShortfall = 0
        if (grantDate && grantDays > 0) {
          const { requestedPeriodUsed } = computePeriodUsed(w.id, grantDate, allAtt, todayIso)
          const judge = judgeFiveDayObligation(
            grantDate, grantDays, requestedPeriodUsed, w.retired, todayIso
          )
          if (judge.warning) {
            fiveDayShortfall = judge.shortfall
          }
        }

        // ═════════════════════════════════════════════════════════════
        // Phase 8: FIFO 内訳計算（繰越分と当期付与分を別々に追跡）
        // ═════════════════════════════════════════════════════════════
        // 消化 (used) は「繰越分」→「当期付与分」の順に消費される (FIFO)
        // 繰越分は前期の付与日から2年で時効、当期分は当期の付与日から2年で時効
        // これにより期限の異なる2つのバケットを正確に表示できる
        const totalUsedForBreakdown = used  // = adjustment + periodUsed
        const fromCarryOver = Math.min(totalUsedForBreakdown, carryOver)
        const fromGrant = Math.max(0, totalUsedForBreakdown - carryOver)
        const carryOverRemainingRaw = Math.max(0, carryOver - fromCarryOver)
        const grantRemainingRaw = Math.max(0, grantDays - fromGrant)

        // 繰越分の時効日: 前期レコード(grantDate)の +2年 -1日
        // plRecordsRaw から「現行より古い grantDate を持つレコード」のうち最新を選ぶ
        // (archived なレコードも含むが、そこに到達する前に時効済みなら 0 表示されるため問題なし)
        let carryOverExpiryDate = ''
        let carryOverExpiryStatus: 'ok' | 'warning' | 'expired' = 'ok'
        let carryOverSourceGrantDate = ''
        if (grantDate && carryOver > 0) {
          const curTime = new Date(grantDate).getTime()
          const prevCandidates = plRecordsRaw
            .filter(r => r.grantDate)
            .map(r => ({ rec: r, time: new Date(r.grantDate as string).getTime() }))
            .filter(x => !isNaN(x.time) && x.time < curTime)
            .sort((a, b) => a.time - b.time)
          const prevRec = prevCandidates[prevCandidates.length - 1]
          if (prevRec && prevRec.rec.grantDate) {
            carryOverSourceGrantDate = prevRec.rec.grantDate
            const prevLastUsable = calcLastUsableDayIso(prevRec.rec.grantDate)
            carryOverExpiryDate = prevLastUsable.replace(/-/g, '/')
            const todayStr = todayJstIso()
            if (isLeaveExpiredAsOf(prevRec.rec.grantDate, todayStr)) carryOverExpiryStatus = 'expired'
            else if (daysBetween(todayStr, prevLastUsable) <= 90) carryOverExpiryStatus = 'warning'
          }
        }
        // 繰越分が時効済みの場合は残 0 とする（実務上消費できないため）
        const carryOverRemaining = carryOverExpiryStatus === 'expired' ? 0 : carryOverRemainingRaw
        const grantRemaining = expiryStatus === 'expired' ? 0 : grantRemainingRaw

        // 当期付与分の時効日（既存のexpiryDateと同じ）
        const grantExpiryDate = expiryDate
        const grantExpiryStatus = expiryStatus

        return {
          id: w.id,
          name: w.name,
          org: w.org,
          visa: w.visa,
          hireDate: w.hireDate || '',
          grantDays,
          carryOver,
          adjustment,
          periodUsed,
          actualPeriodUsed, // 実消化（今日以前）
          used,
          total,
          remaining: expiryStatus === 'expired' ? 0 : remaining,
          remainingActual: expiryStatus === 'expired' ? 0 : remainingActual, // 実消化ベース残（参考）
          asOfUsed,  // 基準日までの消化日数
          asOfRemaining: expiryStatus === 'expired' ? 0 : asOfRemaining, // 基準日時点の残数（月末残高突合用）
          rate: total > 0 ? (used / total) * 100 : 0,
          grantMonth: (w as unknown as { grantMonth?: number }).grantMonth,
          grantDate,
          inferredFromDefault,
          expiryDate,
          expiryStatus,
          legalPL,
          fiveDayShortfall,
          monthlyUsage,
          // 監査情報: 現在表示中レコードのみ
          grantedAt: (fyRecord as { grantedAt?: string } | undefined)?.grantedAt,
          grantedBy: (fyRecord as { grantedBy?: number | string } | undefined)?.grantedBy,
          method: (fyRecord as { method?: string } | undefined)?.method,
          lastEditedAt: (fyRecord as { lastEditedAt?: string } | undefined)?.lastEditedAt,
          lastEditedBy: (fyRecord as { lastEditedBy?: number | string } | undefined)?.lastEditedBy,
          adjustmentHistory: (fyRecord as { adjustmentHistory?: Array<{ at: string; by: number | string; field: string; before: string; after: string }> } | undefined)?.adjustmentHistory,
          // Phase 5: 時季指定履歴
          designatedLeaves: (fyRecord as { designatedLeaves?: Array<{ date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string }> } | undefined)?.designatedLeaves,
          // Phase 6: 買取記録
          buyoutDays: (fyRecord as { buyoutDays?: number } | undefined)?.buyoutDays,
          buyoutHistory: (fyRecord as { buyoutHistory?: Array<{ at: string; by: number | string; days: number; amount?: number; reason?: string }> } | undefined)?.buyoutHistory,
          // Phase 8: FIFO内訳（繰越分と当期付与分の別々管理）
          carryOverRemaining,
          carryOverExpiryDate,
          carryOverExpiryStatus,
          carryOverSourceGrantDate,
          grantRemaining,
          grantExpiryDate,
          grantExpiryStatus,
        }
      })
      // Show all eligible workers (including those with no PL data yet)

    // PLカレンダーデータを出面から構築（旧データ互換: truthy判定）
    // dateKeyを YYYYMMDD 形式で統一（日が1桁の場合の重複問題を回避）
    const plCalendar: Record<string, number[]> = {}
    for (const [key, entry] of Object.entries(allAtt)) {
      if (!entry) continue
      const e = entry as { p?: number | boolean }
      if (e.p) {
        const pk = parseDKey(key)
        const wid = parseInt(pk.wid)
        const dateKey = `${pk.ym}${String(pk.day).padStart(2, '0')}`
        if (!plCalendar[dateKey]) plCalendar[dateKey] = []
        if (!plCalendar[dateKey].includes(wid)) plCalendar[dateKey].push(wid)
      }
    }

    // 基準日をエコー（フロントで「○○時点の残数」ラベルに使う）。today と一致なら null 相当。
    const response: Record<string, unknown> = { workers, asOf: asOfIso, isAsOfToday: asOfIso === todayIso }

    if (calendarMode) {
      response.plCalendar = plCalendar
      response.workerNames = workerNames
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Leave API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Server error', detail: errMsg }, { status: 500 })
  }
}

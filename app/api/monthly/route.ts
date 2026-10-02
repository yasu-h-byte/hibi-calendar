import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, setDoc } from '@/lib/fsdb'
import { getMainData, getAttData, computeMonthly, loadMonthlyAllowances, parseDKey } from '@/lib/compute'
import { isMonthLockedInLocks, orgKeyOf } from '@/lib/locks'
import { getMonthlyCalendars } from '@/lib/repositories/calendarRepo'
import { isStillActiveForMonth, isHiredByMonth } from '@/lib/workers'
import { getAllActiveHomeLeaves } from '@/lib/homeLeave'

export async function GET(request: NextRequest) {
  // 2026-09-26: 読み取りも権限表どおり（lib/permissions.ts monthly.view）。旧: ログインしていれば職長でも読めた
  { const denied = await requireCap(request, 'monthly.view'); if (denied) return denied }

  const { searchParams } = new URL(request.url)
  const ym = searchParams.get('ym')

  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)
    const prescribedDays = main.workDays[ym] || 0
    // カレンダーから現場別所定日数を取得（5月以降は手入力不要）
    const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
    const hasCalendarData = Object.keys(siteWorkDaysMap).length > 0
    // 3層構造のベース日数（管理者設定）
    const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
    // 外国人給与の週残業しきい値を「カレンダー予定日ベース」で判定するための日別カレンダー（監査④）。
    //   Excel出力(/api/export)と同一基準にし、画面とExcelの残業額を一致させる。
    const cals = await getMonthlyCalendars(`${ym.slice(0, 4)}-${ym.slice(4, 6)}` as Parameters<typeof getMonthlyCalendars>[0])
    const calendarDaysMap: Record<string, Record<string, string>> = {}
    for (const c of cals) if (c.days) calendarDaysMap[c.siteId] = c.days
    // 帰国中（一時帰国・復帰未定）期間を給与計算へ渡す（帰国中日を無給かつ非欠勤扱いにする）
    const homeLeaves = await getAllActiveHomeLeaves()
    // 遠方現場日当・運転手当（2026-10 施行。施行前の月は undefined＝計算不変）
    const allowances = await loadMonthlyAllowances(main, ym, att.d, att.drv)
    const result = computeMonthly(main, att.d, att.sd, ym, prescribedDays, hasCalendarData ? siteWorkDaysMap : undefined, baseDays, calendarDaysMap, homeLeaves, allowances)

    // 組織別ロック状態（後方互換: 旧 locks[ym] もチェック）
    //   判定は lib/locks.ts（2026-10-02 総合点検: 旧は locks[ym] を自前に読んでいた）
    const lockedHibi = isMonthLockedInLocks(main.locks, ym, 'hibi')
    const lockedHfu = isMonthLockedInLocks(main.locks, ym, 'hfu')
    const locked = lockedHibi && lockedHfu  // 両方締めていれば全体locked
    const workDays = prescribedDays

    // Site name map for frontend display
    const siteNames: Record<string, string> = {}
    for (const s of main.sites) {
      siteNames[s.id] = s.name
    }

    // 2026-06-XX 追加: 印刷ページ (/monthly/audit-print) 用に
    //   日別出勤データを optional で返す。includeDaily=true で取得。
    //   キー形式: workerId -> { day -> entry }
    //   通常の月次集計画面では使われないので、デフォルトでは含めない（payload 削減）。
    let dailyByWorker: Record<number, Record<number, unknown>> | undefined
    if (searchParams.get('includeDaily') === 'true') {
      dailyByWorker = {}
      for (const [key, entry] of Object.entries(att.d || {})) {
        if (!entry || typeof entry !== 'object') continue
        // key 形式: `${siteId}_${workerId}_${ym}_${day}`。分解は共通（lib/compute.ts parseDKey・2026-10-02 総合点検）
        const pk = parseDKey(key)
        const day = parseInt(pk.day)
        const wid = parseInt(pk.wid)
        const siteId = pk.sid
        if (pk.ym !== ym || !Number.isFinite(wid) || !Number.isFinite(day)) continue
        if (!dailyByWorker[wid]) dailyByWorker[wid] = {}
        // 同一日に複数現場の入力がある場合は「実労働・夜勤のあるエントリ」を優先して保持
        //（カレンダー表示は1日1セル。旧: 走査順の1件目固定で、夜勤や出勤が
        //  休み残骸などに隠れることがあった 2026-08-27）
        type DailyEnt = { w?: number; ns?: number }
        const prev = dailyByWorker[wid][day] as DailyEnt | undefined
        const cur = entry as DailyEnt
        const weight = (x?: DailyEnt) => x ? ((x.w || 0) > 0 || x.ns ? 2 : 1) : 0
        if (weight(cur) > weight(prev)) {
          dailyByWorker[wid][day] = { ...entry, _siteId: siteId }
        }
      }
    }

    // 2026-06-12 (監査 Sprint2-D): 締め済み月は締め時スナップショットと現行計算を突合。
    //   締め後の単価変更・出面修正で支給額が変わっていれば画面に警告する。
    type SnapDiffItem = { id: number; name: string; snapshot: number; current: number }
    const snapshotDiffs: { org: string; lockedAt?: string; count: number; items: SnapDiffItem[] }[] = []
    for (const [orgKey, isLocked] of [['hibi', lockedHibi], ['hfu', lockedHfu]] as const) {
      if (!isLocked) continue
      try {
        let snapDoc = await getDoc(doc(db, 'payrollSnapshots', `${ym}_${orgKey}`))
        if (!snapDoc.exists()) snapDoc = await getDoc(doc(db, 'payrollSnapshots', `${ym}_all`))
        if (!snapDoc.exists()) continue  // スナップショット導入前の締めは検知対象外
        const snapData = snapDoc.data() as { lockedAt?: string; workers?: { id: number; name: string; salaryNetPay?: number }[] }
        const snapMap = new Map((snapData.workers || []).map(w => [w.id, w]))
        const items: SnapDiffItem[] = []
        for (const w of result.workers) {
          if (orgKeyOf(w.org) !== orgKey) continue   // 会社の判定は共通（lib/locks.ts orgKeyOf）
          // 日本人日給月給は netPay が支給額（lock 側の保存値と同じフォールバック 2026-08-27）
          const cur = (w.salaryNetPay ?? w.netPay) || 0
          const s = snapMap.get(w.id)
          snapMap.delete(w.id)
          const snapVal = s?.salaryNetPay || 0
          // 後方互換: 2026-08-27 以前のスナップショットは日本人日給月給を 0 で保存している
          //   （旧実装の取りこぼし）。旧スナップショットの 0 は「未記録」なので差分にしない
          const isLegacySnap = (snapData.lockedAt || '') < '2026-08-28'
          if (isLegacySnap && snapVal === 0) continue
          if (snapVal !== cur) items.push({ id: w.id, name: w.name, snapshot: snapVal, current: cur })
        }
        for (const s of snapMap.values()) {
          if ((s.salaryNetPay || 0) !== 0) items.push({ id: s.id, name: s.name, snapshot: s.salaryNetPay || 0, current: 0 })
        }
        if (items.length > 0) {
          snapshotDiffs.push({ org: orgKey, lockedAt: snapData.lockedAt, count: items.length, items: items.slice(0, 10) })
        }
      } catch (e) {
        console.error(`[monthly] snapshot diff 取得失敗 (${orgKey}):`, e)
      }
    }

    // 締めの準備カードの「出面の承認」（2026-10-02）: 締め前の会社だけ、締めと同じ判定で足りない「現場×日」を数える。
    //   旧: 常に緑のチェック（実際の承認状況を見ていなかった）。締め済みの会社は締めた時点でそろっているので数えない
    const { monthApprovalStatus } = await import('@/lib/month-approval-status')
    const { describeApprovalGap } = await import('@/lib/approval-gap')
    const siteNameOf = (id: string) => main.sites.find(s => s.id === id)?.name || id
    const approvalStatus: Record<string, { needed: number; foremanMissing: number; finalMissing: number; complete: boolean; finalRequired: boolean; detail: string; notEnded?: boolean }> = {}
    // 月が終わっていない（当月・先の月）は数えない。まだ来ていない日の承認まで読み、「承認がまだ 600件」のように出ていた（2026-10-02 点検）
    const { currentYmJst } = await import('@/lib/date-utils')
    const monthNotEnded = ym >= currentYmJst()
    await Promise.all((['hibi', 'hfu'] as const).map(async orgKey => {
      if (orgKey === 'hibi' ? lockedHibi : lockedHfu) return
      if (monthNotEnded) {
        approvalStatus[orgKey] = { needed: 0, foremanMissing: 0, finalMissing: 0, complete: false, finalRequired: false, detail: '', notEnded: true }
        return
      }
      try {
        const ap = await monthApprovalStatus(main, att.d, ym, orgKey)
        approvalStatus[orgKey] = {
          needed: ap.needed, foremanMissing: ap.gap.foremanMissing.length, finalMissing: ap.gap.finalMissing.length,
          complete: ap.complete, finalRequired: ap.finalRequired,
          detail: describeApprovalGap(ap.gap, siteNameOf),   // どの現場の何日が足りないか（締めのエラーと同じ書き方）
        }
      } catch (e) {
        console.error(`[monthly] 承認状況の取得失敗 (${orgKey}):`, e)
      }
    }))

    return NextResponse.json({
      workers: result.workers,
      subcons: result.subcons,
      sites: result.sites,
      totals: result.totals,
      locked,
      lockedHibi,
      lockedHfu,
      workDays,
      prescribedDays,
      baseDays,  // 2026-06-12 (監査): モーダル/印刷の式表示用（旧: クライアントで20固定）
      // 2026-06-12 (監査 Sprint2): 旧ルール継続者（フン等）が当月在籍しているか。
      //   true の場合、カレンダーがある月でも全社所定日数の入力欄を表示する
      //   （旧ルール者の欠勤控除は main.workDays[ym] を使うため毎月の設定が必要）
      hasOldRulesWorkers: main.workers.some(w =>
        (w as { useOldRules?: boolean }).useOldRules === true
        && isStillActiveForMonth(w.retired, ym)
        && isHiredByMonth(w.hireDate, ym)),
      siteNames,
      hasCalendarData,
      siteWorkDays: siteWorkDaysMap,
      approvalStatus,
      ...(snapshotDiffs.length > 0 ? { snapshotDiffs } : {}),
      ...(dailyByWorker ? { dailyByWorker } : {}),
    })
  } catch (error) {
    console.error('Monthly API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Failed to compute monthly data', detail: errMsg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // 2026-09-26: 所定日数の保存・前月コピーは締めと同じ monthly.close（事務・事業責任者・代表）
  const denied = await requireCap(request, 'monthly.close')
  if (denied) return denied

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'setWorkDays') {
      const { ym, value } = body
      if (!ym || !/^\d{6}$/.test(ym)) {
        return NextResponse.json({ error: 'ym required' }, { status: 400 })
      }
      // 2026-06-12 (監査 Sprint2-B): 全社所定日数は旧ルール継続者(フン)の欠勤控除に
      //   直結するため、当該月がロック済みなら変更を拒否
      {
        // 2026-10-02 総合点検: 旧ルールの固定月給の人は HFU にもいる。旧実装は日比建設の締めしか見ず、
        //   HFU を締めた後でも所定日数を変えられた（HFU の確定額が動く）。どちらかが締め済みなら拒否
        const { checkMonthLockedForWorkers } = await import('@/lib/locks')
        const lockErr = await checkMonthLockedForWorkers(ym, [], 'either')
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }
      const numValue = Number(value) || 0
      const docRef = doc(db, 'demmen', 'main')
      await updateDoc(docRef, { [`workDays.${ym}`]: numValue })
      const { logActivity } = await import('@/lib/activity')
      await logActivity('admin', 'monthly.setWorkDays', `${ym} の全社所定日数を ${numValue}日 に設定`)
      return NextResponse.json({ success: true, workDays: numValue })
    }

    if (action === 'copyPrevMonth') {
      // 2026-10-02 総合点検で廃止（410）。前月の出面をそのまま当月へ写す機能は、締め・在籍・承認・多現場の確かめも
      //   変更履歴も無く、実在しない日（8/31 → 9/31）を作り、本人の印（s:'staff'）ごと写して「本人の入力あり」に見せていた。
      //   当月の出面はスタッフの打刻・職長の入力・一括入力で作る（画面のボタンも外した）
      return NextResponse.json({
        error: '「前月コピー」は廃止しました。当月の出面はスタッフの打刻と出面入力の一括入力で作ってください（締め・在籍・承認の確かめを通らない写しは作りません）',
      }, { status: 410 })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('Monthly POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

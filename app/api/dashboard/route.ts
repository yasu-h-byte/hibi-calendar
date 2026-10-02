import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, getDocs } from '@/lib/fsdb'
import {
  compute,
  getMainData,
  getAttData,
  getAttDataCached,
  isClosedMonthYm,
  calcTobiEquiv,
  getSiteRates,
  getBillTotal,
  getAvgRevenuePerEquiv,
  getAssign,
  buildYMList,
  MainData,
  parseDKey,
} from '@/lib/compute'
import { ymKey, isWorkingDay } from '@/lib/attendance'
import { isTobiGroup } from '@/lib/jobs'
import { isStillActiveForMonth, isAlreadyRetired, isHiredByMonth, isEmployedOn } from '@/lib/workers'
import { todayJstIso, calcLastUsableDayIso, isLeaveExpiredAsOf, daysBetween, addMonthsSafe, addDaysIso, currentYmJst, todayJstDate } from '@/lib/date-utils'
import { AttendanceEntry } from '@/types'
import { selectActiveGrantRecord, judgeFiveDayObligation, jpNextGrantAfter } from '@/lib/leave-compute'
import type { HomeLeaveEntry } from '@/lib/homeLeave'

// このルートは Firestore の最新データに依存するため、常に動的に実行する
export const dynamic = 'force-dynamic'

// --- Helpers ---

/**
 * 日本時間（JST, Asia/Tokyo）の「今日」を返す。
 *
 * Vercel サーバは UTC で動作するため、JST の早朝〜午前中（UTC 前日 15:00〜23:59）に
 * `new Date()` を使うと日付が1日早く判定されてしまう。本ヘルパーで JST 基準の Date を取得する。
 * 2026-05-12 修正: ダッシュボードの「前日の稼働状況」が JST 早朝アクセス時に
 * 1日前にずれて表示されない事象への対応。
 */
function getJstNow(): Date {
  // toLocaleString('en-CA', { timeZone: 'Asia/Tokyo' }) は "YYYY-MM-DD HH:mm:ss" 形式
  const jstStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Tokyo', hour12: false })
  // "YYYY-MM-DD, HH:mm:ss" のカンマ区切りを取り除いて T 区切りに
  const [datePart, timePart] = jstStr.replace(',', '').trim().split(' ')
  return new Date(`${datePart}T${timePart}`)
}

/** Today's attendance status */
function computeTodayStatus(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  day: number,
  excludeSiteIds?: Set<string>,
  extraHomeLeaveWorkerIds?: Set<number>,  // 呼び出し側でhomeLongLeaveコレクションから集めたIDも渡せる
) {
  const activeSites = main.sites.filter(s => !s.archived && !(excludeSiteIds?.has(s.id)))

  const siteStatus: {
    siteId: string; siteName: string; tobi: number; doko: number; subTobi: number; subDoko: number; total: number
  }[] = []
  const absentWorkers: { id: number; name: string }[] = []
  const workingWorkerIds = new Set<number>()

  for (const site of activeSites) {
    let tobi = 0
    let doko = 0

    const assignData = getAssign(main, site.id, ym)
    const workerIds = assignData.workers

    for (const wid of workerIds) {
      const key = `${site.id}_${wid}_${ym}_${String(day)}`
      const entry = attD[key]
      // ⚠️ 2026-05-09: isWorkingDay() で残骸データ対策（有給/休み/現場休/帰国中/試験 を除外）
      if (entry && isWorkingDay(entry)) {
        const worker = main.workers.find(w => w.id === wid)
        if (worker) {
          const job = worker.job || ''
          if (isTobiGroup(job)) tobi++
          else if (job === 'doko') doko++
          else tobi++ // default to tobi for unknown jobs
          workingWorkerIds.add(wid)
        }
      }
    }

    // Count subcons for today, split by type
    let subTobi = 0
    let subDoko = 0
    const subconIds = assignData.subcons
    for (const scid of subconIds) {
      const key = `${site.id}_${scid}_${ym}_${String(day)}`
      const sdEntry = attSD[key]
      if (sdEntry && sdEntry.n && sdEntry.n > 0) {
        const sc = main.subcons.find(x => x.id === scid)
        if (sc && sc.type === '土工業者') {
          subDoko += sdEntry.n
        } else {
          subTobi += sdEntry.n
        }
      }
    }

    const total = tobi + doko + subTobi + subDoko
    if (workerIds.length > 0) {
      siteStatus.push({ siteId: site.id, siteName: site.name, tobi, doko, subTobi, subDoko, total })
    }
  }

  // Absent workers: assigned but not working today
  // 帰国中（homeLongLeave 期間内 or 出面の hk:1）のスタッフは除外
  const allAssignedWorkerIds = new Set<number>()
  for (const site of activeSites) {
    const siteAssign = getAssign(main, site.id, ym)
    for (const wid of siteAssign.workers) allAssignedWorkerIds.add(wid)
  }

  // 今日帰国中のワーカーIDは呼び出し側で集めた homeLongLeave の結果を使用
  // （2026-05-13: 旧 main.homeLeaves 配列の参照を廃止）
  const homeLeaveWorkerIds = new Set<number>(extraHomeLeaveWorkerIds || [])
  const todayDateStr = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`

  for (const wid of Array.from(allAssignedWorkerIds)) {
    if (workingWorkerIds.has(wid)) continue
    if (homeLeaveWorkerIds.has(wid)) continue  // 帰国中は休みリストから除外

    // 出面エントリに hk:1 があれば帰国中扱いで除外（保険）
    let isHomeLeaveByEntry = false
    for (const site of activeSites) {
      const key = `${site.id}_${wid}_${ym}_${String(day)}`
      const entry = attD[key] as { hk?: number } | undefined
      if (entry && entry.hk === 1) { isHomeLeaveByEntry = true; break }
    }
    if (isHomeLeaveByEntry) continue

    // 2026-06-XX 修正: 当該月在籍中のスタッフを欠勤者候補に
    // 2026-10-02: 月ではなくその日で在籍を見る（10/26 入社の人が10月初めから「休み」に出ていた）
    const worker = main.workers.find(w => w.id === wid && isEmployedOn(w, todayDateStr))
    if (worker) absentWorkers.push({ id: worker.id, name: worker.name })
  }

  return { siteStatus, absentWorkers }
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  // 2026-09-26: 読み取りも権限表どおり（lib/permissions.ts dashboard.view）。旧: ログインしていれば職長でも読めた
  { const denied = await requireCap(request, 'dashboard.view'); if (denied) return denied }

  const ym = request.nextUrl.searchParams.get('ym')
  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  const period = request.nextUrl.searchParams.get('period') || 'month'
  const siteFilter = request.nextUrl.searchParams.get('site') || 'all'

  try {
    const main = await getMainData()
    const baseY = parseInt(ym.slice(0, 4))
    const baseM = parseInt(ym.slice(4, 6))

    // ═══ 出面読みの一元化（2026-09-02 高速化）═══
    //   旧: 各セクション（出勤率6ヶ月・期間・売上単価の遡り3ヶ月・FY推移・前年同期・年5日・
    //   欠勤届・当日）がそれぞれ getAttData を呼び、同じ月を2〜3回ずつ、合計 30〜40 回
    //   読んでいた（1件 200〜300KB）。ここで月→Promise のメモを持ち、必要な月を最初に
    //   まとめて並列で先読みする。前月より前の確定済み月は5分キャッシュ（getAttDataCached）。
    type AttRes = Awaited<ReturnType<typeof getAttData>>
    const attMemo = new Map<string, Promise<AttRes>>()
    const loadAtt = (m: string): Promise<AttRes> => {
      let pr = attMemo.get(m)
      if (!pr) {
        pr = (isClosedMonthYm(m) ? getAttDataCached(m) : getAttData(m)).catch(() => ({ d: {}, sd: {} }))
        attMemo.set(m, pr)
      }
      return pr
    }
    const loadMulti = async (yms: string[]) => {
      const results = await Promise.all(yms.map(loadAtt))
      const merged = { d: {} as Record<string, AttendanceEntry>, sd: {} as Record<string, { n: number; on: number }> }
      const perMonth = new Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }>; drv?: Record<string, { am?: number[]; pm?: number[] }> }>()
      yms.forEach((m, i) => {
        const att = results[i]
        Object.assign(merged.d, att.d)
        Object.assign(merged.sd, att.sd)
        perMonth.set(m, { d: att.d, sd: att.sd, drv: att.drv })
      })
      return { ...merged, perMonth }
    }
    // ── 年5日義務の対象者（main だけで決まる）。追加で読む月を最初の先読みに入れるため先に確定する ──
    const todayIsoForVisa = todayJstIso()  // 2026-08-27: ローカルJST実行でも1日ズレないよう統一
    const obligationTargets: { w: (typeof main.workers)[number]; start: string; grantDays: number }[] = []
    for (const w of main.workers) {
      if (isAlreadyRetired(w.retired, todayIsoForVisa)) continue
      const records = main.plData[String(w.id)] || []
      if (records.length === 0) continue
      const latest = selectActiveGrantRecord(records, todayIsoForVisa)
      if (!latest || !latest.grantDate) continue  // まだ付与前 → 5日義務の対象外
      const grantDays = latest.grantDays ?? latest.grant ?? 0
      if (grantDays < 10) continue // 5日義務は年10日以上付与者のみ
      obligationTargets.push({ w, start: latest.grantDate, grantDays })
    }
    /** 付与日の月〜今月（年5日義務で P を数える範囲） */
    const obligationYms = new Set<string>()
    {
      const endYm2 = todayIsoForVisa.slice(0, 7).replace('-', '')
      for (const t of obligationTargets) {
        let cur = t.start.slice(0, 7).replace('-', '')
        while (cur <= endYm2) {
          obligationYms.add(cur)
          const y2 = Number(cur.slice(0, 4)); const m2 = Number(cur.slice(4, 6))
          cur = m2 === 12 ? `${y2 + 1}01` : `${y2}${String(m2 + 1).padStart(2, '0')}`
        }
      }
    }

    // 先読み対象（2026-10-01 見直し: 実際に読む月だけ・全部を最初に並列で）:
    //   期間・遡り3ヶ月（概算売上の単価と前月比）・前日の月・欠勤届の範囲（7日前〜30日先）・年5日義務の範囲。
    //   旧: 未使用だった出勤率6ヶ月・FY推移・前年同期まで読み、年5日義務の月は最後に直列で読んでいた
    {
      const warm = new Set<string>([ym])
      for (const x of buildYMList(period, baseY, baseM)) warm.add(ymKey(x.y, x.m))
      const earliest = buildYMList(period, baseY, baseM).map(x => ymKey(x.y, x.m)).sort()[0]
      let wy = parseInt(earliest.slice(0, 4)), wm = parseInt(earliest.slice(4, 6))
      for (let i = 0; i < 3; i++) { wm--; if (wm < 1) { wm = 12; wy-- }; warm.add(ymKey(wy, wm)) }
      const yIso = addDaysIso(todayIsoForVisa, -1)
      warm.add(yIso.slice(0, 7).replace('-', ''))
      for (const iso of [addDaysIso(todayIsoForVisa, -7), todayIsoForVisa, addDaysIso(todayIsoForVisa, 30)]) {
        warm.add(iso.slice(0, 7).replace('-', ''))
      }
      for (const m of obligationYms) warm.add(m)
      for (const m of warm) void loadAtt(m)
    }

    // leaveRequests は1回だけ全件読む（承認待ち件数もここから数える。2026-10-01: 旧は pending 絞り込みと全件の2回読み）
    //   出面の先読み・homeLongLeave と並列で走らせる
    const leaveReqDocsP = getDocs(collection(db, 'leaveRequests')).then(s => s.docs).catch(() => null)

    // homeLongLeave はこのハンドラ内の3箇所が使う → 1回だけ読んで使い回す（性能改善 2026-07-09）
    let hlAllDocs: Awaited<ReturnType<typeof getDocs>>['docs'] = []
    try { hlAllDocs = (await getDocs(collection(db, 'homeLongLeave'))).docs } catch { /* 読取失敗時は空 */ }

    // ═══ Build YM list for the selected period ═══
    const ymListObj = buildYMList(period, baseY, baseM)
    const ymStrList = ymListObj.map(x => ymKey(x.y, x.m))

    // ═══ Load all months' attendance data at once ═══
    const mergedAtt = await loadMulti(ymStrList)

    // ═══ Run compute() for the full period ═══
    //   ダッシュボードが返すのは人工・売上・日別人数だけで、原価（cost）は返さない。
    //   2026-10-01: 実支給ベースの原価上書き（applyPayrollCosts＝computeMonthly＋手当計算）は
    //   応答に出ない値のための計算だったので外した（原価は原価・収益ページ /api/cost 側で計算する）
    const c = compute(main, mergedAtt.d, mergedAtt.sd, ymListObj)

    // ═══ Determine which sites to include ═══
    // Exclude yaesu_night only if it has zero data
    const HIDDEN_CANDIDATES = new Set(['yaesu_night'])
    const hiddenSiteIds = new Set<string>()
    for (const hid of HIDDEN_CANDIDATES) {
      const sd = c.sites[hid]
      if (!sd || (sd.work === 0 && sd.subWork === 0)) {
        hiddenSiteIds.add(hid)
      }
    }

    // アーカイブ済みサイトはデータがある場合のみ含める
    const filteredSites = main.sites.filter(s => {
      if (hiddenSiteIds.has(s.id)) return false
      if (s.archived) {
        const sd = c.sites[s.id]
        if (!sd || (sd.work === 0 && sd.subWork === 0)) return false
      }
      return true
    })

    // ═══ Load extra att data for getAvgRevenuePerEquiv lookback (3 months before earliest month) ═══
    const earliestYm = ymStrList.slice().sort()[0]
    const lookbackYms: string[] = []
    {
      let ly = parseInt(earliestYm.slice(0, 4))
      let lm = parseInt(earliestYm.slice(4, 6))
      for (let i = 0; i < 3; i++) {
        lm--
        if (lm < 1) { lm = 12; ly-- }
        const lStr = ymKey(ly, lm)
        if (!ymStrList.includes(lStr)) lookbackYms.push(lStr)
      }
    }
    const lookbackAtt = lookbackYms.length > 0 ? await loadMulti(lookbackYms) : { d: {}, sd: {}, perMonth: new Map() as Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }> }
    // Merge lookback att with main att for getAvgRevenuePerEquiv
    const allAttD = { ...mergedAtt.d, ...lookbackAtt.d }
    const allAttSD = { ...mergedAtt.sd, ...lookbackAtt.sd }

    // ═══ Billing totals per site across all months (with estimation) ═══
    // 現場ごとに「実売上があればそちら、なければ概算」で計算
    // → 売上データが入力されるたびに概算から実数字に置き換わり、精度が上がる
    const siteBillingMap = new Map<string, number>()
    let totalBilling = 0
    // 全現場の平均単価は月ごとに同じ値（純粋関数）→ 現場ごとに再計算せず月単位でメモする（2026-10-01 高速化）
    const avgAllMemo = new Map<string, number | null>()
    const avgAllFor = (ymStr: string) => {
      if (!avgAllMemo.has(ymStr)) avgAllMemo.set(ymStr, getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr))
      return avgAllMemo.get(ymStr)!
    }
    for (const ymStr of ymStrList) {
      for (const site of filteredSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const actualBill = getBillTotal(main, site.id, ymStr)
        if (actualBill > 0) {
          // 実売上データあり → そのまま使用
          siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + actualBill)
          totalBilling += actualBill
        } else {
          // 実売上なし → 鳶換算人工 × 平均単価で概算
          const mY = parseInt(ymStr.slice(0, 4))
          const mM = parseInt(ymStr.slice(4, 6))
          const te = calcTobiEquiv(main, mergedAtt.d, mergedAtt.sd, [{ y: mY, m: mM }], site.id)
          if (te.equiv > 0) {
            // 出面データがある場合のみ概算（出面もなければ0）
            const avgSite = getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr, site.id)
            const avgAll = avgSite === null ? avgAllFor(ymStr) : null
            const rates = getSiteRates(main, site.id, ymStr)
            const unitPrice = avgSite || avgAll || rates.tobiBase
            const estimated = Math.round(te.equiv * unitPrice)
            siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + estimated)
            totalBilling += estimated
          }
        }
      }
    }

    // ═══ Compute totals (site-filtered) ═══
    let totalWork: number, totalSubWork: number
    if (siteFilter !== 'all') {
      const sd = c.sites[siteFilter] || { work: 0, subWork: 0 }
      totalWork = sd.work
      totalSubWork = sd.subWork
    } else {
      totalWork = c.totalWork
      totalSubWork = c.totalSubWork
    }
    const totalManDays = totalWork + totalSubWork

    // ═══ Previous month same-day comparison (前月同日比) ═══
    // 当月8日なら、前月1〜8日の人工数と比較（進捗ペースの比較）
    const prevYmDate = new Date(baseY, baseM - 2, 1)
    const prevYm = ymKey(prevYmDate.getFullYear(), prevYmDate.getMonth() + 1)
    let prevTotalManDays = 0
    try {
      const prevAtt = await loadAtt(prevYm)  // 遡り3ヶ月で先読み済み（同じメモ）

      // 前月同日比: 前月の1日〜当日の日付までの出面データのみ集計
      // 2026-05-12 修正: Vercel(UTC) 環境で JST 早朝の日付ずれを防止
      // 2026-10-01 修正: 当月を見ているときだけ「今日の日付まで」で比べる。過ぎた月は前月の1か月分と比べる
      //   （旧: 過去月でも今日の日付で前月を切っていたため、10/1 に9月を見ると「8月1日分」と比べて +3418% と出た）
      const sameDayLimit = ym === currentYmJst() ? getJstNow().getDate() : 31 // 当月の日付（例: 8日なら8）
      const filteredPrevD: Record<string, AttendanceEntry> = {}
      const filteredPrevSD: Record<string, { n: number; on: number }> = {}
      for (const [k, v] of Object.entries(prevAtt.d)) {
        if (!v) continue
        const pk = parseDKey(k)
        if (parseInt(pk.day) <= sameDayLimit) {
          filteredPrevD[k] = v
        }
      }
      for (const [k, v] of Object.entries(prevAtt.sd)) {
        if (!v) continue
        const pk = parseDKey(k)
        if (parseInt(pk.day) <= sameDayLimit) {
          filteredPrevSD[k] = v
        }
      }

      const prevC = compute(main, filteredPrevD, filteredPrevSD, [{ y: prevYmDate.getFullYear(), m: prevYmDate.getMonth() + 1 }])
      let pWork = 0, pSubWork = 0
      for (const site of filteredSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const sd = prevC.sites[site.id]
        if (!sd) continue
        pWork += sd.work
        pSubWork += sd.subWork
      }
      prevTotalManDays = pWork + pSubWork
    } catch {
      // No previous month data
    }

    // pctWork = month-over-month change in totalManDays
    const pctWork = prevTotalManDays > 0
      ? ((totalManDays - prevTotalManDays) / prevTotalManDays) * 100 : 0

    // 2026-10-01: 画面に出ない KPI（人工あたり売上・労務費・利益率など）・年度推移・前年同期比・予測・
    //   外注分析・現場別推移・外国人の出勤率はここで計算していたが、応答に入らない／画面で使わないので削除。
    //   分析は原価・収益ページ（/api/cost）にある

    // ═══ Yesterday's status ═══
    // 2026-05-09 変更: 旧運用は朝に職長が一括入力していたため「本日」の稼働状況が
    //   有用だったが、新運用は実習生が作業終わりに自己入力するため「前日」のデータを
    //   見るほうが確定情報として意味がある。
    //   フィールド名 todayStatus はクライアント影響を抑えるため維持。
    // 2026-05-12 修正: Vercel(UTC) で JST 早朝〜午前中アクセス時に「前日」が1日前にずれて
    //   日曜=無データ判定で空表示になっていた。JST 基準で計算するよう修正。
    const now = getJstNow()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const targetYm = ymKey(yesterday.getFullYear(), yesterday.getMonth() + 1)
    const targetDay = yesterday.getDate()
    let todayStatus = null
    try {
      const targetAtt = await loadAtt(targetYm)  // 先読み済み（同じメモ）

      // homeLongLeave コレクションから approved & 前日期間内のワーカーIDを集める
      const targetDateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
      const hlOnLeaveWorkerIds = new Set<number>()
      try {
        hlAllDocs.forEach(d => {
          const v = d.data() as { workerId?: number; status?: string; startDate?: string; endDate?: string }
          if (v.status === 'approved' && v.startDate && v.endDate
              && v.startDate <= targetDateStr && targetDateStr <= v.endDate
              && typeof v.workerId === 'number') {
            hlOnLeaveWorkerIds.add(v.workerId)
          }
        })
      } catch { /* ignore */ }

      todayStatus = computeTodayStatus(main, targetAtt.d, targetAtt.sd, targetYm, targetDay, hiddenSiteIds, hlOnLeaveWorkerIds)
    } catch {
      todayStatus = { siteStatus: [], absentWorkers: [] }
    }

    // ═══ Daily attendance from c.daily and c.dailySite ═══
    const currentMonthYm = ym
    const y2 = parseInt(currentMonthYm.slice(0, 4))
    const m2 = parseInt(currentMonthYm.slice(4, 6))
    const daysInMonth = new Date(y2, m2, 0).getDate()
    const dailyAttendance: { day: number; sites: { siteId: string; siteName: string; count: number }[] }[] = []

    for (let d = 1; d <= daysInMonth; d++) {
      const daySites: { siteId: string; siteName: string; count: number }[] = []
      for (const site of filteredSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const dsKey = `${currentMonthYm}_${d}_${site.id}`
        const count = c.dailySite[dsKey] || 0
        if (count > 0) {
          daySites.push({ siteId: site.id, siteName: site.name, count })
        }
      }
      dailyAttendance.push({ day: d, sites: daySites })
    }

    // ═══ Site list for tab selector ═══
    // Include archived sites only if they have data in the period
    const archivedSitesWithData = new Set<string>()
    for (const site of filteredSites) {
      if (site.archived) {
        const sd = c.sites[site.id]
        if (sd && (sd.work > 0 || sd.subWork > 0)) {
          archivedSitesWithData.add(site.id)
        }
        // Also check billing
        const bill = siteBillingMap.get(site.id) || 0
        if (bill > 0) archivedSitesWithData.add(site.id)
      }
    }

    const siteList = filteredSites
      .filter(s => !s.archived || archivedSitesWithData.has(s.id))
      .map(s => ({ id: s.id, name: s.name + (s.archived ? '（終了）' : '') }))

    // ═══ Action Items (要対応まとめ) ═══
    // 1. Visa expiry within 90 days
    const todayDate = getJstNow()
    todayDate.setHours(0, 0, 0, 0)
    const visaExpiryItems: { name: string; daysLeft: number; expiry: string }[] = []
    // 2026-06-XX 修正: 今日時点で退職済みのみ除外（todayIsoForVisa は先頭で確定済み）
    for (const w of main.workers) {
      if (isAlreadyRetired(w.retired, todayIsoForVisa)) continue
      if (!w.visa || w.visa === 'none' || w.visa === '') continue
      const expiry = w.visaExpiry
      if (!expiry) continue
      const expiryDate = new Date(expiry)
      if (isNaN(expiryDate.getTime())) continue
      const daysLeft = Math.ceil((expiryDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24))
      if (daysLeft <= 90) {
        visaExpiryItems.push({ name: w.name, daysLeft, expiry })
      }
    }
    visaExpiryItems.sort((a, b) => a.daysLeft - b.daysLeft)

    // 2. PL 5-day shortfall (法定5日義務)
    // ⚠️ 2026-08-21 全面修正（有給総点検の横展開）。旧実装は2点間違っていた:
    //   ① used をレコードの used フィールドから読んでいた → 消化は出面のPから動的計算する
    //      設計なので used はほぼ常に0 → 「全員5日未消化」と判定し、実際は5名なのに
    //      22名と表示していた（オオカミ少年化してアラートが機能していなかった）
    //   ② 付与直後でも即警告していた → 5日義務は「付与から1年以内」に取ればよいので、
    //      期限まで余裕がある人を今すぐ対応リストに入れるのは誤り
    //   正: 出面のPから期間内消化を数え、judgeFiveDayObligation（通知ベル・有給画面と同一）で判定
    let plShortfallCount = 0
    const plShortfallNames: string[] = []
    // ── 対象者と付与期間はハンドラ先頭で確定済み（obligationTargets / obligationYms）。表示期間外の出面を追加ロードする ──
    // 2026-08-27 修正（有給総点検・第3回）: allAttD は「表示期間+遡り3ヶ月」しか
    //   持たないため、付与から半年以上前に取った P が数えられず、実際は取得済みでも
    //   「5日未達」と誤警告していた（2026-08-21 修正①のオオカミ少年化が別経路で再発）。
    //   付与期間のうち未ロードの月だけを一括で追加ロードする（最大12ヶ月・月次表示時のみ増加）
    const loadedYms = new Set([...ymStrList, ...lookbackYms])
    const extraYms = [...obligationYms].filter(m => !loadedYms.has(m))
    const extraAttD = extraYms.length > 0
      ? (await loadMulti(extraYms)).d  // 先頭で先読み済み（同じメモ）なので待ちはほぼ無い
      : {}
    const attForObligation = { ...allAttD, ...extraAttD }

    // 出面の P を「スタッフ → 日付の集合」に1回だけまとめる（旧: 対象者ごとに全件を走査していた。結果は同じ）
    const pDatesByWid = new Map<number, Set<string>>()
    for (const [key, entry] of Object.entries(attForObligation)) {
      const e = entry as { p?: number | boolean } | null
      if (!e?.p) continue
      const pk = parseDKey(key)
      const wid = parseInt(pk.wid)
      const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
      let set = pDatesByWid.get(wid)
      if (!set) { set = new Set<string>(); pDatesByWid.set(wid, set) }
      set.add(iso)
    }

    for (const { w, start, grantDays } of obligationTargets) {
      // 期間 [grantDate, +1年) の P 日数を出面から数える（同日複数現場は1日）
      const end = addMonthsSafe(start, 12)
      const seen = new Set<string>()
      for (const iso of pDatesByWid.get(w.id) || []) {
        if (iso >= start && iso < end) seen.add(iso)
      }
      // 消化 = 出面の P のみ（/leave 画面の judgeFiveDayObligation 入力と統一。
      //   旧: adjustment を足していたが、移行時調整は「取得させた日数」ではないため
      //   経路間で警告の有無が食い違っていた。少なく数える方＝警告が出る方に倒す）
      const periodUsed = seen.size

      const judged = judgeFiveDayObligation(start, grantDays, periodUsed, w.retired, todayIsoForVisa,
        { isJp: !w.visa || w.visa === 'none' })
      if (judged.warning) {
        plShortfallCount++
        plShortfallNames.push(`${w.name}(残${judged.shortfall}日)`)
      }
    }

    // 3. Pending leave requests
    //    件数は全件読みの結果から数える（旧: where status=='pending' で別に読んでいた。同じ数）
    const leaveReqDocs = await leaveReqDocsP
    const pendingLeaveCount = leaveReqDocs ? leaveReqDocs.filter(d => d.data().status === 'pending').length : 0

    // 4. Calendar progress — placeholder
    const calPending = 0
    const calTotal = 0

    // 5. 有給申請一覧（pending + foreman_approved）をダッシュボードに返す
    //    各申請に「該当現場の職長名」を埋めて返す（UI のボタン表示用）
    const leaveRequestItems: { id: string; workerName: string; date: string; siteId: string; reason: string; status: string; requestedAt: string; foremanApprovedAt?: string; siteForemanName?: string }[] = []
    try {
      if (!leaveReqDocs) throw new Error('leaveRequests read failed')
      leaveReqDocs.forEach(d => {
        const data = d.data()
        if (data.status === 'pending' || data.status === 'foreman_approved') {
          // 該当現場の職長を解決（月別オーバーライド優先）
          const siteId = data.siteId || ''
          const ym = data.date ? String(data.date).slice(0, 7).replace('-', '') : ''
          const override = ym && main.mforeman ? main.mforeman[`${siteId}_${ym}`]?.wid : undefined
          const siteForemanId = override ?? main.sites.find(s => s.id === siteId)?.foreman
          const siteForemanName = siteForemanId != null
            ? (main.workers.find(w => w.id === siteForemanId)?.name || '')
            : ''
          leaveRequestItems.push({
            id: d.id,
            workerName: data.workerName || '',
            date: data.date || '',
            siteId,
            reason: data.reason || '',
            status: data.status,
            requestedAt: data.requestedAt || '',
            foremanApprovedAt: data.foremanApprovedAt,
            siteForemanName,
          })
        }
      })
      leaveRequestItems.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    } catch { /* ignore */ }

    // 6. 欠勤届データ（過去7日 + 本日）
    const absenceReports: { workerName: string; date: string; reason: string; reasonLabel: string; note?: string }[] = []
    const reasonLabels: Record<string, string> = {
      sick: '体調不良', hospital: '通院', personal: '私用',
      family: '家族の事情', homeCountry: '帰国関連', other: 'その他',
    }
    try {
      // 2026-08-27 修正（休暇届総点検）:
      //   ① 比較を日付文字列に統一（旧: 時刻付き Date 比較で「ちょうど7日前」が常に漏れ、
      //     実質6日分だった）
      //   ② 未来日の欠勤届（事前届・2026-07-30 実装）も表示対象に追加（30日先まで）。
      //     旧: 未来日は除外され、事前に届を出しても管理者が当日まで気づけなかった
      const { todayJstIso, addDaysIso } = await import('@/lib/date-utils')
      const todayIsoAb = todayJstIso()
      const fromIso = addDaysIso(todayIsoAb, -7)
      const toIso = addDaysIso(todayIsoAb, 30)

      // 過去7日〜30日先にかかる月をカバー
      const monthsToCheck = new Set<string>([
        fromIso.slice(0, 7).replace('-', ''),
        todayIsoAb.slice(0, 7).replace('-', ''),
        toIso.slice(0, 7).replace('-', ''),
      ])

      for (const checkYm of monthsToCheck) {
        const attDoc = await loadAtt(checkYm)
        for (const [key, entry] of Object.entries(attDoc.d)) {
          if (!entry || !entry.r || entry.r !== 1 || !entry.rReason) continue
          const pk = parseDKey(key)
          const entryIso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
          if (entryIso < fromIso || entryIso > toIso) continue
          const entryDate = new Date(entryIso + 'T00:00:00')

          const wid = parseInt(pk.wid)
          const worker = main.workers.find(w => w.id === wid)
          if (!worker) continue

          const dateStr = `${entryDate.getFullYear()}-${String(entryDate.getMonth() + 1).padStart(2, '0')}-${String(entryDate.getDate()).padStart(2, '0')}`
          absenceReports.push({
            workerName: worker.name,
            date: dateStr,
            reason: entry.rReason,
            reasonLabel: reasonLabels[entry.rReason] || entry.rReason,
            note: entry.rNote,
          })
        }
      }
      absenceReports.sort((a, b) => b.date.localeCompare(a.date)) // 新しい順
    } catch { /* ignore */ }

    // 7. 帰国申請一覧（pending + foreman_approved）
    //    workerName は人員マスタから都度ルックアップ（改名追従のため）
    //    siteForemanName は対象スタッフの現在配置現場の職長名を引く（ボタン表示用）
    const homeLongLeaveItems: { id: string; workerName: string; startDate: string; endDate: string; reason: string; status: string; requestedAt: string; foremanApprovedAt?: string; siteForemanName?: string }[] = []
    const resolveWorkerForemanName = (workerId: number): string => {
      // 当月の配置現場（massign 優先、なければ assign）から最初の現場を引き、その職長名を返す
      for (const site of main.sites) {
        if (site.archived) continue
        const monthKey = `${site.id}_${ym}`
        const monthAssign = main.massign?.[monthKey]
        const defaultAssign = main.assign?.[site.id]
        const workers = (monthAssign?.workers || defaultAssign?.workers || []) as number[]
        if (workers.includes(workerId)) {
          const override = main.mforeman?.[monthKey]?.wid
          const fid = override ?? site.foreman
          if (fid != null) {
            return main.workers.find(w => w.id === fid)?.name || ''
          }
        }
      }
      return ''
    }
    try {
      hlAllDocs.forEach(d => {
        const data = d.data()
        if (data.status === 'pending' || data.status === 'foreman_approved') {
          const fresh = main.workers.find(w => w.id === data.workerId)?.name
          homeLongLeaveItems.push({
            id: d.id,
            workerName: fresh || data.workerName || '',
            startDate: data.startDate || '',
            endDate: data.endDate || '',
            reason: data.reason || '',
            status: data.status,
            requestedAt: data.requestedAt || '',
            foremanApprovedAt: data.foremanApprovedAt,
            siteForemanName: resolveWorkerForemanName(data.workerId),
          })
        }
      })
      homeLongLeaveItems.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    } catch { /* ignore */ }

    // 8. 帰国情報（現在帰国中・予定）
    // 2026-05-13: homeLongLeave コレクションを単一ソースとして集計
    //   旧 demmen/main.homeLeaves 配列の参照は廃止（dual storage 問題解消）
    let homeLeaveCurrentCount = 0
    let homeLeaveUpcomingCount = 0
    let pendingHomeLeaveApprovalCount = 0
    try {
      // JST基準で今日の日付を計算（Vercelサーバーは UTC のため補正）
      const nowUtc = new Date()
      const jst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000)
      const todayIso = jst.toISOString().slice(0, 10)
      const futureLimit = new Date(jst)
      futureLimit.setMonth(futureLimit.getMonth() + 6)
      const futureIso = futureLimit.toISOString().slice(0, 10)

      hlAllDocs.forEach(d => {
        const data = d.data()
        if (!data.startDate || !data.endDate) return
        if (data.status === 'approved' || data.status === 'foreman_approved') {
          if (data.startDate <= todayIso && data.endDate >= todayIso) homeLeaveCurrentCount++
          else if (data.startDate > todayIso && data.startDate <= futureIso) homeLeaveUpcomingCount++
        }
        if (data.status === 'pending' || data.status === 'foreman_approved') {
          pendingHomeLeaveApprovalCount++
        }
      })
    } catch { /* ignore */ }

    // 9. 半自動付与対象者カウント（休暇管理API のロジック簡易版を再現）
    let pendingGrantsCount = 0
    let carryOverExpiringCount = 0
    try {
      const todayD = getJstNow()
      todayD.setHours(0, 0, 0, 0)
      const todayIsoP = todayJstIso()  // 2026-08-27: getJstNow+toISOString はローカルJST機で1日ズレる
      const m = todayD.getMonth() + 1
      const y = todayD.getFullYear()

      // 2026-06-XX 修正: 今日時点で退職済みのみ除外（未来日退職予定者は付与候補）
      for (const w of main.workers) {
        if (isAlreadyRetired(w.retired, todayIsoP)) continue
        if (w.job === 'yakuin' || w.job === 'jimu') continue

        const records = main.plData[String(w.id)] || []
        const isJp = !w.visa || w.visa === 'none'

        // 付与時期チェック
        // 2026-08-27 修正（有給総点検・第3回）: 判定を休暇管理API（getPendingGrants）と同期。
        //   旧: ±7日近傍判定のため、年途中入社の日本人（初回付与が10/1以外）が
        //   10/1以降ずっと「付与待ち」にカウントされ、/leave 画面(0件)と食い違っていた。
        //   新: 前回付与日から jpNextGrantAfter で次回（前倒し合流）を導出し、
        //   「次回日以降の付与レコードが無い」ことで判定する
        if (isJp) {
          const effD = (r: (typeof records)[number]): string =>
            (r.grantDate as string | undefined) || (r.fy !== undefined && r.fy !== null ? `${r.fy}-10-01` : '')
          const grantedRecs = records.filter(r =>
            (((r.grantDays as number | undefined) ?? (r.grant as number | undefined) ?? 0) > 0))
          const latestG = grantedRecs.map(effD).filter(Boolean).sort().slice(-1)[0] || null
          const curFy = m >= 10 ? y : y - 1
          // 初回は「10/1」と「入社＋6ヶ月」の遅いほう（休暇管理 /api/leave の getPendingGrants と同じ・労基法39条1項）。
          //   2026-10-02: 旧は 10/1 固定で、入社6ヶ月前の人・入社前の人（10/26 入社のホアンさん）まで付与待ちに数えていた
          const fyGrant = `${curFy}-10-01`
          const hirePlus6 = w.hireDate ? addMonthsSafe(w.hireDate, 6) : ''
          const expDate = latestG ? jpNextGrantAfter(latestG).grantDate : (hirePlus6 && hirePlus6 > fyGrant ? hirePlus6 : fyGrant)
          if (expDate <= todayIsoP) {
            const hasGrant = grantedRecs.some(r => effD(r) >= expDate)
            if (!hasGrant) pendingGrantsCount++
          }
        } else {
          // 外国人: 最新grantDate+1年
          // ⚠️ ここは selectActiveGrantRecord に置き換えないこと。
          //   「次の付与時期が来ているか」の判定なので、**未来の付与レコードも含めた最新**を
          //   見る必要がある。未来を除外すると「もう次期を付与済み」を検出できず、
          //   付与漏れアラートが誤って出続ける。
          const granted = records.filter(r => r.grantDate && (((r.grantDays as number | undefined) ?? 0) > 0 || ((r.grant as number | undefined) ?? 0) > 0))
            .sort((a, b) => new Date(a.grantDate as string).getTime() - new Date(b.grantDate as string).getTime())
          const latest = granted[granted.length - 1]
          if (latest && latest.grantDate) {
            // 1年後の応当日（旧: +365日でうるう年をまたぐと1日早かった）
            const nextIso = addMonthsSafe((latest.grantDate as string).slice(0, 10), 12)
            if (nextIso <= todayIsoP) {
              // 次回予定日以降の付与があれば付与済み（±7日判定は別日付の付与を取りこぼす）
              const hasGrant = records.some(r => {
                if (!r.grantDate) return false
                if (!(((r.grantDays as number | undefined) ?? 0) > 0 || ((r.grant as number | undefined) ?? 0) > 0)) return false
                return (r.grantDate as string) >= nextIso
              })
              if (!hasGrant) pendingGrantsCount++
            }
          }
        }

        // 繰越時効チェック (前期grantDate+2年が3ヶ月以内)
        const sortedRecords = records
          .filter(r => !(r as { _archived?: boolean })._archived)  // 時効処理済みを前期候補から除外（2026-08-17）
          .filter(r => r.grantDate && (((r.grantDays as number | undefined) ?? 0) > 0 || ((r.grant as number | undefined) ?? 0) > 0))
          .sort((a, b) => new Date(a.grantDate as string).getTime() - new Date(b.grantDate as string).getTime())
        if (sortedRecords.length >= 2) {
          const prev = sortedRecords[sortedRecords.length - 2]
          const cur = sortedRecords[sortedRecords.length - 1]
          const prevGrant = prev.grantDate as string
          const prevLastUsable = calcLastUsableDayIso(prevGrant)
          // 未時効かつ最終利用可能日まで90日以内
          const stillValid = !isLeaveExpiredAsOf(prevGrant, todayIsoP)
          if (stillValid && daysBetween(todayIsoP, prevLastUsable) <= 90) {
            // 前期に未消化の繰越が残っているか簡易チェック
            const curCarry = (cur.carryOver as number | undefined) ?? (cur.carry as number | undefined) ?? 0
            if (curCarry > 0) carryOverExpiringCount++
          }
        }
      }
    } catch { /* ignore */ }

    // ═══ 静かな異常の検出（2026-08-21 追加 / ダッシュボード第1弾） ═══
    // 「件数として目立たないが、放置すると給与に効く」問題を毎日拾う。
    // 今回の帰国期間ズレ（フン: 基本給 63,888円 の過少支給）は月次で人が気づいたが、
    // 検出ロジックはすべて実装済みなので、ここに集めて日次で見えるようにする。
    // compute() の結果を再利用するだけなので Firestore の読み取りは増えない。
    interface PayrollLite {
      id: number
      name: string
      job?: string
      retired?: string
      hkDays?: number
      lateNightRiskDays?: number
      legalShortfall?: number
      sundayNoRestDays?: number[]
      hkEarlyReturnDays?: number
      hkEarlyReturnFirstDate?: string
    }
    interface QuietIssue {
      kind: 'nightUnregistered' | 'legalShortfall' | 'sundayNoRest' | 'earlyReturn' | 'staleAttendance'
        | 'wageRevisionPending' | 'staleAssignment'
      workerName: string
      detail: string
      href: string
    }
    const quietIssues: QuietIssue[] = []
    const nowYm = currentYmJst()
    try {
      // 給与明細レベルの検出（法定割れ・夜勤未登録・早期復帰）は computeMonthly が必要。
      // ⚠️ 読み取りを増やさないため **当月を表示しているときだけ** 走らせる。
      //    過去月の閲覧では検出をスキップする（過去は月次集計画面で確認する運用）。
      const payrollWorkers: PayrollLite[] = []
      if (ym === nowYm) {
        const { computeMonthly } = await import('@/lib/compute')
        const { getMonthlyCalendars } = await import('@/lib/repositories/calendarRepo')
        const attNow = await loadAtt(ym)
        const siteWorkDaysMap = main.siteWorkDays?.[ym] || {}
        const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
        const cals = await getMonthlyCalendars(`${ym.slice(0, 4)}-${ym.slice(4, 6)}` as Parameters<typeof getMonthlyCalendars>[0])
        const calendarDaysMap: Record<string, Record<string, string>> = {}
        for (const cal of cals) if (cal.days) calendarDaysMap[cal.siteId] = cal.days
        // 帰国情報は先頭で読んだ homeLongLeave（hlAllDocs）から作る（getAllActiveHomeLeaves と同じ条件:
        //   最終承認済み approved・開始日と終了日あり）。2026-10-01: 旧は同じコレクションをここで読み直していた
        const homeLeavesNow: HomeLeaveEntry[] = []
        for (const d of hlAllDocs) {
          const hl = d.data() as { workerId: number; status?: string; startDate?: string; endDate?: string }
          if (hl.status !== 'approved') continue
          if (!hl.startDate || !hl.endDate) continue
          homeLeavesNow.push({ workerId: hl.workerId, startDate: hl.startDate, endDate: hl.endDate })
        }
        const mres = computeMonthly(
          main, attNow.d, attNow.sd, ym, main.workDays[ym] || 0,
          Object.keys(siteWorkDaysMap).length > 0 ? siteWorkDaysMap : undefined,
          baseDays, calendarDaysMap, homeLeavesNow,
        )
        payrollWorkers.push(...(mres.workers as unknown as PayrollLite[]))
      }

      for (const w of payrollWorkers) {
        if ((w.lateNightRiskDays || 0) > 0) {
          quietIssues.push({
            kind: 'nightUnregistered',
            workerName: w.name,
            detail: `22時超の労働が夜勤未登録 ${w.lateNightRiskDays}日`,
            href: `/attendance?ym=${ym}`,
          })
        }
        if ((w.legalShortfall || 0) > 0) {
          quietIssues.push({
            kind: 'legalShortfall',
            workerName: w.name,
            detail: `夜勤の法定割増が ¥${(w.legalShortfall || 0).toLocaleString()} 不足`,
            href: `/monthly?ym=${ym}`,
          })
        }
        if ((w.sundayNoRestDays?.length || 0) > 0) {
          quietIssues.push({
            kind: 'sundayNoRest',
            workerName: w.name,
            detail: `休みの無い週の日曜出勤 ${(w.sundayNoRestDays || []).join('・')}日（法定休日の割増が必要になり得る。振替休日を検討）`,
            href: `/monthly?ym=${ym}`,
          })
        }
        if ((w.hkEarlyReturnDays || 0) > 0) {
          quietIssues.push({
            kind: 'earlyReturn',
            workerName: w.name,
            detail: `帰国申請より早く復帰（${w.hkEarlyReturnFirstDate} から出勤）。申請の最終帰国日を直す`,
            href: '/leave?tab=homeleave',
          })
        }
      }

      // 賃金改定の予定が実施日を過ぎているのに人員マスタへ未反映
      //
      // ⚠️ 個人の賃金額を含むため **代表のみ** に返す。ダッシュボードは職長も見るので、
      //    ここで絞らないと他者の時給が漏れる。閲覧先の /wage-analysis も代表専用。
      // 追加の Firestore 読み取りは発生しない（main は取得済み、認証は60秒キャッシュ）。
      {
        const auth = await getApiAuthUser(request)
        const isOwner = auth.authorized && (auth.actor === 0 || auth.actor === 'super-admin')
        if (isOwner) {
          const { SCHEDULED_WAGE_CHANGES } = await import('@/lib/wage-curve')
          const todayIso = todayJstIso()
          for (const c of SCHEDULED_WAGE_CHANGES) {
            if (c.effective > todayIso) continue  // まだ実施日前
            for (const [idStr, planned] of Object.entries(c.targets)) {
              const wm = main.workers.find(x => x.id === Number(idStr))
              if (!wm || wm.retired) continue
              const cur = Number((wm as { hourlyRate?: number }).hourlyRate || 0)
              if (cur >= planned) continue  // 反映済み
              quietIssues.push({
                kind: 'wageRevisionPending',
                workerName: wm.name,
                detail: `${c.effective} の${c.label}が未反映（¥${cur.toLocaleString()} → ¥${planned.toLocaleString()}）`,
                href: '/wage-analysis',
              })
            }
          }
        }
      }

      // 出面が数日入っていないスタッフ（当月・稼働中の人だけ。直近5日で1件も入力が無い）
      // ※ 当月を表示しているときだけ意味があるので、過去月を見ているときは出さない
      if (ym === nowYm) {
        const todayD = todayJstDate()
        const recentIso: string[] = []
        for (let i = 1; i <= 5; i++) {
          const d = new Date(todayD)
          d.setDate(d.getDate() - i)
          if (d.getDay() === 0) continue // 日曜は除く
          recentIso.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
        }
        if (recentIso.length > 0) {
          const seenByWorker = new Map<number, number>()
          for (const [key, entry] of Object.entries(allAttD)) {
            if (!entry) continue
            const pk = parseDKey(key)
            const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
            if (!recentIso.includes(iso)) continue
            const wid = parseInt(pk.wid)
            seenByWorker.set(wid, (seenByWorker.get(wid) || 0) + 1)
          }
          for (const w of payrollWorkers) {
            if (w.job === 'jimu' || w.job === 'yakuin') continue // 事務・役員は出面対象外
            if ((w.hkDays || 0) > 0) continue                    // 帰国中は入力が無くて当然
            // 在籍していた日だけで数える（2026-10-02 代表指摘: 10/26 入社のホアンさんに10月初めから出ていた）。
            //   月次集計は入社月・退職月の人を含めるので、ここで日単位に絞る（入社日・退職日は人員マスタから。
            //   旧の isAlreadyRetired(w.retired) は月次集計の行に retired が無く、効いていなかった）
            const raw = main.workers.find(x => x.id === w.id)
            const daysSinceHire = recentIso.filter(iso => !raw || isEmployedOn(raw, iso))
            if (daysSinceHire.length === 0) continue
            if ((seenByWorker.get(w.id) || 0) > 0) continue
            quietIssues.push({
              kind: 'staleAttendance',
              workerName: w.name,
              detail: `直近${daysSinceHire.length}稼働日に出面の入力がありません`,
              href: `/attendance?ym=${ym}`,
            })
          }
        }
      }
      // 配置の見直し（2026-10-01 代表決定）: 現場を移動したのに前の現場の配置に残っている人。
      //   当月表示のときだけ。出面は上で読んだ allAttD（表示月＋遡り3か月）を使い、読み取りを増やさない
      if (ym === nowYm) {
        const { findStaleAssignments } = await import('@/lib/foreman-todo')
        for (const s of findStaleAssignments(main, allAttD as never, todayJstIso())) {
          quietIssues.push({
            kind: 'staleAssignment',
            workerName: s.workerName,
            detail: `${s.siteName} の配置に残っています（2週間入力なし・いまは ${s.workingAt.join('・')}）`,
            href: `/attendance`,
          })
        }
      }
    } catch (e) {
      console.error('quietIssues detection error:', e)
    }

    const actionItems = {
      visaExpiry: { count: visaExpiryItems.length, items: visaExpiryItems },
      plShortfall: { count: plShortfallCount, names: plShortfallNames },
      pendingLeaveRequests: { count: pendingLeaveCount, items: leaveRequestItems },
      calendarProgress: { pending: calPending, total: calTotal },
      absenceReports,
      homeLongLeaveRequests: homeLongLeaveItems,
      // 新規追加（5月運用対応）
      homeLeaveCurrentCount,
      homeLeaveUpcomingCount,
      pendingHomeLeaveApprovalCount,
      pendingGrantsCount,
      carryOverExpiringCount,
      quietIssues: { count: quietIssues.length, items: quietIssues },
    }

    // ダッシュボードは「今の状況と要対応」に特化（詳細分析は原価・収益管理ページへ）
    return NextResponse.json({
      summary: {
        totalManDays,
        billing: totalBilling,
        prevTotalManDays,
        pctWork,
      },
      todayStatus,
      dailyAttendance,
      siteList,
      ymList: ymStrList.sort(),
      period,
      selectedYm: ym,
      actionItems,
    })
  } catch (error) {
    console.error('Dashboard API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Failed to compute dashboard data', detail: errMsg }, { status: 500 })
  }
}

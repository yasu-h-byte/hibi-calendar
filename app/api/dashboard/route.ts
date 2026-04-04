import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import {
  compute,
  getMainData,
  getAttData,
  getMultiMonthAttData,
  calcTobiEquiv,
  getSiteRates,
  getBillTotal,
  getAvgRevenuePerEquiv,
  getAssign,
  buildYMList,
  MainData,
  ComputeResult,
} from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

// --- Helpers ---

/** Compute PL alert for workers with remaining PL <= 3 */
function computePLAlert(main: MainData) {
  const alerts: {
    workerId: number; name: string; org: string
    totalDays: number; usedDays: number; remaining: number; status: string
  }[] = []

  for (const w of main.workers) {
    if (w.retired) continue
    const records = main.plData[String(w.id)] || []
    if (records.length === 0) continue

    const latest = records[records.length - 1]
    const totalDays = latest.grantDays + latest.carryOver + latest.adjustment
    const usedDays = latest.used
    const remaining = totalDays - usedDays

    if (remaining <= 3) {
      const status = remaining <= 0 ? 'danger' : remaining <= 1 ? 'warning' : 'caution'
      alerts.push({ workerId: w.id, name: w.name, org: w.org, totalDays, usedDays, remaining, status })
    }
  }

  return alerts.sort((a, b) => a.remaining - b.remaining)
}

/** Today's attendance status */
function computeTodayStatus(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  day: number,
  excludeSiteIds?: Set<string>,
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
      if (entry && entry.w === 1) {
        const worker = main.workers.find(w => w.id === wid)
        if (worker) {
          const job = worker.job || ''
          // "鳶" = tobi / shokucho / yakuin
          if (job === 'tobi' || job === 'shokucho' || job === 'yakuin') tobi++
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
  const allAssignedWorkerIds = new Set<number>()
  for (const site of activeSites) {
    const siteAssign = getAssign(main, site.id, ym)
    for (const wid of siteAssign.workers) allAssignedWorkerIds.add(wid)
  }

  for (const wid of Array.from(allAssignedWorkerIds)) {
    if (!workingWorkerIds.has(wid)) {
      const worker = main.workers.find(w => w.id === wid && !w.retired)
      if (worker) absentWorkers.push({ id: worker.id, name: worker.name })
    }
  }

  return { siteStatus, absentWorkers }
}

/** Foreign worker attendance rates - 常に過去6ヶ月分を参照、平均を下回る人のみ返す */
async function computeForeignWorkerRates(
  main: MainData,
  baseYm: string, // YYYYMM
  cachedAtt?: Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>,
) {
  const foreignWorkers = main.workers.filter(w =>
    !w.retired && w.visa && w.visa !== 'none' && w.visa !== ''
  )

  // 常に過去6ヶ月分のデータを使用
  const sixMonthList: string[] = []
  let ty = parseInt(baseYm.slice(0, 4))
  let tm = parseInt(baseYm.slice(4, 6))
  for (let i = 0; i < 6; i++) {
    sixMonthList.push(ymKey(ty, tm))
    tm--
    if (tm < 1) { tm = 12; ty-- }
  }
  sixMonthList.reverse()

  // 各月のattデータを読み込み（キャッシュ優先、未キャッシュ分は並列読み込み）
  const monthAttData: Record<string, Record<string, { w?: number; o?: number; p?: number }>> = {}
  const uncachedMonths = sixMonthList.filter(ym => !cachedAtt?.has(ym))
  const uncachedResults = await Promise.all(
    uncachedMonths.map(ym => getAttData(ym).then(att => ({ ym, d: att.d })).catch(() => ({ ym, d: {} as Record<string, AttendanceEntry> })))
  )
  for (const { ym, d } of uncachedResults) {
    monthAttData[ym] = d
  }
  for (const ym of sixMonthList) {
    if (cachedAtt?.has(ym)) {
      monthAttData[ym] = cachedAtt.get(ym)!.d
    }
  }

  // 各社員の日別出勤データを構築し、連続30日以上の無出勤期間を除外
  const allRates = foreignWorkers.map(fw => {
    // 6ヶ月分の全日について出勤有無を日付順に構築
    const dailyWork: { date: string; ym: string; day: number; worked: boolean }[] = []
    for (const ym of sixMonthList) {
      const y = parseInt(ym.slice(0, 4))
      const m = parseInt(ym.slice(4, 6))
      const dim = new Date(y, m, 0).getDate()
      const d = monthAttData[ym] || {}

      for (let day = 1; day <= dim; day++) {
        let worked = false
        for (const [k, v] of Object.entries(d)) {
          const parts = k.split('_')
          const wid = parseInt(parts[parts.length - 3])
          const entryYm = parts[parts.length - 2]
          const entryDay = parseInt(parts[parts.length - 1])
          if (wid !== fw.id || entryYm !== ym || entryDay !== day) continue
          if (v.p) continue
          if (v.w && v.w > 0) {
            const isComp = (v.w === 0.6 && fw.visa !== 'none')
            if (!isComp) worked = true
          }
        }
        dailyWork.push({ date: `${ym}${String(day).padStart(2, '0')}`, ym, day, worked })
      }
    }

    // 連続無出勤30日以上の期間を検出
    const excludedDates = new Set<string>()
    let streakStart = 0
    for (let i = 0; i <= dailyWork.length; i++) {
      if (i === dailyWork.length || dailyWork[i].worked) {
        const streakLen = i - streakStart
        if (streakLen >= 30) {
          for (let j = streakStart; j < i; j++) {
            excludedDates.add(dailyWork[j].date)
          }
        }
        streakStart = i + 1
      }
    }

    // 月別の出勤率を計算（除外日を除く）
    const monthlyRates: { ym: string; rate: number; worked: number; possible: number; excluded: boolean }[] = []
    let totalWork = 0
    let totalPossible = 0

    for (const ym of sixMonthList) {
      const workDaysInMonth = main.workDays[ym] || 22
      const d = monthAttData[ym] || {}

      let worked = 0
      let excludedDaysInMonth = 0
      const y = parseInt(ym.slice(0, 4))
      const m = parseInt(ym.slice(4, 6))
      const dim = new Date(y, m, 0).getDate()

      // 出勤カウント
      for (const [k, v] of Object.entries(d)) {
        const parts = k.split('_')
        const wid = parseInt(parts[parts.length - 3])
        const entryYm = parts[parts.length - 2]
        if (wid !== fw.id || entryYm !== ym) continue
        if (v.p) continue
        if (v.w && v.w > 0) {
          const isComp = (v.w === 0.6 && fw.visa !== 'none')
          if (!isComp) worked += v.w
        }
      }

      // この月の除外日数（営業日のみカウント）
      for (let day = 1; day <= dim; day++) {
        const dateKey = `${ym}${String(day).padStart(2, '0')}`
        if (excludedDates.has(dateKey)) {
          const dow = new Date(y, m - 1, day).getDay()
          if (dow !== 0 && dow !== 6) excludedDaysInMonth++
        }
      }

      const adjustedPossible = Math.max(0, workDaysInMonth - excludedDaysInMonth)
      const isFullyExcluded = adjustedPossible === 0
      const rawRate = adjustedPossible > 0 ? (worked / adjustedPossible) * 100 : 0
      const rate = Math.min(rawRate, 100) // 土曜出勤等で100%超にならないようキャップ

      monthlyRates.push({ ym, rate, worked, possible: adjustedPossible, excluded: isFullyExcluded })
      if (!isFullyExcluded) {
        totalWork += worked
        totalPossible += adjustedPossible
      }
    }

    const avgRate = Math.min(totalPossible > 0 ? (totalWork / totalPossible) * 100 : 0, 100)
    return { id: fw.id, name: fw.name, org: fw.org, visa: fw.visa, avgRate, monthlyRates }
  })

  // 全体平均を計算
  const ratesWithData = allRates.filter(r => r.avgRate > 0)
  const groupAvg = ratesWithData.length > 0
    ? ratesWithData.reduce((s, r) => s + r.avgRate, 0) / ratesWithData.length
    : 0

  // 平均を下回る人のみ返す
  const belowAvg = allRates
    .filter(r => r.avgRate > 0 && r.avgRate < groupAvg)
    .sort((a, b) => a.avgRate - b.avgRate) // 低い順

  return { workers: belowAvg, groupAvg, totalWorkers: ratesWithData.length }
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

    // ═══ Build YM list for the selected period ═══
    const ymListObj = buildYMList(period, baseY, baseM)
    const ymStrList = ymListObj.map(x => ymKey(x.y, x.m))

    // ═══ Load all months' attendance data at once ═══
    const mergedAtt = await getMultiMonthAttData(ymStrList)

    // ═══ Run compute() for the full period ═══
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
    const lookbackAtt = lookbackYms.length > 0 ? await getMultiMonthAttData(lookbackYms) : { d: {}, sd: {}, perMonth: new Map() as Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }> }
    // Merge lookback att with main att for getAvgRevenuePerEquiv
    const allAttD = { ...mergedAtt.d, ...lookbackAtt.d }
    const allAttSD = { ...mergedAtt.sd, ...lookbackAtt.sd }

    // ═══ Billing totals per site across all months (with estimation) ═══
    // 旧アプリと同じロジック: サイト別avgRev → 全社avgRev → tobiBase の順でフォールバック
    const siteBillingMap = new Map<string, number>()
    let totalBilling = 0
    let totalBillingConfirmed = 0
    let estMonths = 0
    const estMonthSet = new Set<string>()
    for (const ymStr of ymStrList) {
      // Check if ANY site has billing for this month
      let monthHasBilling = false
      for (const site of filteredSites) {
        if (getBillTotal(main, site.id, ymStr) > 0) {
          monthHasBilling = true
          break
        }
      }
      for (const site of filteredSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const actualBill = getBillTotal(main, site.id, ymStr)
        if (actualBill > 0) {
          siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + actualBill)
          totalBilling += actualBill
          totalBillingConfirmed += actualBill
        } else if (!monthHasBilling) {
          // No billing for ANY site this month → estimate per site (旧アプリ同様)
          const mY = parseInt(ymStr.slice(0, 4))
          const mM = parseInt(ymStr.slice(4, 6))
          const te = calcTobiEquiv(main, mergedAtt.d, mergedAtt.sd, [{ y: mY, m: mM }], site.id)
          // Try site-specific avg first, then company-wide, then tobiBase
          const avgSite = getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr, site.id)
          const avgAll = avgSite === null ? getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr) : null
          const rates = getSiteRates(main, site.id, ymStr)
          const unitPrice = avgSite || avgAll || rates.tobiBase
          const estimated = Math.round(te.equiv * unitPrice)
          siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + estimated)
          totalBilling += estimated
          estMonthSet.add(ymStr)
        }
      }
    }
    estMonths = estMonthSet.size

    // ═══ calcTobiEquiv for the period ═══
    const tobiEq = calcTobiEquiv(
      main, mergedAtt.d, mergedAtt.sd, ymListObj,
      siteFilter !== 'all' ? siteFilter : undefined,
    )

    // ═══ getSiteRates for baseline ═══
    const rates = getSiteRates(main, siteFilter !== 'all' ? siteFilter : undefined)

    // ═══ Site summary table ═══
    let sitesArray = filteredSites.map(s => {
      const sd = c.sites[s.id] || { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0 }
      const inHouse = sd.work
      const subcon = sd.subWork
      const ot = sd.ot
      const cost = sd.cost + sd.subCost
      const billing = siteBillingMap.get(s.id) || 0
      const profit = billing - cost
      return {
        id: s.id,
        name: s.name,
        inHouseWorkDays: inHouse,
        subconWorkDays: subcon,
        subconRate: (inHouse + subcon) > 0 ? (subcon / (inHouse + subcon)) * 100 : 0,
        otHours: ot,
        cost,
        billing,
        profit,
        profitRate: billing > 0 ? (profit / billing) * 100 : 0,
      }
    })

    // Filter by site if needed
    if (siteFilter !== 'all') {
      sitesArray = sitesArray.filter(s => s.id === siteFilter)
    }

    // ═══ Compute totals (site-filtered) ═══
    let totalWork: number, totalSubWork: number, totalCost: number, totalSubCost: number,
      totalOtEq: number, totalOT: number
    if (siteFilter !== 'all') {
      const sd = c.sites[siteFilter] || { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0 }
      totalWork = sd.work
      totalSubWork = sd.subWork
      totalCost = sd.cost
      totalSubCost = sd.subCost
      totalOtEq = sd.otEq
      totalOT = sd.ot
    } else {
      totalWork = c.totalWork
      totalSubWork = c.totalSubWork
      totalCost = c.totalCost
      totalSubCost = c.totalSubCost
      totalOtEq = c.totalOtEq
      totalOT = c.totalOT
    }

    const totalManDays = totalWork + totalSubWork
    const totalAllCost = totalCost + totalSubCost
    const totalProfit = totalBilling - totalAllCost
    const subconRate = totalManDays > 0 ? (totalSubWork / totalManDays) * 100 : 0

    // ═══ Previous month KPI (for month-over-month comparison) ═══
    const prevYmDate = new Date(baseY, baseM - 2, 1)
    const prevYm = ymKey(prevYmDate.getFullYear(), prevYmDate.getMonth() + 1)
    let prevTotalManDays = 0, prevBilling = 0, prevCost = 0, prevProfit = 0, prevBillingPerManDay = 0
    try {
      const cachedPrev = mergedAtt.perMonth.get(prevYm) || lookbackAtt.perMonth.get(prevYm)
      const prevAtt = cachedPrev || await getAttData(prevYm)
      const prevC = compute(main, prevAtt.d, prevAtt.sd, [{ y: prevYmDate.getFullYear(), m: prevYmDate.getMonth() + 1 }])
      let pWork = 0, pSubWork = 0, pCost = 0, pBill = 0
      for (const site of filteredSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const sd = prevC.sites[site.id]
        if (!sd) continue
        pWork += sd.work
        pSubWork += sd.subWork
        pCost += sd.cost + sd.subCost
        pBill += getBillTotal(main, site.id, prevYm)
      }
      prevTotalManDays = pWork + pSubWork
      prevBilling = pBill
      prevCost = pCost
      prevProfit = pBill - pCost
      prevBillingPerManDay = prevTotalManDays > 0 ? pBill / prevTotalManDays : 0
    } catch {
      // No previous month data
    }

    // ═══ KPI cards ═══
    // 確定月のみのtobiEquivを計算（旧アプリのbilledEquivと同じ）
    const confirmedYmList = ymStrList.filter(ymStr => {
      let hasBill = false
      for (const site of main.sites) {
        if (getBillTotal(main, site.id, ymStr) > 0) { hasBill = true; break }
      }
      return hasBill
    })
    const confirmedYmObj = confirmedYmList.map(s => ({ y: parseInt(s.slice(0, 4)), m: parseInt(s.slice(4, 6)) }))
    const billedEquiv = confirmedYmObj.length > 0
      ? calcTobiEquiv(main, mergedAtt.d, mergedAtt.sd, confirmedYmObj, siteFilter !== 'all' ? siteFilter : undefined)
      : tobiEq

    // perWEst = all billing (incl estimation) / all equiv
    const perWEst = tobiEq.equiv > 0 ? totalBilling / tobiEq.equiv : 0
    // perW = confirmed billing only / confirmed equiv（旧アプリと同じ）
    const perW = billedEquiv.equiv > 0 ? totalBillingConfirmed / billedEquiv.equiv : 0

    // pctWork = month-over-month change in totalManDays
    const pctWork = prevTotalManDays > 0
      ? ((totalManDays - prevTotalManDays) / prevTotalManDays) * 100 : 0

    const kpi = {
      totalManDays,
      inHouseManDays: totalWork,
      subconManDays: totalSubWork,
      subconRate,
      billing: totalBilling,
      cost: totalAllCost,
      profit: totalProfit,
      profitRate: totalBilling > 0 ? (totalProfit / totalBilling) * 100 : 0,
      // 1人あたり労務費: 社員のみ = 自社コスト / 自社人工
      laborCostPerPerson: totalWork > 0 ? totalCost / totalWork : 0,
      // 1人あたり労務費: 外注込み = (自社コスト+外注コスト) / (自社人工+外注人工)
      laborCostPerPersonAll: totalManDays > 0 ? totalAllCost / totalManDays : 0,
      // 人工あたり売上 = billing / tobiEquiv (概算含む)
      billingPerManDay: perWEst,
      // 人工あたり売上（確定のみ）
      perW,
      // 人工あたり売上（概算含む）
      perWEst,
      // 基準 = tobiBase from getSiteRates
      billingPerManDayBaseline: rates.tobiBase,
      billingPerManDayRate: tobiEq.equiv > 0 && rates.tobiBase > 0
        ? (perWEst / rates.tobiBase) * 100 : 0,
      otHours: totalOT,
      estMonths,
      // Previous month comparison
      pctWork,
      prevTotalManDays,
      prevBilling,
      prevCost,
      prevProfitRate: prevBilling > 0 ? (prevProfit / prevBilling) * 100 : 0,
      prevBillingPerManDay,
    }

    // ═══ Monthly trend for 人工あたりKPI chart ═══
    // Always FY: Oct ~ current month, regardless of period selector
    const fyYmListObj = buildYMList('fy', baseY, baseM)
    const fyYmStrList = fyYmListObj.map(x => ymKey(x.y, x.m))

    // Fetch FY months not already loaded
    const missingFyMonths = fyYmStrList.filter(m => !ymStrList.includes(m))
    const fyExtraAtt = missingFyMonths.length > 0 ? await getMultiMonthAttData(missingFyMonths) : { d: {}, sd: {}, perMonth: new Map() }

    // Build a combined per-month cache from all loaded data
    const attCache = new Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>()
    for (const [k, v] of mergedAtt.perMonth) attCache.set(k, v)
    for (const [k, v] of fyExtraAtt.perMonth) attCache.set(k, v)
    for (const [k, v] of lookbackAtt.perMonth) attCache.set(k, v)

    // We need per-month compute for trend, use cached per-month data
    const monthlyTrend = await Promise.all(fyYmStrList.map(async (mStr) => {
      const mY = parseInt(mStr.slice(0, 4))
      const mM = parseInt(mStr.slice(4, 6))
      const ymObj = [{ y: mY, m: mM }]

      // Use cached per-month data instead of re-reading from Firestore
      const cached = attCache.get(mStr)
      const att = cached || await getAttData(mStr)

      const mc = compute(main, att.d, att.sd, ymObj)
      const mTobiEq = calcTobiEquiv(
        main, att.d, att.sd, ymObj,
        siteFilter !== 'all' ? siteFilter : undefined,
      )

      let mBilling = 0, mCost = 0, mWorkDays = 0, mSubDays = 0
      // KPIチャートは全サイト（アーカイブ含む）のデータを含める
      const trendSites = siteFilter !== 'all'
        ? main.sites.filter(s => s.id === siteFilter)
        : main.sites.filter(s => s.id !== 'yaesu_night') // 夜勤のみ除外
      for (const site of trendSites) {
        const sd = mc.sites[site.id]
        if (sd) {
          mCost += sd.cost + sd.subCost
          mWorkDays += sd.work
          mSubDays += sd.subWork
        }
        mBilling += getBillTotal(main, site.id, mStr)
      }

      const manDays = mWorkDays + mSubDays
      const equiv = mTobiEq.equiv
      return {
        ym: mStr,
        billing: mBilling,
        cost: mCost,
        profit: mBilling - mCost,
        manDays,
        equiv,
        // Per-worker KPIs using tobiEquiv
        billingPerManDay: equiv > 0 ? mBilling / equiv : 0,
        costPerManDay: equiv > 0 ? mCost / equiv : 0,
        profitPerManDay: equiv > 0 ? (mBilling - mCost) / equiv : 0,
        inHouseWorkDays: mWorkDays,
        subconWorkDays: mSubDays,
      }
    }))

    // ═══ Today's status ═══
    const now = new Date()
    const todayYm = ymKey(now.getFullYear(), now.getMonth() + 1)
    const todayDay = now.getDate()
    let todayStatus = null
    try {
      const cachedToday = attCache.get(todayYm)
      const todayAtt = cachedToday || await getAttData(todayYm)
      todayStatus = computeTodayStatus(main, todayAtt.d, todayAtt.sd, todayYm, todayDay, hiddenSiteIds)
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

    // ═══ Cumulative FY data ═══
    const fyMonthsObj = buildYMList('fy', baseY, baseM)
    const fyMonthsStr = fyMonthsObj.map(x => ymKey(x.y, x.m))

    const cumulativeData = fyMonthsStr.map(mStr => {
      // Find matching trend data
      const trend = monthlyTrend.find(t => t.ym === mStr)
      return {
        ym: mStr,
        billing: trend?.billing || 0,
        cost: trend?.cost || 0,
        profit: trend?.profit || 0,
        cumBilling: 0, cumCost: 0, cumProfit: 0,
      }
    })

    let cumB = 0, cumC = 0, cumP = 0
    for (const cd of cumulativeData) {
      cumB += cd.billing
      cumC += cd.cost
      cumP += cd.profit
      cd.cumBilling = cumB
      cd.cumCost = cumC
      cd.cumProfit = cumP
    }

    // ═══ PL Alert ═══
    const plAlert = computePLAlert(main)

    // ═══ Foreign worker attendance rates ═══
    const foreignWorkerRates = await computeForeignWorkerRates(main, ym, attCache)

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

    // ═══ Site-specific members and trend ═══
    let siteMembers: { id: number; name: string; org: string; visa: string; job: string }[] | null = null
    let siteTrend: { ym: string; workerCount: number; cost: number; tobi: number; doko: number }[] | null = null

    if (siteFilter !== 'all') {
      const siteAssignData = getAssign(main, siteFilter, ym)
      const workerIds = siteAssignData.workers

      siteMembers = workerIds
        .map(wid => main.workers.find(w => w.id === wid && !w.retired))
        .filter((w): w is typeof main.workers[0] => !!w)
        .map(w => ({ id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job }))

      siteTrend = ymStrList.map(mStr => {
        const trendAssign = getAssign(main, siteFilter, mStr)
        const wids = trendAssign.workers

        let tobi = 0
        let doko = 0
        for (const wid of wids) {
          const worker = main.workers.find(w => w.id === wid && !w.retired)
          if (worker) {
            if (worker.job === 'tobi' || worker.job === 'shokucho' || worker.job === 'yakuin') tobi++
            else doko++
          }
        }

        const trend = monthlyTrend.find(t => t.ym === mStr)
        const mCost = trend?.cost || 0

        return { ym: mStr, workerCount: tobi + doko, cost: mCost, tobi, doko }
      }).sort((a, b) => a.ym.localeCompare(b.ym))
    }

    // ═══ Cost Forecasting (3-month moving average) ═══
    const sortedTrend = [...monthlyTrend].sort((a, b) => a.ym.localeCompare(b.ym))
    let forecast: {
      nextYm: string; predictedBilling: number; predictedCost: number
      predictedProfitRate: number; movingAvgBilling: number[]; movingAvgCost: number[]
    } | null = null

    if (sortedTrend.length >= 3) {
      const maBilling: number[] = []
      const maCost: number[] = []
      for (let i = 0; i < sortedTrend.length; i++) {
        if (i < 2) {
          maBilling.push(0)
          maCost.push(0)
        } else {
          const b0 = sortedTrend[i].billing
          const b1 = sortedTrend[i - 1].billing
          const b2 = sortedTrend[i - 2].billing
          const c0 = sortedTrend[i].cost
          const c1 = sortedTrend[i - 1].cost
          const c2 = sortedTrend[i - 2].cost
          maBilling.push((b0 + b1 + b2) / 3)
          maCost.push((c0 + c1 + c2) / 3)
        }
      }

      const lastMA_B = maBilling[maBilling.length - 1]
      const lastMA_C = maCost[maCost.length - 1]

      const last3B = sortedTrend.slice(-3).reduce((s, t) => s + t.billing, 0) / 3
      const last3C = sortedTrend.slice(-3).reduce((s, t) => s + t.cost, 0) / 3

      let predictedBilling = last3B
      let predictedCost = last3C
      if (maBilling.length >= 4 && maBilling[maBilling.length - 2] > 0) {
        const trendB = lastMA_B / maBilling[maBilling.length - 2]
        const trendC = lastMA_C / maCost[maCost.length - 2]
        predictedBilling = lastMA_B * trendB
        predictedCost = lastMA_C * trendC
      }

      const lastYm = sortedTrend[sortedTrend.length - 1].ym
      const ly = parseInt(lastYm.slice(0, 4))
      const lm = parseInt(lastYm.slice(4, 6))
      const nd = new Date(ly, lm, 1)
      const nextYm = ymKey(nd.getFullYear(), nd.getMonth() + 1)

      const predictedProfit = predictedBilling - predictedCost
      const predictedProfitRate = predictedBilling > 0 ? (predictedProfit / predictedBilling) * 100 : 0

      forecast = {
        nextYm,
        predictedBilling: Math.round(predictedBilling),
        predictedCost: Math.round(predictedCost),
        predictedProfitRate: Math.round(predictedProfitRate * 10) / 10,
        movingAvgBilling: maBilling,
        movingAvgCost: maCost,
      }
    }

    // ═══ Subcon Ratio Alert ═══
    const subconAlert = {
      overallRate: subconRate,
      level: (subconRate > 60 ? 'red' : subconRate > 50 ? 'yellow' : 'none') as 'none' | 'yellow' | 'red',
      sitesAbove50: sitesArray
        .filter(s => s.subconRate > 50 && (s.inHouseWorkDays + s.subconWorkDays) > 0)
        .map(s => ({ id: s.id, name: s.name, rate: Math.round(s.subconRate * 10) / 10 }))
        .sort((a, b) => b.rate - a.rate),
    }

    // ═══ Subcon Analysis ═══
    const subconAnalysis = main.subcons
      .map(sc => {
        const data = c.subcons[sc.id]
        if (!data || data.work <= 0) return null
        // Use per-subcon rate from compute (may vary by site, so recalc from cost)
        return {
          id: sc.id,
          name: sc.name,
          type: sc.type,
          workDays: Math.round(data.work * 10) / 10,
          otCount: Math.round(data.ot * 10) / 10,
          cost: Math.round(data.cost),
          rate: sc.rate,
          otRate: sc.otRate,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.cost - a.cost)

    // ═══ YoY Labor Cost Comparison ═══
    const prevYearYmStrList = ymStrList.map(mStr => {
      const my = parseInt(mStr.slice(0, 4))
      const mm = parseInt(mStr.slice(4, 6))
      return ymKey(my - 1, mm)
    })

    const prevYearAtt = await getMultiMonthAttData(prevYearYmStrList)
    const prevYearYmObj = prevYearYmStrList.map(m => ({ y: parseInt(m.slice(0, 4)), m: parseInt(m.slice(4, 6)) }))
    const prevYearC = compute(main, prevYearAtt.d, prevYearAtt.sd, prevYearYmObj)

    let currentTotalLabor = 0
    let prevTotalLabor = 0
    let hasPrevData = false
    const currentLaborBySite = new Map<string, number>()
    const prevLaborBySite = new Map<string, number>()

    for (const site of filteredSites) {
      if (siteFilter !== 'all' && site.id !== siteFilter) continue

      const sd = c.sites[site.id]
      const cur = sd ? sd.cost + sd.subCost : 0
      currentLaborBySite.set(site.id, cur)
      currentTotalLabor += cur

      const psd = prevYearC.sites[site.id]
      const prev = psd ? psd.cost + psd.subCost : 0
      if (prev > 0) hasPrevData = true
      prevLaborBySite.set(site.id, prev)
      prevTotalLabor += prev
    }

    const yoyComparison = {
      hasPrevData,
      currentTotal: Math.round(currentTotalLabor),
      prevTotal: Math.round(prevTotalLabor),
      changeRate: prevTotalLabor > 0 ? ((currentTotalLabor - prevTotalLabor) / prevTotalLabor) * 100 : 0,
      sites: filteredSites
        .filter(s => siteFilter === 'all' || s.id === siteFilter)
        .map(s => {
          const cur = currentLaborBySite.get(s.id) || 0
          const prev = prevLaborBySite.get(s.id) || 0
          return {
            id: s.id, name: s.name,
            current: Math.round(cur), prev: Math.round(prev),
            changeRate: prev > 0 ? ((cur - prev) / prev) * 100 : 0,
          }
        })
        .filter(s => s.current > 0 || s.prev > 0)
        .sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate)),
    }

    // Filter monthlyTrend: exclude months with no actual work data (equiv === 0)
    // Also exclude months with no confirmed billing (billing === 0)
    const filteredMonthlyTrend = monthlyTrend.filter(t => t.equiv > 0 && t.billing > 0)

    return NextResponse.json({
      kpi,
      sites: sitesArray,
      monthlyTrend: filteredMonthlyTrend,
      todayStatus,
      dailyAttendance,
      cumulativeData,
      plAlert,
      foreignWorkerRates,
      siteList,
      ymList: ymStrList.sort(),
      period,
      selectedYm: ym,
      siteMembers,
      siteTrend,
      forecast,
      subconAlert,
      yoyComparison,
      subconAnalysis,
    })
  } catch (error) {
    console.error('Dashboard API error:', error)
    return NextResponse.json({ error: 'Failed to compute dashboard data' }, { status: 500 })
  }
}

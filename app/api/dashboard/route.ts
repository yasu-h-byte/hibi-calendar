import { NextRequest, NextResponse } from 'next/server'
import { getMainData, getAttData, computeMonthly, MainData } from '@/lib/compute'
import { AttendanceEntry } from '@/types'

// --- Helpers ---

function ymKey(y: number, m: number): string {
  return `${y}${String(m).padStart(2, '0')}`
}

/** Get list of YYYYMM strings for a period type relative to a base month */
function getYmRange(period: string, baseYm: string): string[] {
  const y = parseInt(baseYm.slice(0, 4))
  const m = parseInt(baseYm.slice(4, 6))

  switch (period) {
    case 'month':
      return [baseYm]
    case '3month': {
      const result: string[] = []
      for (let i = 0; i < 3; i++) {
        const d = new Date(y, m - 1 - i, 1)
        result.push(ymKey(d.getFullYear(), d.getMonth() + 1))
      }
      return result
    }
    case '6month': {
      const result: string[] = []
      for (let i = 0; i < 6; i++) {
        const d = new Date(y, m - 1 - i, 1)
        result.push(ymKey(d.getFullYear(), d.getMonth() + 1))
      }
      return result
    }
    case 'fy': {
      // FY = Oct - Sep. If current month >= Oct, FY starts this year Oct.
      // Otherwise FY starts last year Oct.
      const fyStartYear = m >= 10 ? y : y - 1
      const result: string[] = []
      for (let i = 0; i < 12; i++) {
        const d = new Date(fyStartYear, 9 + i, 1) // Oct = month 9 (0-indexed)
        result.push(ymKey(d.getFullYear(), d.getMonth() + 1))
      }
      return result
    }
    case 'year': {
      const result: string[] = []
      for (let i = 0; i < 12; i++) {
        const d = new Date(y, m - 1 - i, 1)
        result.push(ymKey(d.getFullYear(), d.getMonth() + 1))
      }
      return result
    }
    default:
      return [baseYm]
  }
}

/** Compute PL alert for workers with remaining PL <= 3 */
function computePLAlert(main: MainData): {
  workerId: number; name: string; org: string; totalDays: number; usedDays: number; remaining: number; status: string
}[] {
  const alerts: {
    workerId: number; name: string; org: string; totalDays: number; usedDays: number; remaining: number; status: string
  }[] = []

  for (const w of main.workers) {
    if (w.retired) continue
    const records = main.plData[String(w.id)] || []
    if (records.length === 0) continue

    // Use the latest PL record
    const latest = records[records.length - 1]
    const totalDays = latest.grantDays + latest.carryOver + latest.adjustment
    const usedDays = latest.used
    const remaining = totalDays - usedDays

    if (remaining <= 3) {
      let status = ''
      if (remaining <= 0) status = 'danger'
      else if (remaining <= 1) status = 'warning'
      else status = 'caution'

      alerts.push({
        workerId: w.id,
        name: w.name,
        org: w.org,
        totalDays,
        usedDays,
        remaining,
        status,
      })
    }
  }

  return alerts.sort((a, b) => a.remaining - b.remaining)
}

/** Today's attendance status: who is working at which site, who is off */
function computeTodayStatus(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  day: number,
) {
  const activeSites = main.sites.filter(s => !s.archived)

  // For each active site, count tobi/doko workers and track absent workers
  const siteStatus: {
    siteId: string
    siteName: string
    tobi: number
    doko: number
    gaichuCount: number
    total: number
  }[] = []

  const absentWorkers: { id: number; name: string }[] = []
  const workingWorkerIds = new Set<number>()

  for (const site of activeSites) {
    let tobi = 0
    let doko = 0

    // Get assigned workers for this site (massign overrides assign)
    const monthKey = `${site.id}_${ym}`
    const mAssign = main.massign[monthKey]
    const dAssign = main.assign[site.id]
    const workerIds = mAssign?.workers || dAssign?.workers || []

    for (const wid of workerIds) {
      const key = `${site.id}_${wid}_${ym}_${String(day).padStart(2, '0')}`
      const entry = attD[key]

      if (entry && entry.w === 1) {
        const worker = main.workers.find(w => w.id === wid)
        if (worker) {
          const job = worker.job || ''
          if (job === 'とび' || job === 'tobi' || job === '鳶') tobi++
          else doko++
          workingWorkerIds.add(wid)
        }
      }
    }

    // Count subcons
    let gaichuCount = 0
    const subconIds = mAssign?.subcons || dAssign?.subcons || []
    for (const scid of subconIds) {
      const key = `${site.id}_${scid}_${ym}_${String(day).padStart(2, '0')}`
      const sdEntry = attSD[key]
      if (sdEntry && sdEntry.n && sdEntry.n > 0) gaichuCount += sdEntry.n
    }

    const total = tobi + doko + gaichuCount
    if (workerIds.length > 0) {
      siteStatus.push({
        siteId: site.id,
        siteName: site.name,
        tobi,
        doko,
        gaichuCount,
        total,
      })
    }
  }

  // Find absent workers (assigned to at least one site but not working today)
  const allAssignedWorkerIds = new Set<number>()
  for (const site of activeSites) {
    const monthKey = `${site.id}_${ym}`
    const mAssign = main.massign[monthKey]
    const dAssign = main.assign[site.id]
    const workerIds = mAssign?.workers || dAssign?.workers || []
    for (const wid of workerIds) allAssignedWorkerIds.add(wid)
  }

  for (const wid of Array.from(allAssignedWorkerIds)) {
    if (!workingWorkerIds.has(wid)) {
      const worker = main.workers.find(w => w.id === wid && !w.retired)
      if (worker) {
        absentWorkers.push({ id: worker.id, name: worker.name })
      }
    }
  }

  return { siteStatus, absentWorkers }
}

/** Compute foreign worker attendance rates per month */
function computeForeignWorkerRates(
  main: MainData,
  monthlyResults: { ym: string; workers: { id: number; workDays: number }[] }[],
  ymList: string[],
) {
  const foreignWorkers = main.workers.filter(w =>
    !w.retired && w.visa && w.visa !== 'none' && w.visa !== ''
  )

  return foreignWorkers.map(fw => {
    const monthlyRates: { ym: string; rate: number }[] = []
    let totalWork = 0
    let totalPossible = 0

    for (const ym of ymList) {
      const workDaysInMonth = main.workDays[ym] || 22
      const result = monthlyResults.find(r => r.ym === ym)
      const workerResult = result?.workers.find(w => w.id === fw.id)
      const worked = workerResult?.workDays || 0

      const rate = workDaysInMonth > 0 ? (worked / workDaysInMonth) * 100 : 0
      monthlyRates.push({ ym, rate })
      totalWork += worked
      totalPossible += workDaysInMonth
    }

    const avgRate = totalPossible > 0 ? (totalWork / totalPossible) * 100 : 0

    return {
      id: fw.id,
      name: fw.name,
      org: fw.org,
      visa: fw.visa,
      avgRate,
      monthlyRates,
    }
  })
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || authHeader !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ym = request.nextUrl.searchParams.get('ym')
  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  const period = request.nextUrl.searchParams.get('period') || 'month'
  const siteFilter = request.nextUrl.searchParams.get('site') || 'all' // 'all' or specific site ID

  try {
    const main = await getMainData()

    // Determine months to aggregate
    const ymList = getYmRange(period, ym)

    // Fetch attendance data for all months in range
    const attDataList = await Promise.all(
      ymList.map(async (m) => {
        const att = await getAttData(m)
        return { ym: m, d: att.d, sd: att.sd }
      })
    )

    // Compute monthly results for each month
    const monthlyResults = attDataList.map(att => {
      const result = computeMonthly(main, att.d, att.sd, att.ym)
      return { ym: att.ym, ...result }
    })

    // Aggregate across months
    const aggregatedSites = new Map<string, {
      id: string; name: string;
      workDays: number; subWorkDays: number; otHours: number;
      cost: number; subCost: number; billing: number; profit: number
    }>()

    for (const site of main.sites.filter(s => !s.archived)) {
      aggregatedSites.set(site.id, {
        id: site.id, name: site.name,
        workDays: 0, subWorkDays: 0, otHours: 0,
        cost: 0, subCost: 0, billing: 0, profit: 0,
      })
    }

    for (const mr of monthlyResults) {
      for (const site of mr.sites) {
        const agg = aggregatedSites.get(site.id)
        if (agg) {
          agg.workDays += site.workDays
          agg.subWorkDays += site.subWorkDays
          agg.cost += site.cost
          agg.subCost += site.subCost
          agg.billing += site.billing
          agg.profit += site.profit
        }
      }
      // Accumulate OT per site from workers
      for (const w of mr.workers) {
        for (const sid of w.sites) {
          const agg = aggregatedSites.get(sid)
          if (agg) agg.otHours += w.otHours / w.sites.length
        }
      }
    }

    // Build site summary with rates
    let sitesArray = Array.from(aggregatedSites.values()).map(s => ({
      id: s.id,
      name: s.name,
      inHouseWorkDays: s.workDays,
      subconWorkDays: s.subWorkDays,
      subconRate: (s.workDays + s.subWorkDays) > 0
        ? (s.subWorkDays / (s.workDays + s.subWorkDays)) * 100 : 0,
      otHours: s.otHours,
      cost: s.cost + s.subCost,
      billing: s.billing,
      profit: s.profit,
      profitRate: s.billing > 0 ? (s.profit / s.billing) * 100 : 0,
    }))

    // Filter by site if needed
    if (siteFilter !== 'all') {
      sitesArray = sitesArray.filter(s => s.id === siteFilter)
    }

    // Compute totals
    const totalInHouse = sitesArray.reduce((s, r) => s + r.inHouseWorkDays, 0)
    const totalSubcon = sitesArray.reduce((s, r) => s + r.subconWorkDays, 0)
    const totalCost = sitesArray.reduce((s, r) => s + r.cost, 0)
    const totalBilling = sitesArray.reduce((s, r) => s + r.billing, 0)
    const totalProfit = sitesArray.reduce((s, r) => s + r.profit, 0)
    const totalOtHours = sitesArray.reduce((s, r) => s + r.otHours, 0)
    const totalWorkDays = totalInHouse + totalSubcon
    const subconRate = totalWorkDays > 0 ? (totalSubcon / totalWorkDays) * 100 : 0

    // KPI cards
    const kpi = {
      totalManDays: totalWorkDays,
      inHouseManDays: totalInHouse,
      subconManDays: totalSubcon,
      subconRate,
      billing: totalBilling,
      cost: totalCost,
      profit: totalProfit,
      profitRate: totalBilling > 0 ? (totalProfit / totalBilling) * 100 : 0,
      laborCostPerPerson: totalInHouse > 0 ? totalCost / totalInHouse : 0,
      laborCostPerPersonAll: totalWorkDays > 0 ? totalCost / totalWorkDays : 0,
      billingPerManDay: totalWorkDays > 0 ? totalBilling / totalWorkDays : 0,
      billingPerManDayBaseline: 32300,
      billingPerManDayRate: totalWorkDays > 0
        ? ((totalBilling / totalWorkDays) / 32300) * 100 : 0,
      otHours: totalOtHours,
    }

    // Monthly trend data (for charts)
    const monthlyTrend = ymList.map(m => {
      const mr = monthlyResults.find(r => r.ym === m)
      if (!mr) return { ym: m, billing: 0, cost: 0, profit: 0, manDays: 0, billingPerManDay: 0 }

      let mBilling = 0, mCost = 0, mProfit = 0, mWorkDays = 0, mSubDays = 0
      for (const site of mr.sites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        mBilling += site.billing
        mCost += site.cost + site.subCost
        mProfit += site.profit
        mWorkDays += site.workDays
        mSubDays += site.subWorkDays
      }
      const manDays = mWorkDays + mSubDays
      return {
        ym: m,
        billing: mBilling,
        cost: mCost,
        profit: mProfit,
        manDays,
        billingPerManDay: manDays > 0 ? mBilling / manDays : 0,
        costPerManDay: manDays > 0 ? mCost / manDays : 0,
        profitPerManDay: manDays > 0 ? mProfit / manDays : 0,
        inHouseWorkDays: mWorkDays,
        subconWorkDays: mSubDays,
      }
    }).sort((a, b) => a.ym.localeCompare(b.ym))

    // Today's status
    const now = new Date()
    const todayYm = ymKey(now.getFullYear(), now.getMonth() + 1)
    const todayDay = now.getDate()
    const todayAttData = attDataList.find(a => a.ym === todayYm)
    let todayStatus = null
    if (todayAttData) {
      todayStatus = computeTodayStatus(main, todayAttData.d, todayAttData.sd, todayYm, todayDay)
    } else {
      // Fetch today's data if not in range
      try {
        const todayAtt = await getAttData(todayYm)
        todayStatus = computeTodayStatus(main, todayAtt.d, todayAtt.sd, todayYm, todayDay)
      } catch {
        todayStatus = { siteStatus: [], absentWorkers: [] }
      }
    }

    // Daily attendance for current month (for daily bar chart)
    const currentMonthYm = ym // Use selected month
    const currentMonthAtt = attDataList.find(a => a.ym === currentMonthYm)
    const dailyAttendance: { day: number; sites: { siteId: string; siteName: string; count: number }[] }[] = []
    if (currentMonthAtt) {
      const y2 = parseInt(currentMonthYm.slice(0, 4))
      const m2 = parseInt(currentMonthYm.slice(4, 6))
      const daysInMonth = new Date(y2, m2, 0).getDate()
      for (let d = 1; d <= daysInMonth; d++) {
        const daySites: { siteId: string; siteName: string; count: number }[] = []
        for (const site of main.sites.filter(s => !s.archived)) {
          if (siteFilter !== 'all' && site.id !== siteFilter) continue
          let count = 0
          const monthKey = `${site.id}_${currentMonthYm}`
          const mAssign = main.massign[monthKey]
          const dAssign = main.assign[site.id]
          const workerIds = mAssign?.workers || dAssign?.workers || []
          for (const wid of workerIds) {
            const key = `${site.id}_${wid}_${currentMonthYm}_${String(d).padStart(2, '0')}`
            const entry = currentMonthAtt.d[key]
            if (entry && entry.w === 1) count++
          }
          if (count > 0) {
            daySites.push({ siteId: site.id, siteName: site.name, count })
          }
        }
        dailyAttendance.push({ day: d, sites: daySites })
      }
    }

    // Cumulative FY data
    const currentYear = parseInt(ym.slice(0, 4))
    const currentMonth = parseInt(ym.slice(4, 6))
    const fyStartYear = currentMonth >= 10 ? currentYear : currentYear - 1
    const fyMonths: string[] = []
    for (let i = 0; i < 12; i++) {
      const d = new Date(fyStartYear, 9 + i, 1) // Start from October
      const fym = ymKey(d.getFullYear(), d.getMonth() + 1)
      fyMonths.push(fym)
    }

    // Fetch FY months not already loaded
    const missingMonths = fyMonths.filter(m => !attDataList.find(a => a.ym === m))
    const extraAttData = await Promise.all(
      missingMonths.map(async (m) => {
        const att = await getAttData(m)
        return { ym: m, d: att.d, sd: att.sd }
      })
    )
    const allAttData = [...attDataList, ...extraAttData]

    const cumulativeData = fyMonths.map(m => {
      const att = allAttData.find(a => a.ym === m)
      if (!att) return { ym: m, billing: 0, cost: 0, profit: 0, cumBilling: 0, cumCost: 0, cumProfit: 0 }
      const result = computeMonthly(main, att.d, att.sd, m)
      let mBilling = 0, mCost = 0
      for (const site of result.sites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        mBilling += site.billing
        mCost += site.cost + site.subCost
      }
      return { ym: m, billing: mBilling, cost: mCost, profit: mBilling - mCost, cumBilling: 0, cumCost: 0, cumProfit: 0 }
    })

    // Calculate cumulative values
    let cumB = 0, cumC = 0, cumP = 0
    for (const cd of cumulativeData) {
      cumB += cd.billing
      cumC += cd.cost
      cumP += cd.profit
      cd.cumBilling = cumB
      cd.cumCost = cumC
      cd.cumProfit = cumP
    }

    // PL Alert
    const plAlert = computePLAlert(main)

    // Foreign worker attendance rates
    const fwMonthlyResults = monthlyResults.map(mr => ({
      ym: mr.ym,
      workers: mr.workers.map(w => ({ id: w.id, workDays: w.workDays })),
    }))
    const foreignWorkerRates = computeForeignWorkerRates(main, fwMonthlyResults, ymList)

    // Site list for tab selector
    const siteList = main.sites
      .filter(s => !s.archived)
      .map(s => ({ id: s.id, name: s.name }))

    // Site-specific members and trend (when a specific site is selected)
    let siteMembers: {
      id: number; name: string; org: string; visa: string; job: string
    }[] | null = null
    let siteTrend: {
      ym: string; workerCount: number; cost: number; tobi: number; doko: number
    }[] | null = null

    if (siteFilter !== 'all') {
      // Get assigned workers for this site
      const monthKey = `${siteFilter}_${ym}`
      const mAssign = main.massign[monthKey]
      const dAssign = main.assign[siteFilter]
      const workerIds = mAssign?.workers || dAssign?.workers || []

      siteMembers = workerIds
        .map(wid => main.workers.find(w => w.id === wid && !w.retired))
        .filter((w): w is typeof main.workers[0] => !!w)
        .map(w => ({
          id: w.id,
          name: w.name,
          org: w.org,
          visa: w.visa,
          job: w.job,
        }))

      // Site trend: monthly worker count & cost for each month in range
      siteTrend = ymList.map(m => {
        const mKey = `${siteFilter}_${m}`
        const mA = main.massign[mKey]
        const dA = main.assign[siteFilter]
        const wids = mA?.workers || dA?.workers || []

        let tobi = 0
        let doko = 0
        for (const wid of wids) {
          const worker = main.workers.find(w => w.id === wid && !w.retired)
          if (worker) {
            const job = worker.job || ''
            if (job === 'とび' || job === 'tobi' || job === '鳶') tobi++
            else doko++
          }
        }

        const mr = monthlyResults.find(r => r.ym === m)
        let mCost = 0
        if (mr) {
          for (const site of mr.sites) {
            if (site.id === siteFilter) {
              mCost += site.cost + site.subCost
            }
          }
        }

        return {
          ym: m,
          workerCount: tobi + doko,
          cost: mCost,
          tobi,
          doko,
        }
      }).sort((a, b) => a.ym.localeCompare(b.ym))
    }

    return NextResponse.json({
      kpi,
      sites: sitesArray,
      monthlyTrend,
      todayStatus,
      dailyAttendance,
      cumulativeData,
      plAlert,
      foreignWorkerRates,
      siteList,
      ymList: ymList.sort(),
      period,
      selectedYm: ym,
      siteMembers,
      siteTrend,
    })
  } catch (error) {
    console.error('Dashboard API error:', error)
    return NextResponse.json({ error: 'Failed to compute dashboard data' }, { status: 500 })
  }
}

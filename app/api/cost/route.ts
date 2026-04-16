import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
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
  parseDKey,
} from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

/** Map frontend period param to compute buildYMList mode */
function toMode(period: string): string {
  switch (period) {
    case '3months': return '3m'
    case '6months': return '6m'
    case 'fiscal':  return 'fy'
    case 'yearly':  return 'year'
    default:        return 'month'
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { siteId, ym, amounts } = await request.json()
    if (!siteId || !ym) return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const billing = (snap.data().billing || {}) as Record<string, number[]>
    const key = `${siteId}_${ym}`

    const arr = (Array.isArray(amounts) ? amounts : [Number(amounts) || 0]).map(v => Number(v) || 0).filter(v => v !== 0)
    billing[key] = arr.length > 0 ? arr : [0]

    await updateDoc(docRef, { billing })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Cost POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ym = request.nextUrl.searchParams.get('ym')
  const period = request.nextUrl.searchParams.get('period') || 'monthly'
  const siteFilter = request.nextUrl.searchParams.get('site') || 'all'
  if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })

  try {
    const main = await getMainData()
    const baseY = parseInt(ym.slice(0, 4))
    const baseM = parseInt(ym.slice(4, 6))
    const mode = toMode(period)
    const ymList = buildYMList(mode, baseY, baseM)
    const ymRange = ymList.map(x => ymKey(x.y, x.m))
    const isSingleMonth = ymList.length === 1

    // Load merged attendance data for all months in range
    const att = await getMultiMonthAttData(ymRange)

    // Run compute() once with all attendance data
    const c = compute(main, att.d, att.sd, ymList)

    // Determine which sites to show:
    // - active sites always
    // - archived sites only if they have data in the period (for multi-month)
    const showArchived = mode !== 'month'
    const allSites = showArchived
      ? main.sites.filter(s => {
          if (!s.archived) return true
          const sd = c.sites[s.id]
          return sd && (sd.work + sd.subWork) > 0
        })
      : main.sites.filter(s => !s.archived)

    // ═══ Load extra att data for getAvgRevenuePerEquiv lookback (3 months before earliest month) ═══
    const earliestYm = ymRange.slice().sort()[0]
    const lookbackYms: string[] = []
    {
      let ly = parseInt(earliestYm.slice(0, 4))
      let lm = parseInt(earliestYm.slice(4, 6))
      for (let i = 0; i < 3; i++) {
        lm--
        if (lm < 1) { lm = 12; ly-- }
        const lStr = ymKey(ly, lm)
        if (!ymRange.includes(lStr)) lookbackYms.push(lStr)
      }
    }
    const lookbackAtt = lookbackYms.length > 0 ? await getMultiMonthAttData(lookbackYms) : { d: {}, sd: {}, perMonth: new Map() as Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }> }
    const allAttD = { ...att.d, ...lookbackAtt.d }
    const allAttSD = { ...att.sd, ...lookbackAtt.sd }

    // ═══ Billing totals per site across all months (with estimation) ═══
    const siteBillingMap = new Map<string, number>()
    let totalBillingAll = 0
    let totalBillingConfirmed = 0
    let estMonths = 0
    const estMonthSet = new Set<string>()
    for (const ymStr of ymRange) {
      for (const site of allSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const actualBill = getBillTotal(main, site.id, ymStr)
        if (actualBill > 0) {
          siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + actualBill)
          totalBillingAll += actualBill
          totalBillingConfirmed += actualBill
        } else {
          const mY = parseInt(ymStr.slice(0, 4))
          const mM = parseInt(ymStr.slice(4, 6))
          const te = calcTobiEquiv(main, att.d, att.sd, [{ y: mY, m: mM }], site.id)
          if (te.equiv > 0) {
            const avgSite = getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr, site.id)
            const avgAll = avgSite === null ? getAvgRevenuePerEquiv(main, allAttD, allAttSD, ymStr) : null
            const rates = getSiteRates(main, site.id, ymStr)
            const unitPrice = avgSite || avgAll || rates.tobiBase
            const estimated = Math.round(te.equiv * unitPrice)
            siteBillingMap.set(site.id, (siteBillingMap.get(site.id) || 0) + estimated)
            totalBillingAll += estimated
            estMonthSet.add(ymStr)
          }
        }
      }
    }
    estMonths = estMonthSet.size

    // Build per-site data
    const sites = allSites
      .filter(s => siteFilter === 'all' || s.id === siteFilter)
      .map(rawSite => {
      const sd = c.sites[rawSite.id] || { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0, dispatchDeduction: 0 }

      // Billing: sum across months using getBillTotal
      let billingRaw = 0
      const billingByMonth: Record<string, number[]> = {}
      for (const m of ymRange) {
        const billingKey = `${rawSite.id}_${m}`
        const billingArr = main.billing[billingKey] || []
        billingByMonth[m] = billingArr
        billingRaw += getBillTotal(main, rawSite.id, m)
      }

      // 出向控除: 人件費のみ差引（売上は既に控除済みの値が入力されているためそのまま）
      const dispatchDeduction = sd.dispatchDeduction || 0
      const billing = siteBillingMap.get(rawSite.id) || billingRaw
      const cost = Math.max(0, sd.cost - dispatchDeduction)
      const subCost = sd.subCost
      const totalCost = cost + subCost
      const profit = billing - totalCost
      const profitRate = billing > 0 ? (profit / billing) * 100 : 0

      // Tobi equiv using calcTobiEquiv
      const tobiData = calcTobiEquiv(main, att.d, att.sd, ymList, rawSite.id)
      const tobiEquiv = tobiData.equiv
      const rates = getSiteRates(main, rawSite.id)

      return {
        id: rawSite.id,
        name: rawSite.name,
        billing,
        billingRaw: Math.round(billingRaw),
        billingByMonth,
        cost: Math.round(cost),
        costRaw: Math.round(sd.cost),
        dispatchDeduction: Math.round(dispatchDeduction),
        subCost: Math.round(subCost),
        totalCost: Math.round(totalCost),
        profit: Math.round(profit),
        profitRate: Math.round(profitRate * 10) / 10,
        workDays: Math.round(sd.work * 10) / 10,
        subWorkDays: Math.round(sd.subWork * 10) / 10,
        tobiEquiv: Math.round(tobiEquiv * 10) / 10,
        tobiRate: rates.tobiRate,
        tobiBase: tobiData.tobiBase,
      }
    }).filter(s => s.workDays > 0 || s.subWorkDays > 0 || s.billing > 0)

    // Subcon cost details using compute().subcons and siteSubcons
    const subconDetails = main.subcons.map(sc => {
      const cd = c.subcons[sc.id]
      const workDays = cd ? cd.work : 0
      const otCount = cd ? cd.ot : 0
      const cost = cd ? cd.cost : 0

      // Build per-site breakdown from siteSubcons
      const siteBreakdown: { siteId: string; siteName: string; workDays: number; otCount: number; cost: number }[] = []
      for (const s of allSites) {
        const ssk = `${s.id}_${sc.id}`
        const ss = c.siteSubcons[ssk]
        if (ss && ss.work > 0) {
          siteBreakdown.push({
            siteId: s.id,
            siteName: s.name,
            workDays: Math.round(ss.work * 10) / 10,
            otCount: Math.round(ss.ot * 10) / 10,
            cost: Math.round(ss.cost),
          })
        }
      }

      return {
        id: sc.id,
        name: sc.name,
        type: sc.type,
        rate: sc.rate,
        otRate: sc.otRate,
        workDays: Math.round(workDays * 10) / 10,
        otCount: Math.round(otCount * 10) / 10,
        cost: Math.round(cost),
        siteBreakdown,
      }
    })

    // ═══ Compute totals (site-filtered) ═══
    let totalWork: number, totalSubWork: number, totalCostVal: number, totalSubCostVal: number,
      totalOT: number, totalDispatchDeduction: number
    if (siteFilter !== 'all') {
      const sd = c.sites[siteFilter] || { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0, dispatchDeduction: 0 }
      totalWork = sd.work
      totalSubWork = sd.subWork
      totalCostVal = sd.cost
      totalSubCostVal = sd.subCost
      totalOT = sd.ot
      totalDispatchDeduction = sd.dispatchDeduction || 0
    } else {
      totalWork = c.totalWork
      totalSubWork = c.totalSubWork
      totalCostVal = c.totalCost
      totalSubCostVal = c.totalSubCost
      totalOT = c.totalOT
      totalDispatchDeduction = c.totalDispatchDeduction || 0
    }

    const totalManDays = totalWork + totalSubWork
    const adjTotalCost = Math.max(0, totalCostVal - totalDispatchDeduction)
    // 売上はそのまま（既に控除済みの値が入力されている）
    const totalAllCost = adjTotalCost + totalSubCostVal
    const totalProfit = totalBillingAll - totalAllCost
    const subconRate = totalManDays > 0 ? (totalSubWork / totalManDays) * 100 : 0

    // Global tobi equiv for KPI
    const tobiCost = calcTobiEquiv(main, att.d, att.sd, ymList, siteFilter !== 'all' ? siteFilter : undefined)
    const totalPerW = tobiCost.equiv > 0 ? Math.round(totalBillingAll / tobiCost.equiv) : 0

    // ═══ Previous month same-day comparison (前月同日比) ═══
    const prevYmDate = new Date(baseY, baseM - 2, 1)
    const prevYm = ymKey(prevYmDate.getFullYear(), prevYmDate.getMonth() + 1)
    let prevTotalManDays = 0, prevBilling = 0, prevCost = 0, prevProfit = 0, prevBillingPerManDay = 0
    try {
      const cachedPrev = att.perMonth.get(prevYm) || lookbackAtt.perMonth.get(prevYm)
      const prevAtt = cachedPrev || await getAttData(prevYm)

      const sameDayLimit = new Date().getDate()
      const filteredPrevD: Record<string, AttendanceEntry> = {}
      const filteredPrevSD: Record<string, { n: number; on: number }> = {}
      for (const [k, v] of Object.entries(prevAtt.d)) {
        if (!v) continue
        const pk = parseDKey(k)
        if (parseInt(pk.day) <= sameDayLimit) filteredPrevD[k] = v
      }
      for (const [k, v] of Object.entries(prevAtt.sd)) {
        if (!v) continue
        const pk = parseDKey(k)
        if (parseInt(pk.day) <= sameDayLimit) filteredPrevSD[k] = v
      }

      const prevC = compute(main, filteredPrevD, filteredPrevSD, [{ y: prevYmDate.getFullYear(), m: prevYmDate.getMonth() + 1 }])
      let pWork = 0, pSubWork = 0, pCostSum = 0, pBill = 0
      for (const site of allSites) {
        if (siteFilter !== 'all' && site.id !== siteFilter) continue
        const sd = prevC.sites[site.id]
        if (!sd) continue
        pWork += sd.work
        pSubWork += sd.subWork
        pCostSum += sd.cost + sd.subCost
        pBill += getBillTotal(main, site.id, prevYm)
      }
      prevTotalManDays = pWork + pSubWork
      prevBilling = pBill
      prevCost = pCostSum
      prevProfit = pBill - pCostSum
      prevBillingPerManDay = prevTotalManDays > 0 ? pBill / prevTotalManDays : 0
    } catch {
      // No previous month data
    }

    // ═══ KPI extended ═══
    const ratesGlobal = getSiteRates(main, siteFilter !== 'all' ? siteFilter : undefined)
    const confirmedYmList = ymRange.filter(ymStr => {
      let hasBill = false
      for (const site of main.sites) {
        if (getBillTotal(main, site.id, ymStr) > 0) { hasBill = true; break }
      }
      return hasBill
    })
    const confirmedYmObj = confirmedYmList.map(s => ({ y: parseInt(s.slice(0, 4)), m: parseInt(s.slice(4, 6)) }))
    const billedEquiv = confirmedYmObj.length > 0
      ? calcTobiEquiv(main, att.d, att.sd, confirmedYmObj, siteFilter !== 'all' ? siteFilter : undefined)
      : tobiCost
    // 売上はそのまま使用（dispatch deduction は人件費のみに適用）
    const perWEst = tobiCost.equiv > 0 ? totalBillingAll / tobiCost.equiv : 0
    const perW = billedEquiv.equiv > 0 ? totalBillingConfirmed / billedEquiv.equiv : 0
    const pctWork = prevTotalManDays > 0 ? ((totalManDays - prevTotalManDays) / prevTotalManDays) * 100 : 0

    const kpiExtended = {
      totalManDays,
      inHouseManDays: totalWork,
      subconManDays: totalSubWork,
      subconRate,
      billing: totalBillingAll,
      billingRaw: totalBillingAll,
      cost: totalAllCost,
      profit: totalProfit,
      profitRate: totalBillingAll > 0 ? (totalProfit / totalBillingAll) * 100 : 0,
      perW,
      perWEst,
      billingPerManDay: perWEst,
      billingPerManDayBaseline: ratesGlobal.tobiBase,
      laborCostPerPerson: totalWork > 0 ? adjTotalCost / totalWork : 0,
      laborCostPerPersonAll: totalManDays > 0 ? totalAllCost / totalManDays : 0,
      estMonths,
      pctWork,
      prevTotalManDays,
      prevBilling,
      prevCost,
      prevProfitRate: prevBilling > 0 ? (prevProfit / prevBilling) * 100 : 0,
      prevBillingPerManDay,
      otHours: totalOT,
    }

    // ═══ Monthly trend for FY ═══
    const fyYmListObj = buildYMList('fy', baseY, baseM)
    const fyYmStrList = fyYmListObj.map(x => ymKey(x.y, x.m))

    const missingFyMonths = fyYmStrList.filter(m => !ymRange.includes(m))
    const fyExtraAtt = missingFyMonths.length > 0 ? await getMultiMonthAttData(missingFyMonths) : { d: {}, sd: {}, perMonth: new Map() }

    const attCache = new Map<string, { d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>()
    for (const [k, v] of att.perMonth) attCache.set(k, v)
    for (const [k, v] of fyExtraAtt.perMonth) attCache.set(k, v)
    for (const [k, v] of lookbackAtt.perMonth) attCache.set(k, v)

    const monthlyTrend = await Promise.all(fyYmStrList.map(async (mStr) => {
      const mY = parseInt(mStr.slice(0, 4))
      const mM = parseInt(mStr.slice(4, 6))
      const ymObj = [{ y: mY, m: mM }]

      const cached = attCache.get(mStr)
      const mattData = cached || await getAttData(mStr)

      const mc = compute(main, mattData.d, mattData.sd, ymObj)
      const mTobiEq = calcTobiEquiv(
        main, mattData.d, mattData.sd, ymObj,
        siteFilter !== 'all' ? siteFilter : undefined,
      )

      let mBilling = 0, mCostVal = 0, mWorkDays = 0, mSubDays = 0, mDispatchDeduction = 0
      const trendSites = siteFilter !== 'all'
        ? main.sites.filter(s => s.id === siteFilter)
        : main.sites.filter(s => s.id !== 'yaesu_night')
      for (const site of trendSites) {
        const sd = mc.sites[site.id]
        if (sd) {
          mCostVal += sd.cost + sd.subCost
          mWorkDays += sd.work
          mSubDays += sd.subWork
          mDispatchDeduction += sd.dispatchDeduction || 0
        }
        mBilling += getBillTotal(main, site.id, mStr)
      }
      // 売上はそのまま（出向控除は人件費のみ）
      mCostVal = Math.max(0, mCostVal - mDispatchDeduction)

      const manDays = mWorkDays + mSubDays
      const equiv = mTobiEq.equiv
      return {
        ym: mStr,
        billing: mBilling,
        cost: mCostVal,
        profit: mBilling - mCostVal,
        manDays,
        equiv,
        billingPerManDay: equiv > 0 ? mBilling / equiv : 0,
        costPerManDay: equiv > 0 ? mCostVal / equiv : 0,
        profitPerManDay: equiv > 0 ? (mBilling - mCostVal) / equiv : 0,
        inHouseWorkDays: mWorkDays,
        subconWorkDays: mSubDays,
      }
    }))

    const filteredMonthlyTrend = monthlyTrend.filter(t => t.equiv > 0 && t.billing > 0)

    // ═══ Cumulative FY data ═══
    const cumulativeData = fyYmStrList.map(mStr => {
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

    const cumulativeDataFiltered = cumulativeData.filter(cd => cd.billing > 0)

    // ═══ Site list for filter dropdown ═══
    const archivedSitesWithData = new Set<string>()
    for (const site of allSites) {
      if (site.archived) {
        const sd = c.sites[site.id]
        if (sd && (sd.work > 0 || sd.subWork > 0)) archivedSitesWithData.add(site.id)
        const bill = siteBillingMap.get(site.id) || 0
        if (bill > 0) archivedSitesWithData.add(site.id)
      }
    }
    const siteList = allSites
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

      siteTrend = ymRange.map(mStr => {
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
        const mCostVal = trend?.cost || 0

        return { ym: mStr, workerCount: tobi + doko, cost: mCostVal, tobi, doko }
      }).sort((a, b) => a.ym.localeCompare(b.ym))
    }

    // Totals（出向控除済み）
    const totalBilling = sites.reduce((s, st) => s + st.billing, 0)

    return NextResponse.json({
      sites,
      subconDetails,
      ymRange,
      totals: {
        billing: Math.round(totalBilling),
        cost: Math.round(adjTotalCost),
        subCost: Math.round(totalSubCostVal),
        totalCost: Math.round(totalAllCost),
        profit: Math.round(totalProfit),
        profitRate: totalBillingAll > 0 ? Math.round((totalProfit / totalBillingAll) * 1000) / 10 : 0,
        workDays: Math.round(sites.reduce((s, st) => s + st.workDays, 0) * 10) / 10,
        subWorkDays: Math.round(sites.reduce((s, st) => s + st.subWorkDays, 0) * 10) / 10,
        otHours: Math.round(totalOT * 10) / 10,
        // KPI extras
        tobiEquiv: Math.round(tobiCost.equiv * 10) / 10,
        tobiBase: tobiCost.tobiBase,
        perWorker: totalPerW,
        // 出向控除（明細用）
        dispatchDeduction: Math.round(totalDispatchDeduction),
        billingRaw: Math.round(totalBilling + totalDispatchDeduction),
        costRaw: Math.round(adjTotalCost + totalDispatchDeduction),
      },
      // New fields for expanded cost page
      monthlyTrend: filteredMonthlyTrend,
      cumulativeData: cumulativeDataFiltered,
      kpiExtended,
      siteList,
      siteMembers,
      siteTrend,
    })
  } catch (error) {
    console.error('Cost API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

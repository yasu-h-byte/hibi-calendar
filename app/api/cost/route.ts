import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import {
  compute,
  getMainData,
  getMultiMonthAttData,
  calcTobiEquiv,
  getSiteRates,
  getBillTotal,
  buildYMList,
} from '@/lib/compute'
import { ymKey } from '@/lib/attendance'

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

    // Build per-site data
    const sites = allSites.map(rawSite => {
      const sd = c.sites[rawSite.id] || { work: 0, ot: 0, otEq: 0, cost: 0, subWork: 0, subOT: 0, subOtEq: 0, subCost: 0 }

      // Billing: sum across months using getBillTotal
      let billing = 0
      const billingByMonth: Record<string, number[]> = {}
      for (const m of ymRange) {
        const billingKey = `${rawSite.id}_${m}`
        const billingArr = main.billing[billingKey] || []
        billingByMonth[m] = billingArr
        billing += getBillTotal(main, rawSite.id, m)
      }

      const cost = sd.cost
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
        billingByMonth,
        cost: Math.round(cost),
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

    // Totals
    const totalBilling = sites.reduce((s, st) => s + st.billing, 0)
    const totalCost = Math.round(c.totalCost)
    const totalSubCost = Math.round(c.totalSubCost)
    const allCost = totalCost + totalSubCost
    const totalProfit = totalBilling - allCost
    const profitRate = totalBilling > 0 ? (totalProfit / totalBilling) * 100 : 0

    // Global tobi equiv for KPI
    const tobiCost = calcTobiEquiv(main, att.d, att.sd, ymList)
    const totalPerW = tobiCost.equiv > 0 ? Math.round(totalBilling / tobiCost.equiv) : 0

    return NextResponse.json({
      sites,
      subconDetails,
      ymRange,
      totals: {
        billing: Math.round(totalBilling),
        cost: totalCost,
        subCost: totalSubCost,
        totalCost: allCost,
        profit: Math.round(totalProfit),
        profitRate: Math.round(profitRate * 10) / 10,
        workDays: Math.round(sites.reduce((s, st) => s + st.workDays, 0) * 10) / 10,
        subWorkDays: Math.round(sites.reduce((s, st) => s + st.subWorkDays, 0) * 10) / 10,
        otHours: Math.round((c.totalOT + c.totalSubOT) * 10) / 10,
        // KPI extras
        tobiEquiv: Math.round(tobiCost.equiv * 10) / 10,
        tobiBase: tobiCost.tobiBase,
        perWorker: totalPerW,
      },
    })
  } catch (error) {
    console.error('Cost API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

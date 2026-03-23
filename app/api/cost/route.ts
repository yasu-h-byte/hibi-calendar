import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

function checkAuth(request: NextRequest): boolean {
  return !!(process.env.ADMIN_PASSWORD && request.headers.get('x-admin-password') === process.env.ADMIN_PASSWORD)
}

/** Resolve tobiRate for a site at a given ym, considering period-aware rates */
function resolveTobiRate(site: { tobiRate?: number; dokoRate?: number; rates?: { period: string; tobiRate: number; dokoRate: number }[] }, ym: string, defaultRates?: { tobiRate?: number; dokoRate?: number }): number {
  // Check period-aware rates first
  if (site.rates && site.rates.length > 0) {
    // Find rate whose period covers ym (period format: "202401-202412" or just "202401")
    for (const r of site.rates) {
      const parts = r.period.split('-')
      const start = parts[0]
      const end = parts[1] || parts[0]
      if (ym >= start && ym <= end) return r.tobiRate
    }
  }
  // Fallback to site-level tobiRate
  if (site.tobiRate && site.tobiRate > 0) return site.tobiRate
  // Fallback to default
  return defaultRates?.tobiRate || 0
}

/** Get list of ym strings for a period */
function getYmRange(baseYm: string, period: string): string[] {
  const year = parseInt(baseYm.slice(0, 4))
  const month = parseInt(baseYm.slice(4, 6))

  switch (period) {
    case '3months': {
      const yms: string[] = []
      for (let i = 2; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1)
        yms.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      return yms
    }
    case '6months': {
      const yms: string[] = []
      for (let i = 5; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1)
        yms.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      return yms
    }
    case 'fiscal': {
      // Fiscal year starts in April. If current month < April, FY started last year
      const fyStart = month >= 4 ? year : year - 1
      const yms: string[] = []
      for (let m = 4; m <= 15; m++) {
        const actualMonth = ((m - 1) % 12) + 1
        const actualYear = m > 12 ? fyStart + 1 : fyStart
        const ymStr = `${actualYear}${String(actualMonth).padStart(2, '0')}`
        if (ymStr <= baseYm) yms.push(ymStr)
      }
      return yms
    }
    case 'yearly': {
      const yms: string[] = []
      for (let i = 11; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1)
        yms.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      return yms
    }
    default:
      return [baseYm]
  }
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { siteId, ym, amounts } = await request.json()
    if (!siteId || !ym) return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const billing = (snap.data().billing || {}) as Record<string, number[]>
    const key = `${siteId}_${ym}`

    // amounts is number[] (multiple billing rows)
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
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ym = request.nextUrl.searchParams.get('ym')
  const period = request.nextUrl.searchParams.get('period') || 'monthly'
  if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })

  try {
    const main = await getMainData()
    const ymRange = getYmRange(ym, period)

    // Aggregate across all months in range
    const allResults = await Promise.all(
      ymRange.map(async (m) => {
        const att = await getAttData(m)
        return { ym: m, result: computeMonthly(main, att.d, att.sd, m) }
      })
    )

    const rawSites = main.sites.filter(s => !s.archived)

    // Build per-site aggregated data
    const sites = rawSites.map(rawSite => {
      let cost = 0, subCost = 0, workDays = 0, subWorkDays = 0, billing = 0

      // Billing per month (as arrays)
      const billingByMonth: Record<string, number[]> = {}
      for (const m of ymRange) {
        const billingKey = `${rawSite.id}_${m}`
        const billingArr = main.billing[billingKey] || []
        billingByMonth[m] = billingArr
        billing += billingArr.reduce((s, v) => s + v, 0)
      }

      for (const { result } of allResults) {
        const siteSummary = result.sites.find(s => s.id === rawSite.id)
        if (siteSummary) {
          cost += siteSummary.cost
          subCost += siteSummary.subCost
          workDays += siteSummary.workDays
          subWorkDays += siteSummary.subWorkDays
        }
      }

      const totalCost = cost + subCost
      const profit = billing - totalCost
      const profitRate = billing > 0 ? (profit / billing) * 100 : 0
      const tobiRate = resolveTobiRate(rawSite, ym, main.defaultRates)
      const tobiEquiv = tobiRate > 0 ? billing / tobiRate : 0

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
        workDays: Math.round(workDays * 10) / 10,
        subWorkDays: Math.round(subWorkDays * 10) / 10,
        tobiEquiv: Math.round(tobiEquiv * 10) / 10,
        tobiRate,
      }
    }).filter(s => s.workDays > 0 || s.subWorkDays > 0 || s.billing > 0)

    // Subcon cost details with per-site breakdown
    const subconMap = new Map<string, {
      id: string; name: string; type: string; rate: number; otRate: number
      workDays: number; otCount: number; cost: number
      siteBreakdown: { siteId: string; siteName: string; workDays: number; otCount: number; cost: number }[]
    }>()

    for (const sc of main.subcons) {
      subconMap.set(sc.id, {
        id: sc.id, name: sc.name, type: sc.type, rate: sc.rate, otRate: sc.otRate,
        workDays: 0, otCount: 0, cost: 0, siteBreakdown: [],
      })
    }

    // Aggregate subcon data across months with site breakdown
    for (const { result } of allResults) {
      for (const sc of result.subcons) {
        const entry = subconMap.get(sc.id)
        if (!entry) continue
        entry.workDays += sc.workDays
        entry.otCount += sc.otCount
        entry.cost += sc.cost
      }
    }

    // Build per-site subcon breakdown from attendance data
    for (const m of ymRange) {
      const att = await getAttData(m)
      for (const [key, sdEntry] of Object.entries(att.sd)) {
        const parts = key.split('_')
        if (parts.length < 4) continue
        const siteId = parts[0]
        const scid = parts[1]
        const entryYm = parts[2]
        if (entryYm !== m) continue

        const sc = subconMap.get(scid)
        if (!sc || sdEntry.n <= 0) continue

        const siteName = rawSites.find(s => s.id === siteId)?.name || siteId
        let existing = sc.siteBreakdown.find(b => b.siteId === siteId)
        if (!existing) {
          existing = { siteId, siteName, workDays: 0, otCount: 0, cost: 0 }
          sc.siteBreakdown.push(existing)
        }
        existing.workDays += sdEntry.n
        existing.otCount += sdEntry.on || 0
        existing.cost += sdEntry.n * sc.rate + (sdEntry.on || 0) * sc.otRate
      }
    }

    const subconDetails = Array.from(subconMap.values()).map(sc => ({
      ...sc,
      workDays: Math.round(sc.workDays * 10) / 10,
      cost: Math.round(sc.cost),
      siteBreakdown: sc.siteBreakdown.map(b => ({
        ...b,
        workDays: Math.round(b.workDays * 10) / 10,
        cost: Math.round(b.cost),
      })),
    }))

    const totalBilling = sites.reduce((s, st) => s + st.billing, 0)
    const totalCost = sites.reduce((s, st) => s + st.cost, 0)
    const totalSubCost = sites.reduce((s, st) => s + st.subCost, 0)
    const totalProfit = totalBilling - totalCost - totalSubCost
    const profitRate = totalBilling > 0 ? (totalProfit / totalBilling) * 100 : 0

    return NextResponse.json({
      sites,
      subconDetails,
      ymRange,
      totals: {
        billing: Math.round(totalBilling),
        cost: Math.round(totalCost),
        subCost: Math.round(totalSubCost),
        totalCost: Math.round(totalCost + totalSubCost),
        profit: Math.round(totalProfit),
        profitRate: Math.round(profitRate * 10) / 10,
        workDays: Math.round(sites.reduce((s, st) => s + st.workDays, 0) * 10) / 10,
        subWorkDays: Math.round(sites.reduce((s, st) => s + st.subWorkDays, 0) * 10) / 10,
        otHours: 0,
      },
    })
  } catch (error) {
    console.error('Cost API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

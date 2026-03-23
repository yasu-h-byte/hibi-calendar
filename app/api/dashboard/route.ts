import { NextRequest, NextResponse } from 'next/server'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

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

  try {
    const [main, att] = await Promise.all([
      getMainData(),
      getAttData(ym),
    ])

    const result = computeMonthly(main, att.d, att.sd, ym)

    const kpi = {
      totalWorkDays: result.totals.workDays + result.totals.subWorkDays,
      billing: result.totals.billing,
      profit: result.totals.profit,
      profitRate: result.totals.billing > 0
        ? (result.totals.profit / result.totals.billing) * 100
        : 0,
      otHours: result.totals.otHours,
    }

    const sites = result.sites.map(s => ({
      id: s.id,
      name: s.name,
      inHouseWorkDays: s.workDays,
      subconWorkDays: s.subWorkDays,
      billing: s.billing,
      cost: s.cost + s.subCost,
      profit: s.profit,
      profitRate: s.profitRate,
    }))

    const totals = {
      inHouseWorkDays: result.totals.workDays,
      subconWorkDays: result.totals.subWorkDays,
      billing: result.totals.billing,
      cost: result.totals.cost + result.totals.subCost,
      profit: result.totals.profit,
      profitRate: result.totals.billing > 0
        ? (result.totals.profit / result.totals.billing) * 100
        : 0,
    }

    return NextResponse.json({ kpi, sites, totals })
  } catch (error) {
    console.error('Dashboard API error:', error)
    return NextResponse.json({ error: 'Failed to compute dashboard data' }, { status: 500 })
  }
}

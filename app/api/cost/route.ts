import { NextRequest, NextResponse } from 'next/server'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ym = request.nextUrl.searchParams.get('ym')
  if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })

  try {
    const main = await getMainData()
    const att = await getAttData(ym)
    const result = computeMonthly(main, att.d, att.sd, ym)

    const sites = result.sites.map(s => ({
      id: s.id,
      name: s.name,
      billing: s.billing,
      cost: s.cost,
      subCost: s.subCost,
      totalCost: s.cost + s.subCost,
      profit: s.profit,
      profitRate: s.profitRate,
      workDays: s.workDays,
      subWorkDays: s.subWorkDays,
    }))

    const totalCost = result.totals.cost + result.totals.subCost
    const profitRate = result.totals.billing > 0 ? (result.totals.profit / result.totals.billing) * 100 : 0

    return NextResponse.json({
      sites,
      totals: {
        billing: result.totals.billing,
        cost: result.totals.cost,
        subCost: result.totals.subCost,
        totalCost,
        profit: result.totals.profit,
        profitRate,
        workDays: result.totals.workDays,
        subWorkDays: result.totals.subWorkDays,
        otHours: result.totals.otHours,
      },
    })
  } catch (error) {
    console.error('Cost API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

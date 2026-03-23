import { NextRequest, NextResponse } from 'next/server'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

function checkAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD
  return !!(adminPassword && authHeader === adminPassword)
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const ym = searchParams.get('ym')

  if (!ym || !/^\d{6}$/.test(ym)) {
    return NextResponse.json({ error: 'ym parameter required (YYYYMM)' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)
    const result = computeMonthly(main, att.d, att.sd, ym)

    const locked = !!(main.locks[ym])

    // Site name map for frontend display
    const siteNames: Record<string, string> = {}
    for (const s of main.sites) {
      siteNames[s.id] = s.name
    }

    return NextResponse.json({
      workers: result.workers,
      subcons: result.subcons,
      sites: result.sites,
      totals: result.totals,
      locked,
      siteNames,
    })
  } catch (error) {
    console.error('Monthly API error:', error)
    return NextResponse.json({ error: 'Failed to compute monthly data' }, { status: 500 })
  }
}

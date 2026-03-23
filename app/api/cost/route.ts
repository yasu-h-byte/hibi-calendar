import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, computeMonthly } from '@/lib/compute'

function checkAuth(request: NextRequest): boolean {
  return !!(process.env.ADMIN_PASSWORD && request.headers.get('x-admin-password') === process.env.ADMIN_PASSWORD)
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { siteId, ym, amount } = await request.json()
    if (!siteId || !ym) return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const billing = (snap.data().billing || {}) as Record<string, number[]>
    const key = `${siteId}_${ym}`
    billing[key] = [Number(amount) || 0]
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

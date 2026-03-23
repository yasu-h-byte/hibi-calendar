import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'

function checkAuth(request: NextRequest): boolean {
  return !!(process.env.ADMIN_PASSWORD && request.headers.get('x-admin-password') === process.env.ADMIN_PASSWORD)
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { workerId, fy, grantDays, carryOver, adjustment } = await request.json()
    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDays: number; carryOver: number; adjustment: number }[]>
    const key = String(workerId)
    const records = plData[key] || []
    const idx = records.findIndex(r => r.fy === fy)

    const record = { fy, grantDays: Number(grantDays) || 0, carryOver: Number(carryOver) || 0, adjustment: Number(adjustment) || 0 }
    if (idx >= 0) records[idx] = record
    else records.push(record)

    plData[key] = records
    await updateDoc(docRef, { plData })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const fy = request.nextUrl.searchParams.get('fy') || '2025'
  const fyStart = parseInt(fy)

  try {
    const main = await getMainData()

    // FY months: Oct of fyStart to Sep of fyStart+1
    const fyMonths: string[] = []
    for (let m = 10; m <= 12; m++) fyMonths.push(ymKey(fyStart, m))
    for (let m = 1; m <= 9; m++) fyMonths.push(ymKey(fyStart + 1, m))

    // Load attendance data for all FY months to count PL usage
    const allAtt: Record<string, Record<string, unknown>> = {}
    for (const ym of fyMonths) {
      const att = await getAttData(ym)
      Object.assign(allAtt, att.d)
    }

    // Count PL usage per worker
    const plUsage: Record<number, number> = {}
    for (const [key, entry] of Object.entries(allAtt)) {
      const e = entry as { p?: number }
      if (e.p && e.p === 1) {
        const wid = parseInt(key.split('_')[1])
        plUsage[wid] = (plUsage[wid] || 0) + 1
      }
    }

    // Build worker PL data
    const workers = main.workers
      .filter(w => !w.retired && w.job !== 'yakuin')
      .map(w => {
        const plRecords = (main.plData[String(w.id)] || []) as { fy: string; grantDays: number; carryOver: number; adjustment: number }[]
        const fyRecord = plRecords.find(r => r.fy === fy)

        const grantDays = fyRecord?.grantDays || 0
        const carryOver = fyRecord?.carryOver || 0
        const adjustment = fyRecord?.adjustment || 0
        const total = grantDays + carryOver + adjustment
        const used = plUsage[w.id] || 0
        const remaining = total - used

        return {
          id: w.id,
          name: w.name,
          org: w.org,
          visa: w.visa,
          grantDays,
          carryOver,
          adjustment,
          used,
          total,
          remaining,
          rate: total > 0 ? (used / total) * 100 : 0,
        }
      })
      .filter(w => w.total > 0 || w.used > 0)

    return NextResponse.json({ workers })
  } catch (error) {
    console.error('Leave API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

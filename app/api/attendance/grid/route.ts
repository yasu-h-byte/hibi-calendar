import { NextRequest, NextResponse } from 'next/server'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const siteId = request.nextUrl.searchParams.get('siteId')
  const ym = request.nextUrl.searchParams.get('ym')
  if (!siteId || !ym) {
    return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
  }

  try {
    const main = await getMainData()
    const att = await getAttData(ym)

    const site = main.sites.find(s => s.id === siteId)
    if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 })

    // Get workers assigned to this site
    const monthKey = `${siteId}_${ym}`
    const massign = main.massign[monthKey]
    const assign = main.assign[siteId]
    const workerIds = massign?.workers || assign?.workers || []

    const workers = main.workers
      .filter(w => workerIds.includes(w.id))
      .map(w => ({
        id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      }))

    // Get subcons assigned to this site
    const subconIds = massign?.subcons || assign?.subcons || []
    const subcons = main.subcons
      .filter(sc => subconIds.includes(sc.id))
      .map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

    // Get days in month
    const [y, m] = [parseInt(ym.substring(0, 4)), parseInt(ym.substring(4, 6))]
    const daysInMonth = new Date(y, m, 0).getDate()

    // Build attendance grid
    const workerEntries: Record<string, Record<number, AttendanceEntry>> = {}
    for (const w of workers) {
      workerEntries[w.id] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${w.id}_${ym}_${String(d).padStart(2, '0')}`
        if (att.d[key]) workerEntries[w.id][d] = att.d[key]
      }
    }

    const subconEntries: Record<string, Record<number, { n: number; on: number }>> = {}
    for (const sc of subcons) {
      subconEntries[sc.id] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${sc.id}_${ym}_${String(d).padStart(2, '0')}`
        if (att.sd[key]) subconEntries[sc.id][d] = att.sd[key]
      }
    }

    const locked = !!(main.locks[ym])

    // Foreman name
    const foremanWorker = main.workers.find(w => w.id === site.foreman)
    const foremanName = foremanWorker?.name || ''

    // Approval status per day (from att doc approvals field)
    const approvals: Record<number, boolean> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const approvalKey = `${siteId}_${ym}_${String(d).padStart(2, '0')}`
      if (att.approvals?.[approvalKey]) {
        approvals[d] = true
      }
    }

    return NextResponse.json({
      site: { id: site.id, name: site.name, foreman: site.foreman, foremanName },
      year: y, month: m, daysInMonth, ym,
      workers, subcons,
      workerEntries, subconEntries,
      locked,
      approvals,
      sites: main.sites.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name })),
    })
  } catch (error) {
    console.error('Grid GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, workerId, day, entry, subconId, subconEntry } = await request.json()

    if (!siteId || !ym || !day) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const { doc, setDoc } = await import('firebase/firestore')
    const { db } = await import('@/lib/firebase')
    const docRef = doc(db, 'demmen', `att_${ym}`)

    if (workerId !== undefined && entry !== undefined) {
      const key = `${siteId}_${workerId}_${ym}_${String(day).padStart(2, '0')}`
      await setDoc(docRef, { d: { [key]: entry } }, { merge: true })
    }

    if (subconId !== undefined && subconEntry !== undefined) {
      const key = `${siteId}_${subconId}_${ym}_${String(day).padStart(2, '0')}`
      await setDoc(docRef, { sd: { [key]: subconEntry } }, { merge: true })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Grid POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

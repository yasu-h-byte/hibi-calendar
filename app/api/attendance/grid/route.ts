import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getAttData, getAssign } from '@/lib/compute'
import { getApprovalForDay } from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
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

    // Get workers assigned to this site (with 12-month lookback)
    const assignData = getAssign(main, siteId, ym)
    const workerIds = assignData.workers

    // Get days in month
    const [y, m] = [parseInt(ym.substring(0, 4)), parseInt(ym.substring(4, 6))]
    const daysInMonth = new Date(y, m, 0).getDate()

    // Build attendance grid first (to check who has data)
    const allWorkerEntries: Record<number, Record<number, AttendanceEntry>> = {}
    for (const wid of workerIds) {
      allWorkerEntries[wid] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${wid}_${ym}_${String(d)}`
        if (att.d[key]) allWorkerEntries[wid][d] = att.d[key]
      }
    }

    // For months where massign has too many workers (pre-2026 bulk assignment),
    // filter to only those with actual attendance data
    const currentAssignCount = main.assign[siteId]?.workers?.length || 0
    const monthKey = `${siteId}_${ym}`
    const useMassignFilter = main.massign[monthKey] && workerIds.length > currentAssignCount * 2
    const filteredWorkerIds = useMassignFilter
      ? workerIds.filter((wid: number) => Object.keys(allWorkerEntries[wid] || {}).length > 0)
      : workerIds

    const workers = main.workers
      .filter(w => filteredWorkerIds.includes(w.id))
      .map(w => ({
        id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      }))

    const workerEntries: Record<string, Record<number, AttendanceEntry>> = {}
    for (const w of workers) {
      workerEntries[w.id] = allWorkerEntries[w.id] || {}
    }

    // Get subcons assigned to this site (with 12-month lookback)
    const subconIds = assignData.subcons
    const subcons = main.subcons
      .filter(sc => subconIds.includes(sc.id))
      .map(sc => ({ id: sc.id, name: sc.name, type: sc.type }))

    const subconEntries: Record<string, Record<number, { n: number; on: number }>> = {}
    for (const sc of subcons) {
      subconEntries[sc.id] = {}
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${siteId}_${sc.id}_${ym}_${String(d)}`
        if (att.sd[key]) subconEntries[sc.id][d] = att.sd[key]
      }
    }

    const locked = !!(main.locks[ym])

    // Foreman name
    const foremanWorker = main.workers.find(w => w.id === site.foreman)
    const foremanName = foremanWorker?.name || ''

    // Approval status per day
    // Check both the attendanceApprovals collection (new) and att doc approvals field (legacy)
    const approvals: Record<number, boolean> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const approvalKey = `${siteId}_${ym}_${String(d)}`
      // Check attendanceApprovals collection first (where foreman writes)
      const collectionApproval = await getApprovalForDay(siteId, ym, d)
      if (collectionApproval?.foreman) {
        approvals[d] = true
      } else if (att.approvals?.[approvalKey]) {
        // Fallback: legacy approvals stored inside att_ document
        approvals[d] = true
      }
    }

    // workDays for this month
    const workDaysValue = main.workDays[ym] ?? null

    // All active workers (for assignment modal)
    const allWorkers = main.workers
      .filter(w => !w.retired)
      .map(w => ({ id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job }))

    return NextResponse.json({
      site: { id: site.id, name: site.name, foreman: site.foreman, foremanName },
      year: y, month: m, daysInMonth, ym,
      workers, subcons,
      workerEntries, subconEntries,
      locked,
      approvals,
      workDays: workDaysValue,
      allWorkers,
      sites: main.sites.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name })),
    })
  } catch (error) {
    console.error('Grid GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    const { doc, setDoc, getDoc } = await import('firebase/firestore')
    const { db } = await import('@/lib/firebase')

    // Action: save workDays
    if (action === 'saveWorkDays') {
      const { ym, value } = body
      if (!ym) return NextResponse.json({ error: 'ym required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, { workDays: { [ym]: value } }, { merge: true })
      return NextResponse.json({ success: true })
    }

    // Action: save assignments
    if (action === 'saveAssign') {
      const { siteId, workerIds } = body
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
      const docRef = doc(db, 'demmen', 'main')
      // Read current assign to preserve subcons
      const snap = await getDoc(docRef)
      const current = snap.exists() ? snap.data() : {}
      const currentAssign = (current.assign || {})[siteId] || {}
      await setDoc(docRef, {
        assign: {
          [siteId]: {
            ...currentAssign,
            workers: workerIds || [],
          }
        }
      }, { merge: true })
      return NextResponse.json({ success: true })
    }

    // Default: save attendance entry
    const { siteId, ym, workerId, day, entry, subconId, subconEntry } = body

    if (!siteId || !ym || !day) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', `att_${ym}`)

    if (workerId !== undefined && entry !== undefined) {
      const key = `${siteId}_${workerId}_${ym}_${String(day)}`
      await setDoc(docRef, { d: { [key]: entry } }, { merge: true })
    }

    if (subconId !== undefined && subconEntry !== undefined) {
      const key = `${siteId}_${subconId}_${ym}_${String(day)}`
      await setDoc(docRef, { sd: { [key]: subconEntry } }, { merge: true })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Grid POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

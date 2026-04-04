import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import {
  getAttendanceDoc,
  setAttendanceEntry,
  getApprovalForDay,
  getStaffSites,
  getEntryStatus,
  ymKey,
  attKey,
  formatDateJP,
  formatDateShort,
} from '@/lib/attendance'
import { getSites } from '@/lib/sites'
import { AttendanceEntry } from '@/types'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const siteIdParam = request.nextUrl.searchParams.get('siteId')

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const assignedSites = await getStaffSites(worker.id)
    if (assignedSites.length === 0 && !siteIdParam) {
      return NextResponse.json({ error: 'No site assigned' }, { status: 404 })
    }

    // Get all active (non-archived) sites for the dropdown
    const allActiveSites = await getSites()

    // Build availableSites: all active sites, with primary flag for assigned ones
    const assignedIds = new Set(assignedSites.map(s => s.id))
    const availableSites = allActiveSites.map(s => ({
      id: s.id,
      name: s.name,
      primary: assignedIds.has(s.id),
    }))
    // Sort: assigned sites first, then alphabetically
    availableSites.sort((a, b) => {
      if (a.primary && !b.primary) return -1
      if (!a.primary && b.primary) return 1
      return a.name.localeCompare(b.name, 'ja')
    })

    const siteId = siteIdParam || (assignedSites.length > 0 ? assignedSites[0].id : allActiveSites[0]?.id)
    const site = availableSites.find(s => s.id === siteId) || availableSites[0]
    if (!site) {
      return NextResponse.json({ error: 'No sites available' }, { status: 404 })
    }

    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const d = now.getDate()
    const ym = ymKey(y, m)

    // Read attendance data
    const attData = await getAttendanceDoc(ym)

    // Today's entry
    const todayKey = attKey(siteId, worker.id, ym, d)
    const currentEntry = attData[todayKey] || null

    // Past 3 days
    const pastDays = []
    for (let off = 1; off <= 3; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()

      // May need to read a different month's doc
      let pAttData = attData
      if (pym !== ym) {
        pAttData = await getAttendanceDoc(pym)
      }

      const pk = attKey(siteId, worker.id, pym, pDay)
      const entry = pAttData[pk] || null
      const status = getEntryStatus(entry)

      const approval = await getApprovalForDay(siteId, pym, pDay)
      const locked = !!(approval?.foreman)

      pastDays.push({
        date: formatDateShort(pd),
        year: pd.getFullYear(),
        month: pd.getMonth() + 1,
        day: pDay,
        entry,
        status,
        locked,
        dayOffset: off,
      })
    }

    // Today's approval
    const todayApproval = await getApprovalForDay(siteId, ym, d)

    return NextResponse.json({
      worker: { id: worker.id, name: worker.name, nameVi: worker.nameVi },
      site: { id: site.id, name: site.name },
      allSites: assignedSites,
      availableSites,
      today: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateJP(now),
      },
      currentEntry,
      currentStatus: getEntryStatus(currentEntry),
      todayLocked: !!(todayApproval?.foreman),
      pastDays,
    })
  } catch (error) {
    console.error('Staff GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { token, siteId, year, month, day, choice, overtimeHours } = await request.json()

    if (!token || !siteId || !year || !month || !day || !choice) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Check site exists and is active
    const allActiveSites = await getSites()
    if (!allActiveSites.find(s => s.id === siteId)) {
      return NextResponse.json({ error: 'Site not found or archived' }, { status: 403 })
    }

    // Check approval lock
    const ym = ymKey(year, month)
    const approval = await getApprovalForDay(siteId, ym, day)
    if (approval?.foreman) {
      return NextResponse.json({ error: 'Day is locked (approved)' }, { status: 409 })
    }

    // Build entry
    let entry: AttendanceEntry
    switch (choice) {
      case 'work':
        entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'staff' }
        break
      case 'rest':
        entry = { w: 0, r: 1, s: 'staff' }
        break
      case 'leave':
        entry = { w: 0, p: 1, s: 'staff' }
        break
      case 'site_off':
        entry = { w: 0, h: 1, s: 'staff' }
        break
      default:
        return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
    }

    await setAttendanceEntry(siteId, worker.id, ym, day, entry)

    return NextResponse.json({ success: true, entry })
  } catch (error) {
    console.error('Staff POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

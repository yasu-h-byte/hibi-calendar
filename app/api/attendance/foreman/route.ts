import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import {
  getAttendanceDoc,
  setAttendanceEntry,
  getApprovalForDay,
  setApprovalForDay,
  getForemanSite,
  getForeignWorkersForSite,
  getEntryStatus,
  ymKey,
  attKey,
  formatDateJP,
  formatDateShort,
} from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const dateParam = request.nextUrl.searchParams.get('date') // YYYY-MM-DD

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    const foreman = await getWorkerByToken(token)
    if (!foreman) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const site = await getForemanSite(foreman.id)
    if (!site) {
      return NextResponse.json({ error: 'Not a foreman' }, { status: 403 })
    }

    // Parse date (default: today)
    let viewDate: Date
    if (dateParam) {
      viewDate = new Date(dateParam + 'T00:00:00')
    } else {
      viewDate = new Date()
    }

    // Don't go past today
    const today = new Date()
    if (viewDate > today) viewDate = today

    const y = viewDate.getFullYear()
    const m = viewDate.getMonth() + 1
    const d = viewDate.getDate()
    const ym = ymKey(y, m)

    // Get foreign workers for this site
    const foreignWorkers = await getForeignWorkersForSite(site.id)

    // Get attendance data
    const attData = await getAttendanceDoc(ym)

    // Build worker list with status
    const workers = foreignWorkers.map(w => {
      const key = attKey(site.id, w.id, ym, d)
      const entry = attData[key] || null
      return {
        id: w.id,
        name: w.name,
        entry,
        status: getEntryStatus(entry),
      }
    })

    const workCount = workers.filter(w => w.status === 'work' || w.status === 'overtime').length
    const noneCount = workers.filter(w => w.status === 'none').length

    // Check approval
    const approval = await getApprovalForDay(site.id, ym, d)
    const approved = !!(approval?.foreman)

    // Past 2 days
    const pastDays = []
    for (let off = 1; off <= 2; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()
      const pApproval = await getApprovalForDay(site.id, pym, pDay)
      pastDays.push({
        date: formatDateShort(pd),
        dateISO: `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}-${String(pDay).padStart(2, '0')}`,
        approved: !!(pApproval?.foreman),
      })
    }

    return NextResponse.json({
      foreman: { id: foreman.id, name: foreman.name },
      site: { id: site.id, name: site.name },
      date: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateJP(viewDate),
        dateISO: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      },
      workers,
      summary: { workCount, noneCount, totalCount: workers.length },
      approved,
      pastDays,
    })
  } catch (error) {
    console.error('Foreman GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, action } = body

    if (!token || !action) {
      return NextResponse.json({ error: 'token and action required' }, { status: 400 })
    }

    const foreman = await getWorkerByToken(token)
    if (!foreman) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const site = await getForemanSite(foreman.id)
    if (!site) {
      return NextResponse.json({ error: 'Not a foreman' }, { status: 403 })
    }

    if (action === 'approve') {
      const { year, month, day } = body
      const ym = ymKey(year, month)
      await setApprovalForDay(site.id, ym, day, foreman.id)
      return NextResponse.json({ success: true })
    }

    if (action === 'edit') {
      const { workerId, year, month, day, choice, overtimeHours } = body
      const ym = ymKey(year, month)

      // Build entry (foreman edits don't have s:'staff')
      let entry: AttendanceEntry
      switch (choice) {
        case 'work':
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)) }
          break
        case 'rest':
          entry = { w: 0, r: 1 }
          break
        case 'leave':
          entry = { w: 0, p: 1 }
          break
        case 'site_off':
          entry = { w: 0, h: 1 }
          break
        default:
          return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
      }

      await setAttendanceEntry(site.id, workerId, ym, day, entry)
      return NextResponse.json({ success: true, entry })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Foreman POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'

function checkAuth(request: NextRequest): boolean {
  return !!(process.env.ADMIN_PASSWORD && request.headers.get('x-admin-password') === process.env.ADMIN_PASSWORD)
}

/** 法定有給付与日数を計算 */
function calcLegalPL(hireDate: string, grantDate: string): number {
  if (!hireDate || !grantDate) return 0
  const hire = new Date(hireDate)
  const grant = new Date(grantDate)
  if (isNaN(hire.getTime()) || isNaN(grant.getTime())) return 0

  const diffMs = grant.getTime() - hire.getTime()
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000)

  if (diffYears < 0.5) return 0
  if (diffYears < 1.5) return 10
  if (diffYears < 2.5) return 11
  if (diffYears < 3.5) return 12
  if (diffYears < 4.5) return 14
  if (diffYears < 5.5) return 16
  if (diffYears < 6.5) return 18
  return 20
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const { action } = body

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (action === 'grant') {
      const { workerId, fy, grantDays, grantMonth, grantDate } = body
      const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }[]>
      const key = String(workerId)
      const records = plData[key] || []
      const idx = records.findIndex(r => r.fy === fy)

      const record = {
        fy,
        grantDate: grantDate || '',
        grantDays: Number(grantDays) || 0,
        carryOver: 0,
        adjustment: 0,
      }
      if (idx >= 0) {
        records[idx] = { ...records[idx], ...record }
      } else {
        records.push(record)
      }

      // Also store grantMonth on the worker if provided
      if (grantMonth) {
        const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
        const wIdx = workers.findIndex(w => w.id === Number(workerId))
        if (wIdx >= 0) {
          workers[wIdx].grantMonth = Number(grantMonth)
          plData[key] = records
          await updateDoc(docRef, { plData, workers })
        } else {
          plData[key] = records
          await updateDoc(docRef, { plData })
        }
      } else {
        plData[key] = records
        await updateDoc(docRef, { plData })
      }

      return NextResponse.json({ success: true })
    }

    if (action === 'carryOver') {
      const { fy } = body
      const prevFy = String(Number(fy) - 1)
      const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDays: number; carryOver: number; adjustment: number }[]>

      // Calculate previous FY PL usage
      const prevFyStart = parseInt(prevFy)
      const prevFyMonths: string[] = []
      for (let m = 10; m <= 12; m++) prevFyMonths.push(ymKey(prevFyStart, m))
      for (let m = 1; m <= 9; m++) prevFyMonths.push(ymKey(prevFyStart + 1, m))

      const allAtt: Record<string, Record<string, unknown>> = {}
      for (const ym of prevFyMonths) {
        const att = await getAttData(ym)
        Object.assign(allAtt, att.d)
      }

      const plUsage: Record<number, number> = {}
      for (const [key, entry] of Object.entries(allAtt)) {
        const e = entry as { p?: number }
        if (e.p && e.p === 1) {
          const wid = parseInt(key.split('_')[1])
          plUsage[wid] = (plUsage[wid] || 0) + 1
        }
      }

      for (const [wid, records] of Object.entries(plData)) {
        const prevRec = records.find(r => r.fy === prevFy)
        if (!prevRec) continue
        const prevTotal = prevRec.grantDays + prevRec.carryOver + prevRec.adjustment
        const prevUsed = plUsage[Number(wid)] || 0
        const prevRemaining = Math.max(0, prevTotal - prevUsed)

        const curIdx = records.findIndex(r => r.fy === fy)
        if (curIdx >= 0) {
          records[curIdx].carryOver = prevRemaining
        } else {
          records.push({ fy, grantDays: 0, carryOver: prevRemaining, adjustment: 0 })
        }
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true })
    }

    // Default: edit PL record
    const { workerId, fy, grantDays, carryOver, adjustment } = body
    const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }[]>
    const key = String(workerId)
    const records = plData[key] || []
    const idx = records.findIndex(r => r.fy === fy)

    const record = { fy, grantDays: Number(grantDays) || 0, carryOver: Number(carryOver) || 0, adjustment: Number(adjustment) || 0 }
    if (idx >= 0) records[idx] = { ...records[idx], ...record }
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
  const calendarMode = request.nextUrl.searchParams.get('calendar') === 'true'
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

    // Count PL usage per worker and build calendar data
    const plUsage: Record<number, number> = {}
    const plCalendar: Record<string, number[]> = {} // YYYYMMDD -> [workerIds]

    for (const [key, entry] of Object.entries(allAtt)) {
      const e = entry as { p?: number }
      if (e.p && e.p === 1) {
        const parts = key.split('_')
        const wid = parseInt(parts[1])
        const entryYm = parts[2]
        const entryDay = parts[3]
        plUsage[wid] = (plUsage[wid] || 0) + 1

        const dateKey = `${entryYm}${entryDay}`
        if (!plCalendar[dateKey]) plCalendar[dateKey] = []
        if (!plCalendar[dateKey].includes(wid)) plCalendar[dateKey].push(wid)
      }
    }

    // Worker name map for calendar tooltips
    const workerNames: Record<number, string> = {}
    main.workers.forEach(w => { workerNames[w.id] = w.name })

    // Build worker PL data
    const workers = main.workers
      .filter(w => !w.retired && w.job !== 'yakuin')
      .map(w => {
        const plRecords = (main.plData[String(w.id)] || []) as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }[]
        const fyRecord = plRecords.find(r => r.fy === fy)

        const grantDays = fyRecord?.grantDays || 0
        const carryOver = fyRecord?.carryOver || 0
        const adjustment = fyRecord?.adjustment || 0
        const grantDate = fyRecord?.grantDate || ''
        const total = grantDays + carryOver + adjustment
        const used = plUsage[w.id] || 0
        const remaining = total - used

        // Expiry calculation: grantDate + 2 years - 1 day
        let expiryDate = ''
        let expiryStatus: 'ok' | 'warning' | 'expired' = 'ok'
        if (grantDate) {
          const gd = new Date(grantDate)
          if (!isNaN(gd.getTime())) {
            const exp = new Date(gd)
            exp.setFullYear(exp.getFullYear() + 2)
            exp.setDate(exp.getDate() - 1)
            expiryDate = `${exp.getFullYear()}/${String(exp.getMonth() + 1).padStart(2, '0')}/${String(exp.getDate()).padStart(2, '0')}`

            const now = new Date()
            const diffDays = Math.floor((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
            if (diffDays < 0) expiryStatus = 'expired'
            else if (diffDays <= 60) expiryStatus = 'warning'
          }
        }

        // Legal PL calculation info
        const legalPL = w.hireDate ? calcLegalPL(w.hireDate, grantDate || new Date().toISOString().split('T')[0]) : 0

        return {
          id: w.id,
          name: w.name,
          org: w.org,
          visa: w.visa,
          hireDate: w.hireDate || '',
          grantDays,
          carryOver,
          adjustment,
          used,
          total,
          remaining: expiryStatus === 'expired' ? 0 : remaining,
          rate: total > 0 ? (used / total) * 100 : 0,
          grantMonth: (w as unknown as { grantMonth?: number }).grantMonth,
          grantDate,
          expiryDate,
          expiryStatus,
          legalPL,
        }
      })
      .filter(w => w.total > 0 || w.used > 0)

    const response: Record<string, unknown> = { workers }

    if (calendarMode) {
      response.plCalendar = plCalendar
      response.workerNames = workerNames
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Leave API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

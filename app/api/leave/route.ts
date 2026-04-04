import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { checkAndGrantPL } from '@/lib/leave-auto'

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
  if (!checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const { action } = body

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (action === 'updateGrantMonth') {
      const { workerId, grantMonth } = body
      const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
      const wIdx = workers.findIndex(w => w.id === Number(workerId))
      if (wIdx < 0) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
      if (grantMonth === null || grantMonth === '' || grantMonth === undefined) {
        delete workers[wIdx].grantMonth
      } else {
        workers[wIdx].grantMonth = Number(grantMonth)
      }
      await updateDoc(docRef, { workers })
      return NextResponse.json({ success: true })
    }

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
        const prevTotal = prevRec.grantDays + prevRec.carryOver  // adj is NOT part of total
        const prevPeriodUsed = plUsage[Number(wid)] || 0
        const prevUsed = prevRec.adjustment + prevPeriodUsed   // adj = pre-existing consumed
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
  if (!checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const fy = request.nextUrl.searchParams.get('fy') || '2025'
  const calendarMode = request.nextUrl.searchParams.get('calendar') === 'true'
  const fyStart = parseInt(fy)

  try {
    let main = await getMainData()

    // Auto-grant PL for eligible workers whose grant date has arrived
    const autoGranted = await checkAndGrantPL(main)
    if (autoGranted.length > 0) {
      // Re-read main data to get updated plData
      main = await getMainData()
    }

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
        const plRecords = (main.plData[String(w.id)] || []) as { fy: number | string; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number }[]
        // fy比較: Firestoreでは数値(2025)、APIパラメータは文字列('2025')なので両方対応
        const fyRecord = plRecords.find(r => String(r.fy) === String(fy))

        // 旧アプリのフィールド名(grant/carry/adj)と新アプリ(grantDays/carryOver/adjustment)の両方に対応
        const grantDays = fyRecord?.grantDays ?? fyRecord?.grant ?? 0
        const carryOver = fyRecord?.carryOver ?? fyRecord?.carry ?? 0
        const adjustment = fyRecord?.adjustment ?? fyRecord?.adj ?? 0
        const grantDate = fyRecord?.grantDate || ''
        const total = grantDays + carryOver  // adj is NOT added to total
        const periodUsed = plUsage[w.id] || 0  // PL days from attendance data
        const used = adjustment + periodUsed   // adj = pre-existing consumed days
        const remaining = Math.max(0, total - used)

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
          periodUsed,
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
      // Show all eligible workers (including those with no PL data yet)

    const response: Record<string, unknown> = { workers }

    if (calendarMode) {
      response.plCalendar = plCalendar
      response.workerNames = workerNames
    }

    if (autoGranted.length > 0) {
      response.autoGranted = autoGranted.map(g => ({
        name: g.name,
        days: g.days,
        grantDate: g.grantDate,
      }))
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Leave API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

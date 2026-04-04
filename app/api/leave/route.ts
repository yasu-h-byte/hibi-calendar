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

  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grant.getFullYear() - hire.getFullYear()) * 12
    + (grant.getMonth() - hire.getMonth())
    + (grant.getDate() >= hire.getDate() ? 0 : -1)

  if (diffMonths < 6) return 0
  if (diffMonths < 18) return 10
  if (diffMonths < 30) return 11
  if (diffMonths < 42) return 12
  if (diffMonths < 54) return 14
  if (diffMonths < 66) return 16
  if (diffMonths < 78) return 18
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
        used: 0,
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
      const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>

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
        // 旧フィールド(grant/carry/adj)のいずれかが存在すれば旧レコードと判定
        const isPrevOld = prevRec.grant != null || prevRec.adj != null || prevRec.carry != null
        const prevGrant = isPrevOld ? (prevRec.grant ?? prevRec.grantDays ?? 0) : (prevRec.grantDays || 0)
        const prevCarry = isPrevOld ? (prevRec.carry ?? 0) : (prevRec.carryOver || 0)
        const prevAdj = Math.max(prevRec.adjustment || 0, prevRec.adj || 0)
        const prevTotal = prevGrant + prevCarry
        const prevPeriodUsed = plUsage[Number(wid)] || 0
        const prevUsed = prevAdj + prevPeriodUsed
        const prevRemaining = Math.min(20, Math.max(0, prevTotal - prevUsed))  // 繰越上限20日

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

    const record = { fy, grantDays: Number(grantDays) || 0, carryOver: Number(carryOver) || 0, adjustment: Number(adjustment) || 0, used: 0 }
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
        // fy比較: 同じFYに複数レコードがある場合は最新（最後）を使用
        const fyRecords = plRecords.filter(r => String(r.fy) === String(fy))
        const fyRecord = fyRecords.length > 0 ? fyRecords[fyRecords.length - 1] : undefined

        // 旧アプリ(grant/carry/adj)と新アプリ(grantDays/carryOver/adjustment)の両方に対応
        // 旧フィールドが存在する場合はそちらが元データなので優先する
        // ただし旧アプリは値が0のときフィールド自体を省略する場合があるため、
        // adjが存在する＝旧アプリのレコードと判定し、carry未定義でも0とみなす
        const isOldRecord = fyRecord?.grant != null || fyRecord?.adj != null || fyRecord?.carry != null
        const grantDays = isOldRecord ? (fyRecord?.grant ?? fyRecord?.grantDays ?? 0) : (fyRecord?.grantDays ?? 0)
        const carryOver = isOldRecord ? (fyRecord?.carry ?? 0) : (fyRecord?.carryOver ?? 0)
        // adj（旧）とadjustment（新）が両方存在する場合、大きい方を使う（旧データの方が正確な場合がある）
        const adjustment = Math.max(fyRecord?.adjustment ?? 0, fyRecord?.adj ?? 0)
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

        // 年5日取得義務チェック
        // 条件: 外国人 + 年10日以上付与 + 有効期限まで残り3ヶ月以内 + 5日未満消化
        let fiveDayShortfall = 0
        const isGaikoku = w.visa && w.visa !== 'none'
        if (isGaikoku && grantDays >= 10 && periodUsed < 5) {
          if (expiryDate) {
            const exp = new Date(expiryDate)
            const now = new Date()
            const diffDays = Math.floor((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
            if (diffDays <= 90) {  // 残り3ヶ月（90日）以内
              fiveDayShortfall = 5 - periodUsed
            }
          }
        }

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
          fiveDayShortfall,
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

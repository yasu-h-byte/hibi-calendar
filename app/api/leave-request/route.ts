import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, ymKey, attKey, setAttendanceEntry } from '@/lib/attendance'
import { getMainData, getAttData } from '@/lib/compute'

interface LeaveRequest {
  workerId: number
  workerName: string
  date: string          // YYYY-MM-DD
  ym: string            // YYYYMM
  day: number           // day of month
  siteId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  requestedAt: string
  reviewedAt?: string
  reviewedBy?: number
  rejectedReason?: string
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    // ── Staff: submit leave request ──
    if (action === 'request') {
      const { token, date, siteId, reason } = body

      if (!token || !date) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const worker = await getWorkerByToken(token)
      if (!worker) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }

      // Only foreign workers can request
      if (!worker.visaType || worker.visaType === 'none') {
        return NextResponse.json({ error: 'Not eligible' }, { status: 403 })
      }

      // Validate date is at least next day (JST)
      const now = new Date()
      // Convert to JST for date comparison
      const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
      const todayStr = `${jstNow.getFullYear()}-${String(jstNow.getMonth() + 1).padStart(2, '0')}-${String(jstNow.getDate()).padStart(2, '0')}`

      // 過去日は不可。当日と未来日はOK（当日有給申請に対応）
      if (date < todayStr) {
        return NextResponse.json({ error: 'Date must be today or future' }, { status: 400 })
      }

      // Parse date
      const [yearStr, monthStr, dayStr] = date.split('-')
      const year = parseInt(yearStr)
      const month = parseInt(monthStr)
      const day = parseInt(dayStr)
      const ym = ymKey(year, month)

      // Determine siteId: use provided or first assigned site
      let resolvedSiteId = siteId
      if (!resolvedSiteId) {
        const sites = await getStaffSites(worker.id)
        if (sites.length > 0) {
          resolvedSiteId = sites[0].id
        } else {
          return NextResponse.json({ error: 'No site assigned' }, { status: 400 })
        }
      }

      // Check for duplicate
      const docId = `${worker.id}_${date.replace(/-/g, '')}`
      const docRef = doc(db, 'leaveRequests', docId)
      const existing = await getDoc(docRef)
      if (existing.exists()) {
        const data = existing.data() as LeaveRequest
        if (data.status !== 'rejected') {
          return NextResponse.json({ error: 'Already requested' }, { status: 409 })
        }
        // If rejected, allow re-request
      }

      // ── 有給残日数チェック ──
      // 各スタッフの最新PLレコードから残日数を計算
      const main = await getMainData()
      const wKey = String(worker.id)
      const plRecords = (main.plData[wKey] || []) as { fy: string | number; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number }[]

      // 最新のレコードを使用（付与日数が入っているもの）
      const recordsWithGrant = plRecords.filter(r =>
        (r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0)
      )
      const fyRecord = recordsWithGrant.length > 0 ? recordsWithGrant[recordsWithGrant.length - 1] : null

      if (fyRecord) {
        const isOldRecord = fyRecord.grant != null || fyRecord.adj != null || fyRecord.carry != null
        const grantDays = isOldRecord ? (fyRecord.grant ?? fyRecord.grantDays ?? 0) : (fyRecord.grantDays ?? 0)
        const carryOver = isOldRecord ? (fyRecord.carry ?? 0) : (fyRecord.carryOver ?? 0)
        const adjustment = Math.max(fyRecord.adjustment ?? 0, fyRecord.adj ?? 0)
        const total = grantDays + carryOver

        // 付与日から1年間の出面データからPL消化日数を集計
        let periodUsed = 0
        const grantDate = fyRecord.grantDate ? new Date(fyRecord.grantDate) : null
        if (grantDate && !isNaN(grantDate.getTime())) {
          const gdEnd = new Date(grantDate)
          gdEnd.setFullYear(gdEnd.getFullYear() + 1)
          const startYm = ymKey(grantDate.getFullYear(), grantDate.getMonth() + 1)
          const endYm = ymKey(gdEnd.getFullYear(), gdEnd.getMonth() + 1)

          // 付与日から1年間の月をカバー
          const checkMonths: string[] = []
          let cur = new Date(grantDate.getFullYear(), grantDate.getMonth(), 1)
          while (ymKey(cur.getFullYear(), cur.getMonth() + 1) <= endYm) {
            checkMonths.push(ymKey(cur.getFullYear(), cur.getMonth() + 1))
            cur.setMonth(cur.getMonth() + 1)
          }

          for (const fym of checkMonths) {
            const att = await getAttData(fym)
            for (const [key, entry] of Object.entries(att.d)) {
              const e = entry as { p?: number }
              if (e.p === 1) {
                const wid = parseInt(key.split('_')[1])
                if (wid === worker.id) {
                  const entryYm = key.split('_')[2]
                  const entryDay = key.split('_')[3]
                  const entryDate = new Date(parseInt(entryYm.slice(0, 4)), parseInt(entryYm.slice(4, 6)) - 1, parseInt(entryDay))
                  if (entryDate >= grantDate && entryDate < gdEnd) periodUsed++
                }
              }
            }
          }
        }

        // pending の申請もカウント
        const pendingQ = query(
          collection(db, 'leaveRequests'),
          where('workerId', '==', worker.id),
          where('status', '==', 'pending')
        )
        const pendingSnap = await getDocs(pendingQ)
        const pendingCount = pendingSnap.size

        const used = adjustment + periodUsed + pendingCount
        const remaining = Math.max(0, total - used)

        if (remaining <= 0) {
          return NextResponse.json({ error: 'No remaining leave' }, { status: 400 })
        }
      } else {
        return NextResponse.json({ error: 'No remaining leave' }, { status: 400 })
      }

      const leaveReq: LeaveRequest = {
        workerId: worker.id,
        workerName: worker.name,
        date,
        ym,
        day,
        siteId: resolvedSiteId,
        reason: reason || '',
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }

      await setDoc(docRef, leaveReq)
      return NextResponse.json({ success: true, id: docId })
    }

    // ── Admin: approve leave request ──
    if (action === 'approve') {
      if (!checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { requestId, approvedBy } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
      if (data.status !== 'pending') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      // Update status
      await setDoc(docRef, {
        ...data,
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: approvedBy || 0,
      })

      // Write attendance: { w: 0, p: 1 }
      await setAttendanceEntry(data.siteId, data.workerId, data.ym, data.day, { w: 0, p: 1 })

      return NextResponse.json({ success: true })
    }

    // ── Admin: reject leave request ──
    if (action === 'reject') {
      if (!checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { requestId, rejectedBy, reason } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
      if (data.status !== 'pending') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      await setDoc(docRef, {
        ...data,
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewedBy: rejectedBy || 0,
        rejectedReason: reason || '',
      })

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Leave request POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')
    const ym = request.nextUrl.searchParams.get('ym')

    // Staff: get own requests by token
    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }

      const q = query(
        collection(db, 'leaveRequests'),
        where('workerId', '==', worker.id)
      )
      const snap = await getDocs(q)
      const requests: (LeaveRequest & { id: string })[] = []
      snap.forEach(d => {
        requests.push({ id: d.id, ...(d.data() as LeaveRequest) })
      })

      // Sort by date descending
      requests.sort((a, b) => b.date.localeCompare(a.date))

      return NextResponse.json({ requests })
    }

    // Admin: get all requests for a month
    if (checkApiAuth(request)) {
      const q = ym
        ? query(collection(db, 'leaveRequests'), where('ym', '==', ym))
        : query(collection(db, 'leaveRequests'))

      const snap = await getDocs(q)
      const requests: (LeaveRequest & { id: string })[] = []
      snap.forEach(d => {
        requests.push({ id: d.id, ...(d.data() as LeaveRequest) })
      })

      // Sort: pending first, then by date
      requests.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1
        if (a.status !== 'pending' && b.status === 'pending') return 1
        return b.date.localeCompare(a.date)
      })

      return NextResponse.json({ requests })
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } catch (error) {
    console.error('Leave request GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

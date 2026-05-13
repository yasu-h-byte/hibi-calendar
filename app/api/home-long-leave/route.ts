import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, ymKey, setAttendanceEntry } from '@/lib/attendance'
import { AttendanceEntry } from '@/types'

interface HomeLongLeave {
  workerId: number
  workerName: string
  startDate: string    // YYYY-MM-DD
  endDate: string      // YYYY-MM-DD
  reason: string       // '一時帰国' | 'ビザ更新帰国' | 'その他'
  note?: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled'
  requestedAt: string
  foremanApprovedAt?: string
  foremanApprovedBy?: number
  reviewedAt?: string
  reviewedBy?: number
  rejectedReason?: string
  cancelledAt?: string
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    // ── Staff: submit home long leave request ──
    if (action === 'request') {
      const { token, startDate, endDate, reason, note } = body

      if (!token || !startDate || !endDate) {
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

      // Validate startDate < endDate
      if (startDate >= endDate) {
        return NextResponse.json({ error: 'Start date must be before end date' }, { status: 400 })
      }

      // Validate dates are at least 90 days (3 months) in the future (JST)
      const now = new Date()
      const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
      const minDate = new Date(jstNow)
      minDate.setDate(minDate.getDate() + 90)
      const minDateStr = `${minDate.getFullYear()}-${String(minDate.getMonth() + 1).padStart(2, '0')}-${String(minDate.getDate()).padStart(2, '0')}`

      if (startDate < minDateStr) {
        return NextResponse.json({ error: 'Start date must be at least 90 days ahead' }, { status: 400 })
      }

      // Check for duplicate
      // 却下 (rejected) または 取り消し (cancelled) されたものは再申請OK
      const docId = `${worker.id}_${startDate}`
      const docRef = doc(db, 'homeLongLeave', docId)
      const existing = await getDoc(docRef)
      if (existing.exists()) {
        const data = existing.data() as HomeLongLeave
        if (data.status !== 'rejected' && data.status !== 'cancelled') {
          return NextResponse.json({ error: 'Already requested' }, { status: 409 })
        }
        // rejected または cancelled は新しい申請で上書き許可
      }

      const leaveReq: HomeLongLeave = {
        workerId: worker.id,
        workerName: worker.name,
        startDate,
        endDate,
        reason: reason || '一時帰国',
        ...(note ? { note } : {}),
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }

      await setDoc(docRef, leaveReq)
      return NextResponse.json({ success: true, id: docId })
    }

    // ── 職長: 帰国申請を承認（第1段階） ──
    if (action === 'foreman_approve') {
      const { requestId, foremanId, token } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      // 認証: トークンまたは管理者パスワード
      let authWorkerId = foremanId || 0
      if (token) {
        const worker = await getWorkerByToken(token)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        authWorkerId = worker.id
      } else if (!await checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const docRef = doc(db, 'homeLongLeave', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as HomeLongLeave
      if (data.status !== 'pending') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      await setDoc(docRef, {
        ...data,
        status: 'foreman_approved',
        foremanApprovedAt: new Date().toISOString(),
        foremanApprovedBy: authWorkerId,
      })

      return NextResponse.json({ success: true })
    }

    // ── 事業責任者: 最終承認（第2段階） ──
    if (action === 'approve') {
      if (!await checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { requestId, approvedBy } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      const docRef = doc(db, 'homeLongLeave', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as HomeLongLeave
      if (data.status !== 'foreman_approved') {
        // 後方互換: pending から直接承認も許可（管理者権限）
        if (data.status !== 'pending') {
          return NextResponse.json({ error: 'Already processed' }, { status: 409 })
        }
      }

      // Update status
      await setDoc(docRef, {
        ...data,
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: approvedBy || 0,
      })

      // Determine worker's site
      const sites = await getStaffSites(data.workerId)
      const siteId = sites.length > 0 ? sites[0].id : ''

      if (siteId) {
        // Write attendance entries { w: 0, hk: 1 } for all weekdays in the date range (skip Sundays)
        // ⚠️ 既存の有給(p)・休み(r)・出勤エントリがある日は上書きしない（2026-05-08 修正）
        //   既存エントリの上書きは setDoc(merge:true) でも以前は p/r フィールドが残るが、
        //   compute.ts は entry.hk を最初に判定するため、有給日数(plDays)カウントから外れる事故が起きていた。
        const { getAttendanceDoc } = await import('@/lib/attendance')
        const start = new Date(data.startDate + 'T00:00:00')
        const end = new Date(data.endDate + 'T00:00:00')
        const current = new Date(start)
        const skippedDates: string[] = []

        // 期間中に跨る各月の att データをキャッシュして既存エントリ確認
        const attCache: Record<string, Record<string, AttendanceEntry>> = {}
        const getAtt = async (ym: string) => {
          if (!attCache[ym]) attCache[ym] = await getAttendanceDoc(ym)
          return attCache[ym]
        }

        while (current <= end) {
          const dow = current.getDay()
          if (dow !== 0) { // Skip Sundays
            const year = current.getFullYear()
            const month = current.getMonth() + 1
            const day = current.getDate()
            const ym = ymKey(year, month)
            const key = `${siteId}_${data.workerId}_${ym}_${String(day)}`
            const att = await getAtt(ym)
            const existing = att[key]

            // 既に有給(p) / 休み(r) / 出勤(w>0) が記録されている日はスキップ
            const hasP = existing && existing.p && existing.p > 0
            const hasR = existing && existing.r && existing.r > 0
            const hasWork = existing && existing.w && existing.w > 0
            if (hasP || hasR || hasWork) {
              skippedDates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
            } else {
              await setAttendanceEntry(siteId, data.workerId, ym, day, { w: 0, hk: 1 })
            }
          }
          current.setDate(current.getDate() + 1)
        }

        if (skippedDates.length > 0) {
          console.warn(`[home-long-leave/approve] 既存エントリありスキップ: ${data.workerName} (${data.workerId}) - ${skippedDates.join(', ')}`)
        }
      }

      // 2026-05-13: 旧仕様で demmen/main.homeLeaves 配列にコピーを作っていたが、
      //   dual storage の不整合源だったため廃止。homeLongLeave/{id} が単一ソース。

      return NextResponse.json({ success: true })
    }

    // ── 却下（職長 or 管理者） ──
    if (action === 'reject') {
      const { requestId, rejectedBy, reason, token: rejectToken } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      let authWorkerId = rejectedBy || 0
      if (rejectToken) {
        const worker = await getWorkerByToken(rejectToken)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        authWorkerId = worker.id
      } else if (!await checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const docRef = doc(db, 'homeLongLeave', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as HomeLongLeave
      if (data.status === 'approved' || data.status === 'rejected') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      await setDoc(docRef, {
        ...data,
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewedBy: authWorkerId,
        rejectedReason: reason || '',
      })

      return NextResponse.json({ success: true })
    }

    // ── Staff: 自分の帰国申請を取り消す（pending のみ可能） ──
    if (action === 'cancel') {
      const { requestId, token } = body
      if (!requestId || !token) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }
      const worker = await getWorkerByToken(token)
      if (!worker) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }

      const docRef = doc(db, 'homeLongLeave', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }
      const data = snap.data() as HomeLongLeave
      if (data.workerId !== worker.id) {
        return NextResponse.json({ error: 'Not your request' }, { status: 403 })
      }
      if (data.status !== 'pending') {
        return NextResponse.json({
          error: '職長が承認した後は取り消しできません。会社に連絡してください。',
        }, { status: 409 })
      }

      await setDoc(docRef, {
        ...data,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
      })

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Home long leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')

    // Staff: get own requests by token
    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }

      const q = query(
        collection(db, 'homeLongLeave'),
        where('workerId', '==', worker.id)
      )
      const snap = await getDocs(q)
      const requests: (HomeLongLeave & { id: string })[] = []
      snap.forEach(d => {
        requests.push({ id: d.id, ...(d.data() as HomeLongLeave) })
      })

      // Sort by startDate descending
      requests.sort((a, b) => b.startDate.localeCompare(a.startDate))

      return NextResponse.json({ requests })
    }

    // Admin: get all pending + foreman_approved requests
    if (await checkApiAuth(request)) {
      const allSnap = await getDocs(collection(db, 'homeLongLeave'))
      const requests: (HomeLongLeave & { id: string })[] = []
      allSnap.forEach(d => {
        const data = d.data() as HomeLongLeave
        if (data.status === 'pending' || data.status === 'foreman_approved') {
          requests.push({ id: d.id, ...data })
        }
      })

      // Sort: pending first, then by startDate
      requests.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1
        if (a.status !== 'pending' && b.status === 'pending') return 1
        return b.startDate.localeCompare(a.startDate)
      })

      return NextResponse.json({ requests })
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } catch (error) {
    console.error('Home long leave GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

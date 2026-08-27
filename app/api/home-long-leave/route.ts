import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where } from '@/lib/fsdb'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, ymKey } from '@/lib/attendance'

/**
 * 申請者の配置現場を担当する職長の workerId 集合を返す（権限判定用）。
 * 2026-06-12 (監査 Sprint2-B): leave-request の foreman_approve 権限チェックの横展開。
 */
async function getForemenOfWorkerSites(workerId: number): Promise<Set<number>> {
  const result = new Set<number>()
  const staffSites = await getStaffSites(workerId)
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const sites = (mainSnap.exists() ? mainSnap.data().sites || [] : []) as { id: string; foremen?: number[]; foreman?: number }[]
  for (const ss of staffSites) {
    const site = sites.find(s => s.id === ss.id)
    if (!site) continue
    for (const f of site.foremen || (site.foreman ? [site.foreman] : [])) result.add(f)
  }
  return result
}

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
      // 2026-06-12 (監査 Sprint2-B): 権限チェックを leave-request と同水準に横展開。
      //   旧: 任意の有効スタッフ token で他人の帰国申請を職長承認できた
      const { requestId, token } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
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

      // 申請者の配置現場の職長一覧（権限判定用）
      const allowedForemen = await getForemenOfWorkerSites(data.workerId)

      let authWorkerId: number | string = 'unknown'
      if (token) {
        const worker = await getWorkerByToken(token)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        if (!allowedForemen.has(worker.id)) {
          return NextResponse.json({ error: '申請者の配置現場の職長権限がありません' }, { status: 403 })
        }
        authWorkerId = worker.id
      } else {
        const authUser = await getApiAuthUser(request)
        if (!authUser.authorized) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (typeof authUser.actor === 'number' && !allowedForemen.has(authUser.actor)) {
          return NextResponse.json({ error: '申請者の配置現場の職長権限がありません' }, { status: 403 })
        }
        authWorkerId = authUser.actor
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

      // 2026-06-12 (監査 Sprint2-B): 期間に含まれる月がロック済みなら承認を拒否
      //   （hk 書込は欠勤控除に影響するため、給与確定後の変更を防ぐ）
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const yms = new Set<string>()
        const cur = new Date(data.startDate + 'T00:00:00')
        const endD = new Date(data.endDate + 'T00:00:00')
        while (cur <= endD) {
          yms.add(ymKey(cur.getFullYear(), cur.getMonth() + 1))
          cur.setDate(cur.getDate() + 1)
        }
        for (const ymCheck of yms) {
          const lockErr = await checkMonthLocked(ymCheck)
          if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
        }
      }

      // 2026-08-20 追加: 帰国期間の中に出勤打刻がある日が無いか承認前に確認する。
      //   終了日に「復帰日」を入れる入力ミスが繰り返し起きたため（ファン/フン事案）。
      //   承認してしまうと出面に hk が書かれ給与の日割りに直結するので、ここで止める。
      //   force:true が明示されたときだけ通す（帰国中の一時出勤など正当なケース用）。
      if (!body.force) {
        const { findWorkedDaysInHomeLeave } = await import('@/lib/home-leave-sync')
        const conflicts = await findWorkedDaysInHomeLeave(data.workerId, data.startDate, data.endDate)
        if (conflicts.length > 0) {
          return NextResponse.json({
            error: 'WORKED_DAYS_IN_RANGE',
            message: `申請期間の中に出勤打刻のある日が ${conflicts.length}日 あります。終了日が「復帰日」になっていないか確認してください（終了日は最終帰国日です）。`,
            conflicts,
          }, { status: 409 })
        }
      }

      // Update status
      await setDoc(docRef, {
        ...data,
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: approvedBy || 0,
      })

      // 出面の帰国フラグを同期（2026-08-03: lib/home-leave-sync.ts に一元化）
      //   旧実装は日ごとに setAttendanceEntry を呼ぶ書き込みループで、
      //   ① 復帰未定(9999-12-31)だと事実上無限に書き込む
      //   ② 承認以外の経路（手動登録・期間変更・削除）と同期処理を共有していない
      //   という2点の問題があった。共通ヘルパーは月単位の冪等 reconcile で両方を解消する。
      const { syncHomeLeaveAttendance } = await import('@/lib/home-leave-sync')
      const syncResult = await syncHomeLeaveAttendance(
        data.workerId,
        null,
        { startDate: data.startDate, endDate: data.endDate },
      )
      if (syncResult.skipped.length > 0) {
        console.warn(`[home-long-leave/approve] 既存実績ありスキップ: ${data.workerName} (${data.workerId}) - ${syncResult.skipped.join(', ')}`)
      }

      // 2026-05-13: 旧仕様で demmen/main.homeLeaves 配列にコピーを作っていたが、
      //   dual storage の不整合源だったため廃止。homeLongLeave/{id} が単一ソース。

      return NextResponse.json({ success: true })
    }

    // ── 却下（職長 or 管理者） ──
    if (action === 'reject') {
      const { requestId, reason, token: rejectToken } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
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

      // 2026-06-12 (監査 Sprint2-B): token 却下は「申請者の配置現場の職長」のみ。
      //   旧: 任意の有効スタッフ token で他人の申請を却下できた
      let authWorkerId: number | string = 0
      if (rejectToken) {
        const worker = await getWorkerByToken(rejectToken)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        const allowedForemen = await getForemenOfWorkerSites(data.workerId)
        if (!allowedForemen.has(worker.id)) {
          return NextResponse.json({ error: '申請者の配置現場の職長権限がありません' }, { status: 403 })
        }
        authWorkerId = worker.id
      } else {
        const authUser = await getApiAuthUser(request)
        if (!authUser.authorized) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        authWorkerId = authUser.actor
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
          error: '職長が承認した後は取り消しできません。会社に連絡してください。 / Sau khi tổ trưởng duyệt thì không thể hủy. Vui lòng liên hệ công ty.',
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

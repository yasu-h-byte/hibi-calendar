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

      // Validate startDate < endDate（2026-08-27: 書式と期間長も検証。
      //   不正な endDate（番兵級の未来日）が承認処理のループ暴走・hk過剰スタンプの元だった）
      const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
      if (!ISO_RE.test(startDate) || !ISO_RE.test(endDate)) {
        return NextResponse.json({ error: '日付の形式が不正です / Ngày không hợp lệ' }, { status: 400 })
      }
      if (startDate >= endDate) {
        return NextResponse.json({ error: 'Start date must be before end date' }, { status: 400 })
      }
      {
        // UI の上限（180日）と同じ制限をサーバでも強制
        const sd = new Date(startDate + 'T00:00:00Z')
        const ed = new Date(endDate + 'T00:00:00Z')
        if ((ed.getTime() - sd.getTime()) / 86400000 > 185) {
          return NextResponse.json({ error: '帰国期間が長すぎます（最大180日）。復帰未定の場合は会社に連絡してください / Thời gian về nước quá dài (tối đa 180 ngày)' }, { status: 400 })
        }
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
      // 2026-08-27 追加: 開始日をずらした「期間の重なる申請」も拒否（doc id 一致だけでは防げない）
      {
        const dupSnap = await getDocs(query(collection(db, 'homeLongLeave'), where('workerId', '==', worker.id)))
        let overlap = null as { s: string; e: string } | null
        dupSnap.forEach(dd => {
          if (overlap || dd.id === docId) return
          const v = dd.data() as { startDate?: string; endDate?: string; status?: string }
          if (!v.startDate || !v.endDate) return
          if (v.status !== 'approved' && v.status !== 'pending' && v.status !== 'foreman_approved') return
          if (startDate <= v.endDate && v.startDate <= endDate) overlap = { s: v.startDate, e: v.endDate }
        })
        if (overlap) {
          return NextResponse.json({
            error: `既存の申請期間（${overlap.s}〜${overlap.e}）と重なっています / Trùng với đơn đã có (${overlap.s}〜${overlap.e})`,
          }, { status: 409 })
        }
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
      // 2026-08-27（休暇届総点検）: 最終承認は代表・事業責任者のみ
      //   （旧: 任意の個人パスワードで最終承認できた。有給 approve と同一基準に統一）
      const { requireExecutiveAuth, getApiAuthUser } = await import('@/lib/auth')
      { const denied = await requireExecutiveAuth(request); if (denied) return denied }
      const authForApprove = await getApiAuthUser(request)

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
      // 2026-08-27 修正: 走査を日単位→月単位に変更し、復帰未定（番兵 9999-12-31）でも
      //   12ヶ月で打ち切る（旧: 1日ずつ約290万回転で checkMonthLocked を叩き
      //   タイムアウト＋クォータ浪費の恐れがあった）。ロック判定は本人の org で行う
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const { getWorkers } = await import('@/lib/workers')
        const company = (await getWorkers()).find(w => w.id === data.workerId)?.company
        const org = company === 'HFU' ? 'hfu' : company ? 'hibi' : undefined
        let ymCur = data.startDate.slice(0, 7).replace('-', '')
        const endYmRaw = data.endDate.slice(0, 7).replace('-', '')
        let guard = 0
        while (ymCur <= endYmRaw && guard++ < 13) {
          const lockErr = await checkMonthLocked(ymCur, org)
          if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
          const y = Number(ymCur.slice(0, 4)); const m = Number(ymCur.slice(4, 6))
          ymCur = m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`
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
        // 認証者から記録（body の自己申告は表示用フォールバック）
        reviewedBy: authForApprove.authorized && typeof authForApprove.actor === 'number'
          ? authForApprove.actor : (approvedBy ?? 0),
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
        { excludeDocId: requestId },
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

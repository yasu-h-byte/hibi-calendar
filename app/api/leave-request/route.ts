import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where, updateDoc, deleteField } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, ymKey, attKey, setAttendanceEntry } from '@/lib/attendance'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { ensureDocExists } from '@/lib/firestore-safe'
import { logActivity } from '@/lib/activity'

interface LeaveRequest {
  workerId: number
  workerName: string
  date: string          // YYYY-MM-DD
  ym: string            // YYYYMM
  day: number           // day of month
  siteId: string
  reason: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled'
  requestedAt: string
  // 職長承認
  foremanApprovedAt?: string
  foremanApprovedBy?: number
  // 最終承認（事業責任者）
  reviewedAt?: string
  reviewedBy?: number
  rejectedReason?: string
  // スタッフによる取り消し
  cancelledAt?: string
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
      // 却下 (rejected) または 取り消し (cancelled) されたものは上から再申請OK。
      // それ以外（pending / foreman_approved / approved）は重複として弾く
      const docId = `${worker.id}_${date.replace(/-/g, '')}`
      const docRef = doc(db, 'leaveRequests', docId)
      const existing = await getDoc(docRef)
      if (existing.exists()) {
        const data = existing.data() as LeaveRequest
        if (data.status !== 'rejected' && data.status !== 'cancelled') {
          return NextResponse.json({ error: 'Already requested' }, { status: 409 })
        }
        // rejected または cancelled は新しい申請で上書き許可
      }

      // ── 有給残日数チェック ──
      // 各スタッフの最新PLレコードから残日数を計算
      const main = await getMainData()
      const wKey = String(worker.id)
      const plRecords = (main.plData[wKey] || []) as { fy: string | number; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number; _archived?: boolean }[]

      // 最新のレコード（付与日数があるもの、archivedは除外）
      // 新フィールド優先・旧フィールドにフォールバック
      const recordsWithGrant = plRecords.filter(r =>
        !r._archived && ((r.grantDays ?? r.grant ?? 0) > 0)
      )
      const fyRecord = recordsWithGrant.length > 0
        ? recordsWithGrant[recordsWithGrant.length - 1] : null

      if (fyRecord) {
        // 新優先・旧フォールバック（GET側と統一）
        const grantDays   = fyRecord.grantDays  ?? fyRecord.grant  ?? 0
        const carryOver   = fyRecord.carryOver  ?? fyRecord.carry  ?? 0
        const adjustment  = fyRecord.adjustment ?? fyRecord.adj    ?? 0
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
              if (!entry) continue
              const e = entry as { p?: number }
              if (e.p === 1) {
                const pk = parseDKey(key)
                if (parseInt(pk.wid) === worker.id) {
                  const entryDate = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                  if (entryDate >= grantDate && entryDate < gdEnd) periodUsed++
                }
              }
            }
          }
        }

        // pending の申請もカウント
        // 2026-06-XX 修正 (CR-6): 当期 (grantDate〜+1年) 内の pending のみカウント
        //   旧: 全期間の pending → 来期分も控除 → 当期残あるのに却下されるバグ
        //   新: 当期内日付の pending のみ
        const pendingQ = query(
          collection(db, 'leaveRequests'),
          where('workerId', '==', worker.id),
          where('status', '==', 'pending')
        )
        const pendingSnap = await getDocs(pendingQ)
        const gdStartIso = grantDate ? grantDate.toISOString().slice(0, 10) : ''
        const gdEndIso = grantDate ? (() => {
          const e = new Date(grantDate)
          e.setFullYear(e.getFullYear() + 1)
          return e.toISOString().slice(0, 10)
        })() : ''
        const pendingCount = pendingSnap.docs.filter(d => {
          const pd = d.data().date
          if (!pd) return false
          if (!gdStartIso || !gdEndIso) return true  // grantDate なし時は従来通り全カウント
          return pd >= gdStartIso && pd < gdEndIso
        }).length

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

    // ── 職長: 有給申請を承認（第1段階） ──
    if (action === 'foreman_approve') {
      // 職長はトークン認証またはadmin認証
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

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
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

      // Write attendance: { w: 0, p: 1 }
      await setAttendanceEntry(data.siteId, data.workerId, data.ym, data.day, { w: 0, p: 1 })

      return NextResponse.json({ success: true })
    }

    // ── 却下（職長 or 管理者） ──
    if (action === 'reject') {
      // 職長もadminも却下可能
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

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
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

    // ── Staff: 自分の申請を取り消す（pending のみ可能） ──
    if (action === 'cancel') {
      const { requestId, token } = body
      if (!requestId || !token) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      // token で本人認証
      const worker = await getWorkerByToken(token)
      if (!worker) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
      // 本人の申請のみ取り消し可能
      if (data.workerId !== worker.id) {
        return NextResponse.json({ error: 'Not your request' }, { status: 403 })
      }
      // pending のみ取り消し可能（職長承認後は取り消し不可）
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

    // ── 管理者: 承認済み有給の取消（労使協定・社内ポリシー対応） ──
    //   - admin/approver 限定（職長は不可）
    //   - status='approved' のみ対象
    //   - att の p=1 をピンポイント削除（他の併存フィールドは保持）
    //   - leaveRequest doc に revoked 状態 + 履歴を記録
    if (action === 'revoke') {
      const authUser = await getApiAuthUser(request)
      if (!authUser.authorized) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      // admin / super-admin / 承認者(政仁さん, workerId=1) のみ
      const isAdmin = authUser.actor === 'admin' || authUser.actor === 'super-admin'
      const isApprover = typeof authUser.actor === 'number' && authUser.actor === 1  // 政仁さん
      if (!isAdmin && !isApprover) {
        return NextResponse.json({ error: 'Admin/approver only' }, { status: 403 })
      }
      const { requestId, reason } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }
      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }
      const data = snap.data() as LeaveRequest
      if (data.status !== 'approved' && data.status !== 'foreman_approved') {
        return NextResponse.json({ error: 'Only approved/foreman_approved can be revoked' }, { status: 409 })
      }
      // att から p=1 をピンポイント削除（IM-11 と同じく他フィールドは温存）
      const attYm = data.date.replace(/-/g, '').slice(0, 6)
      const attDay = data.date.slice(8, 10).replace(/^0/, '')
      const attRef = doc(db, 'demmen', `att_${attYm}`)
      // siteId 不明なので main から取得（落ち着いた dispatch）
      const siteIdForAtt = data.siteId || 'unknown'
      const attKey = `${siteIdForAtt}_${data.workerId}_${attYm}_${attDay}`
      try {
        await updateDoc(attRef, { [`d.${attKey}.p`]: deleteField() })
      } catch (delErr) {
        console.warn('[revoke] att p 削除失敗 (siteId 違いの可能性):', delErr)
      }
      // leaveRequest doc を revoked 状態に
      const revokeHistory = (data as { revokeHistory?: unknown[] }).revokeHistory || []
      const actorStr = String(authUser.actor)
      await updateDoc(docRef, {
        status: 'revoked',
        revokedAt: new Date().toISOString(),
        revokedBy: actorStr,
        revokedReason: reason || '',
        revokeHistory: [
          ...revokeHistory,
          {
            at: new Date().toISOString(),
            by: actorStr,
            previousStatus: data.status,
            reason: reason || '',
          },
        ],
      })
      return NextResponse.json({ success: true })
    }

    // ── 管理者: 承認済み有給の日付を変更（誤申請の修正用） ──
    //   - admin/approver 限定
    //   - status='approved' or 'foreman_approved' のみ対象
    //   - 旧日付の att エントリから p=1 を削除、新日付に p=1 を書込
    //   - leaveRequest doc に新日付・previousDate を記録、activity ログ出力
    if (action === 'modify_date') {
      if (!await checkApiAuth(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { requestId, newDate, modifiedBy } = body
      if (!requestId || !newDate) {
        return NextResponse.json({ error: 'requestId and newDate required' }, { status: 400 })
      }
      // newDate format: "YYYY-MM-DD"
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(newDate)
      if (!dateMatch) {
        return NextResponse.json({ error: 'Invalid newDate format (YYYY-MM-DD required)' }, { status: 400 })
      }
      const newYm = `${dateMatch[1]}${dateMatch[2]}`
      const newDay = parseInt(dateMatch[3], 10)

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }
      const data = snap.data() as LeaveRequest

      // 承認済み (or 職長承認済み) のみ日付変更可能
      if (data.status !== 'approved' && data.status !== 'foreman_approved') {
        return NextResponse.json({
          error: `承認前の申請は日付変更できません（現在: ${data.status}）。スタッフ本人に取消してもらい、再申請してください。`,
        }, { status: 409 })
      }

      // 既に同じ日付なら何もしない（誤操作防止）
      if (data.date === newDate) {
        return NextResponse.json({ success: true, noop: true })
      }

      // approved 状態の場合は att データの差し替えが必要
      if (data.status === 'approved') {
        // 2026-06-XX 修正 (IM-11): p フィールドのみピンポイント削除
        //   旧: エントリ全体を deleteField() → 併存フィールド (m, r, note 等) も巻添え消失
        //   新: dot-notation で .p のみ削除 → 他フィールドは温存
        const oldKey = attKey(data.siteId, data.workerId, data.ym, data.day)
        const oldAttRef = doc(db, 'demmen', `att_${data.ym}`)
        await ensureDocExists(oldAttRef)
        await updateDoc(oldAttRef, { [`d.${oldKey}.p`]: deleteField() })

        // 新日付に p=1 を書込
        await setAttendanceEntry(data.siteId, data.workerId, newYm, newDay, { w: 0, p: 1 })
      }

      // leaveRequest doc を更新
      const modifiedAt = new Date().toISOString()
      const dataAsRecord = data as unknown as Record<string, unknown>
      const history = Array.isArray(dataAsRecord.dateModifyHistory)
        ? (dataAsRecord.dateModifyHistory as unknown[])
        : []
      await setDoc(docRef, {
        ...data,
        date: newDate,
        ym: newYm,
        day: newDay,
        // 履歴を保存（複数回の変更にも対応）
        dateModifyHistory: [
          ...history,
          {
            previousDate: data.date,
            previousYm: data.ym,
            previousDay: data.day,
            newDate,
            modifiedAt,
            modifiedBy: modifiedBy || 0,
          },
        ],
        lastDateModifiedAt: modifiedAt,
        lastDateModifiedBy: modifiedBy || 0,
      })

      await logActivity(
        String(modifiedBy || 'admin'),
        'leave.modifyDate',
        `${data.workerName} (ID:${data.workerId}) の有給日付を ${data.date} → ${newDate} に変更`,
      )

      return NextResponse.json({ success: true, oldDate: data.date, newDate })
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
    if (await checkApiAuth(request)) {
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

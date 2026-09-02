import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, getApiRole, isManagerRole } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where, updateDoc } from '@/lib/fsdb'
import { getWorkerByToken } from '@/lib/workers'
import { getStaffSites, ymKey, setAttendanceEntry, isScheduledWorkDay, computeAttendanceDeleteFields } from '@/lib/attendance'
import { getMainData } from '@/lib/compute'
import { isMonthLockedInLocks } from '@/lib/locks'
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
  foremanApprovedBy?: number | string  // workerId (number) or 'admin' / 'super-admin' (string)
  // 最終承認（事業責任者）
  reviewedAt?: string
  reviewedBy?: number
  rejectedReason?: string
  // スタッフによる取り消し
  cancelledAt?: string
}

const SELF_APPROVE_ERROR = '自分の有給申請は自分で職長承認できません。管理者・事業責任者に依頼してください'

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

      // 2026-08-28: 日本人スタッフの有給申請を解禁（マイページ /mypage/[token] から申請）。
      //   旧: 外国人のみ。日本人は紙・口頭で運用していたため API で弾いていた。
      //   役員・事務は有給管理の対象外なので従来どおり弾く（docs/paid-leave.md）。
      if (worker.jobType === 'yakuin' || worker.jobType === 'jimu') {
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
        // 申請日の月の配置で現場を決める（2026-09-02: 旧は今月の配置）
        const sites = await getStaffSites(worker.id, ym)
        if (sites.length > 0) {
          resolvedSiteId = sites[0].id
        } else {
          return NextResponse.json({
            error: '配置されている現場がないため有給を申請できません。会社に連絡してください / Chưa được phân công công trường nên không thể xin nghỉ phép. Vui lòng liên hệ công ty',
          }, { status: 400 })
        }
      }

      // 2026-06 社労士対応: 有給は「カレンダ上の出勤日」のみ申請可。
      //   月給制では20日枠を超えた有給を「有給日給」として別途支給するため、
      //   非稼働日（日曜・所定休）に有給を入れると過払いになる。これを入口で防ぐ。
      //   2026-06-12 (監査 Sprint2-B): 判定ロジックを isScheduledWorkDay に共通化
      //   （modify_date / designateLeaves と同一基準）
      if (!await isScheduledWorkDay(resolvedSiteId, date)) {
        return NextResponse.json(
          { error: 'この日は出勤予定日ではないため有給を申請できません（休日・所定休は対象外）/ Ngày này không phải ngày làm việc theo lịch nên không thể xin nghỉ phép' },
          { status: 400 },
        )
      }

      // 2026-09-02（代表決定）: 帰国期間中でも有給を申請できる。
      //   一時帰国の日に有給を充てて賃金を受け取りたい、という運用要望に対応した。
      //   旧: 2026-08-27 に一律ブロックしていた（帰国日は無給・非欠勤の扱いで、
      //   有給を入れても旧ルール者は残数だけ減って支給0になる計算穴があったため）。
      //   穴は lib/compute.ts の countHomeLeaveDaysInRange 側で根治済み
      //   （有給を充てた日は帰国日数に数えない＝基本給・所定日数が縮まない）。
      //   稼働日ガード（上の isScheduledWorkDay）は帰国中も従来どおり効く。

      // Check for duplicate
      // 却下 (rejected)・取り消し (cancelled)・管理者取消 (revoked) は上から再申請OK。
      // それ以外（pending / foreman_approved / approved）は重複として弾く
      // 2026-08-27 修正（有給総点検・第3回）: revoked を再申請可能に追加。
      //   管理者が取消した日を本人が申請し直せず 409 になっていた
      //   （modify_date の重複チェックは revoked を非アクティブ扱いしており不整合だった）
      const docId = `${worker.id}_${date.replace(/-/g, '')}`
      const docRef = doc(db, 'leaveRequests', docId)
      const existing = await getDoc(docRef)
      const INACTIVE = ['rejected', 'cancelled', 'revoked']
      let prevHistory: unknown = undefined
      if (existing.exists()) {
        const data = existing.data() as LeaveRequest & { stateHistory?: unknown[] }
        if (!INACTIVE.includes(data.status)) {
          return NextResponse.json({ error: 'Already requested' }, { status: 409 })
        }
        // 再申請で上書きする際も監査履歴 (stateHistory) は引き継ぐ（IM-7 の履歴を消さない）
        prevHistory = [
          ...(Array.isArray(data.stateHistory) ? data.stateHistory : []),
          { status: data.status, at: (data as { rejectedAt?: string; cancelledAt?: string; revokedAt?: string }).rejectedAt
              || (data as { cancelledAt?: string }).cancelledAt
              || (data as { revokedAt?: string }).revokedAt || '',
            reason: (data as { rejectedReason?: string }).rejectedReason || '', note: '再申請により上書き' },
        ]
      }

      // ── 有給残日数チェック ──
      // 2026-09-02 修正（有給総点検・第4回）: 判定を共通の getLeaveBalance に一本化し、
      //   基準日を「今日」ではなく「申請日」にした（PC グリッド経路と同じ）。
      //   旧: 今日の付与期で判定 → 10/1 の新付与前に来期日付を申請すると当期残で判定され、
      //       当期残0なら来期枠があっても却下・当期残があれば来期枠を超えても通った
      //       （日本人は全員 10/1 付与なので 9 月中の 10 月分申請が全部この穴を通る）。
      //   旧実装は買取(buyoutDays)も引いておらず、承認時に初めて LEAVE_OVERDRAFT で止まっていた。
      //   申請中（pending/foreman_approved）は「申請日と同じ付与期」の分だけ上乗せして引く
      //   （過剰申請の抑止・従来どおり）。
      {
        const { getLeaveBalance } = await import('@/lib/leave-balance')
        const { addMonthsSafe } = await import('@/lib/date-utils')
        const bal = await getLeaveBalance(worker.id, date, date)
        if (bal.noGrant) {
          return NextResponse.json({ error: 'No remaining leave' }, { status: 400 })
        }
        const periodStart = bal.grantDate
        const periodEnd = addMonthsSafe(bal.grantDate, 12)
        const pendingQ = query(
          collection(db, 'leaveRequests'),
          where('workerId', '==', worker.id),
          where('status', 'in', ['pending', 'foreman_approved'])
        )
        const pendingSnap = await getDocs(pendingQ)
        const pendingCount = pendingSnap.docs.filter(d => {
          const pd = d.data().date as string | undefined
          return !!pd && pd !== date && pd >= periodStart && pd < periodEnd
        }).length
        if (bal.remaining - pendingCount <= 0) {
          return NextResponse.json({ error: 'No remaining leave' }, { status: 400 })
        }
      }

      const leaveReq: LeaveRequest & { stateHistory?: unknown } = {
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
      if (prevHistory) leaveReq.stateHistory = prevHistory

      await setDoc(docRef, leaveReq)
      return NextResponse.json({ success: true, id: docId })
    }

    // ── 職長: 有給申請を承認（第1段階） ──
    if (action === 'foreman_approve') {
      // 2026-06-XX 修正 (audit #1+#2): 権限チェックを厳格化
      //   旧: foremanId を無条件に受け取り、admin パスワード時は workerId=0 で記録
      //   新: 認証 → 配置現場の foreman であることを assert
      //        admin パスワード時は actor='admin' として記録（workerId=0 で誰か分からない問題を解消）
      const { requestId, token } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      // まず申請ドキュメントを取得（権限チェックに siteId が必要なため）
      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }
      const data = snap.data() as LeaveRequest
      if (data.status !== 'pending') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      // 現場の foreman 一覧を取得（権限判定用）
      const mainDocSnap = await getDoc(doc(db, 'demmen', 'main'))
      const mainData = mainDocSnap.exists() ? mainDocSnap.data() : {}
      const sites = (mainData.sites || []) as { id: string; foremen?: number[]; foreman?: number }[]
      const site = sites.find(s => s.id === data.siteId)
      const foremenOfSite = site?.foremen || (site?.foreman ? [site.foreman] : [])
      // 2026-08-27 修正（有給総点検・第3回）: 月次職長交代 (mforeman) を権限判定に反映。
      //   交代後の新職長が 403 になり、旧職長だけが承認できる状態だった
      {
        const mf = (mainData.mforeman || {}) as Record<string, { wid?: number }>
        const ov = mf[`${data.siteId}_${data.ym}`]?.wid
        if (ov !== undefined && !foremenOfSite.includes(ov)) foremenOfSite.push(ov)
      }

      // 認証 + 権限チェック
      let approvedBy: number | string = 'unknown'
      if (token) {
        // トークン認証: 配置現場の foreman であることを assert
        const worker = await getWorkerByToken(token)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        if (!foremenOfSite.includes(worker.id)) {
          return NextResponse.json({
            error: `現場「${data.siteId}」の職長権限がありません`,
            yourId: worker.id,
            siteForemen: foremenOfSite,
          }, { status: 403 })
        }
        // 2026-09-02 追加: 自分の申請を自分で職長承認することは不可（管理者・事業責任者に依頼）
        if (data.workerId === worker.id) {
          return NextResponse.json({ error: SELF_APPROVE_ERROR }, { status: 403 })
        }
        approvedBy = worker.id
      } else {
        // パスワード認証: actor 種別を確認
        const authUser = await getApiAuthUser(request)
        if (!authUser.authorized) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (typeof authUser.actor === 'number') {
          // 個人パスワード: 管理者・事業責任者（政仁さん・役員）は現場を問わず可。
          //   それ以外は配置現場の foreman であることを assert。
          // 2026-09-02 修正（有給総点検・第4回）: 旧は数値 actor を一律「現場職長」扱いにしていたため、
          //   政仁さん（actor=1）や役員の個人パスワードがここで 403 になり、画面には職長承認ボタンが
          //   出るのに押すと必ず失敗した（職長不在の現場・職長本人の申請を捌く経路が無かった）。
          const roleFA = await getApiRole(request, data.ym)
          const isManagerFA = !!roleFA && isManagerRole(roleFA.role)
          if (!isManagerFA && !foremenOfSite.includes(authUser.actor)) {
            return NextResponse.json({
              error: `現場「${data.siteId}」の職長権限がありません`,
              yourId: authUser.actor,
              siteForemen: foremenOfSite,
            }, { status: 403 })
          }
          if (!isManagerFA && data.workerId === authUser.actor) {
            return NextResponse.json({ error: SELF_APPROVE_ERROR }, { status: 403 })
          }
          approvedBy = authUser.actor
        } else {
          // admin / super-admin: 承認は許可するが actor 文字列で記録
          approvedBy = authUser.actor
        }
      }

      await setDoc(docRef, {
        ...data,
        status: 'foreman_approved',
        foremanApprovedAt: new Date().toISOString(),
        foremanApprovedBy: approvedBy,
      })

      return NextResponse.json({ success: true, approvedBy })
    }

    // ── 事業責任者: 最終承認（第2段階） ──
    if (action === 'approve') {
      // 2026-08-27 修正（有給総点検・第3回）: 最終承認は管理者・事業責任者（政仁さん）のみ。
      //   旧実装は checkApiAuth（誰のパスワードでも可）だったため、職長が個人パスワードで
      //   最終承認を直叩きできた（CLAUDE.md「職長は提出・確認まで」の原則違反）。
      //   revoke と同じ判定に統一する。reviewedBy も body 値でなく認証者から記録する
      const authForApprove = await getApiAuthUser(request)
      if (!authForApprove.authorized) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      // 2026-09-02 修正: 判定を getApiRole/isManagerRole に統一（役員の個人パスワード＝admin ロールも可。
      //   旧は admin パスワード or actor===1 のみで、役員の個人ログインは UI にボタンが出るのに 403 だった）
      const apRole = await getApiRole(request)
      if (!apRole || !isManagerRole(apRole.role)) {
        return NextResponse.json({ error: '最終承認は管理者・事業責任者のみ実行できます' }, { status: 403 })
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

      // 2026-06-12 (監査 Sprint2-B): 月次ロック済み月への有給承認を拒否。
      //   締め（給与確定）後に p:1 が書き込まれると支払額とシステムが食い違う
      {
        const mainForLock = await getMainData()
        const wOrg = mainForLock.workers.find(w => w.id === data.workerId)?.org
        if (isMonthLockedInLocks(mainForLock.locks, data.ym, wOrg)) {
          return NextResponse.json({ error: `${data.ym.slice(0, 4)}年${parseInt(data.ym.slice(4, 6))}月は月次締め済みのため承認できません。先に月次集計画面でロックを解除してください`, status: 409 }, { status: 409 })
        }
      }

      // ── 承認時の残数再チェック（2026-08-04 追加 / 有給システム総点検）──
      //   残数チェックは申請時にしか無く、申請→承認の間に出面直接入力等で残数が
      //   減っていると、承認によって枠を超える p:1 が書き込まれていた。
      //   承認は p:1 を出面に書く「実行」の瞬間なので、ここでも必ず残数を見る。
      //   意図的な超過は allowOverdraft:true でのみ通し、activityLog に残す。
      {
        const { getLeaveBalance } = await import('@/lib/leave-balance')
        // 2026-09-02 修正: 基準日を「今日」から「申請日」に（来期日付の承認を当期残で判定していた）
        const bal = await getLeaveBalance(data.workerId, data.date, data.date)
        if (bal.remaining < 1 && body.allowOverdraft !== true) {
          return NextResponse.json({
            error: bal.noGrant
              ? `${data.workerName} さんは有給が付与されていません（付与レコードなし）`
              : `${data.workerName} さんの有給残は 0 日です（枠 ${bal.total}日 / 消化 ${bal.used}日）。承認すると枠を超えます`,
            code: 'LEAVE_OVERDRAFT',
            balance: bal,
          }, { status: 409 })
        }
        if (bal.remaining < 1 && body.allowOverdraft === true) {
          const { logActivity } = await import('@/lib/activity')
          await logActivity('admin', 'leave.overdraft',
            `${data.workerName} ${data.date} 有給承認を残数超過で実行（枠 ${bal.total}日 / 消化 ${bal.used}日）`)
        }
      }

      // 2026-09-02（代表決定）: 帰国期間中の承認も可。承認で出面へ p を書くと
      //   computeAttendanceDeleteFields がその日の hk を落とすが、帰国期間
      //   （homeLongLeave）自体は変えないため台帳は残る。給与も有給日として計算される。

      // 2026-08-27 修正（有給総点検・第3回）:
      //   - 出面を先に書く（att 書込失敗時に「承認済みなのに p 無し」の不整合を作らない。
      //     逆順の失敗は「p ありで foreman_approved のまま」となり残数上は安全側）
      //   - 残骸掃除: 既に出勤入力(w:1, o, st...)がある日を有給化すると残業等の
      //     フィールドが残り、誤集計の火種だった（staff 経路と同じ deleteFields 方式に統一）
      //   - reviewedBy は認証者から記録（body の approvedBy は表示用フォールバック）
      // 2026-08-31 追加（多現場重複の横展開）: 別現場に同日の出面がある状態で承認すると
      //   P と出勤が併存し、日給月給の日本人は「日給＋有給手当」の二重払いになる。
      //   出面の直接入力（grid/staff/foreman）と同じガードを承認にも置く。
      {
        const { detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
        const attDocA = await getAttendanceDoc(data.ym)
        const sitesAllA = ((await getDoc(doc(db, 'demmen', 'main'))).data()?.sites || []) as { id: string; name?: string }[]
        const conflictA = detectMultiSiteConflict(attDocA, data.siteId, data.workerId, data.ym, data.day, sitesAllA, { w: 0, p: 1 })
        if (conflictA) {
          const cName = sitesAllA.find(s2 => s2.id === conflictA.conflictSiteId)?.name || conflictA.conflictSiteId
          return NextResponse.json({
            error: `${data.date} は「${cName}」に同日の出面が既にあるため承認できません。先に出面を確認・削除してください`,
          }, { status: 409 })
        }
      }
      const approveEntry = { w: 0, p: 1 }
      await setAttendanceEntry(data.siteId, data.workerId, data.ym, data.day, approveEntry,
        { deleteFields: computeAttendanceDeleteFields(approveEntry) })

      await setDoc(docRef, {
        ...data,
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: typeof authForApprove.actor === 'number' ? authForApprove.actor : (approvedBy ?? authForApprove.actor),
      })

      return NextResponse.json({ success: true })
    }

    // ── 却下（職長 or 管理者） ──
    if (action === 'reject') {
      // 却下は「その現場の職長」または管理者・事業責任者のみ（監査C）。
      //   旧: rejectToken があれば有効性のみ確認し、職長判定なしで誰でも他人の申請を却下できた。
      //   新: foreman_approve と同じく、申請現場の foreman であることを assert（帰国申請側と統一）。
      const { requestId, rejectedBy, reason, token: rejectToken } = body
      if (!requestId) {
        return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })
      }

      const docRef = doc(db, 'leaveRequests', requestId)
      const snap = await getDoc(docRef)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Request not found' }, { status: 404 })
      }

      const data = snap.data() as LeaveRequest
      // 2026-09-02 修正: 却下できるのは pending / foreman_approved のみ
      //   （旧は approved/rejected だけ除外 → cancelled・revoked を却下でき履歴が「取消→却下」に化けた）
      if (data.status !== 'pending' && data.status !== 'foreman_approved') {
        return NextResponse.json({ error: 'Already processed' }, { status: 409 })
      }

      // 権限判定: 申請現場の職長 or 管理者・事業責任者
      const rejMainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const rejMain = rejMainSnap.exists() ? rejMainSnap.data() : {}
      const rejSites = (rejMain.sites || []) as { id: string; foremen?: number[]; foreman?: number }[]
      const rejSite = rejSites.find(s => s.id === data.siteId)
      const rejForemen = rejSite?.foremen || (rejSite?.foreman ? [rejSite.foreman] : [])
      {
        // mforeman（月次職長交代）も却下権限に反映（foreman_approve と対）
        const mf = (rejMain.mforeman || {}) as Record<string, { wid?: number }>
        const ov = mf[`${data.siteId}_${data.ym}`]?.wid
        if (ov !== undefined && !rejForemen.includes(ov)) rejForemen.push(ov)
      }

      let authWorkerId: number | string = rejectedBy || 0
      if (rejectToken) {
        const worker = await getWorkerByToken(rejectToken)
        if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        if (!rejForemen.includes(worker.id)) {
          return NextResponse.json({ error: `現場「${data.siteId}」の職長権限がありません` }, { status: 403 })
        }
        authWorkerId = worker.id
      } else {
        const authUser = await getApiAuthUser(request)
        if (!authUser.authorized) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (typeof authUser.actor === 'number') {
          // 管理者・事業責任者は現場を問わず可（foreman_approve と同じ 2026-09-02 修正）
          const roleRj = await getApiRole(request, data.ym)
          const isManagerRj = !!roleRj && isManagerRole(roleRj.role)
          if (!isManagerRj && !rejForemen.includes(authUser.actor)) {
            return NextResponse.json({ error: `現場「${data.siteId}」の職長権限がありません` }, { status: 403 })
          }
          authWorkerId = authUser.actor
        } else {
          authWorkerId = authUser.actor  // admin / super-admin
        }
      }

      // 2026-06-XX 修正 (IM-7): 履歴を保持しつつ updateDoc で部分更新
      //   旧: setDoc で全置換 → 過去の reviewedAt/Reason 等の履歴消失
      //   新: 既存フィールドを保持＋ stateHistory に追記
      const stateHistory = (data as { stateHistory?: unknown[] }).stateHistory || []
      await updateDoc(docRef, {
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewedBy: authWorkerId,
        rejectedReason: reason || '',
        stateHistory: [
          ...stateHistory,
          { at: new Date().toISOString(), by: authWorkerId, action: 'reject', previousStatus: data.status, reason: reason || '' },
        ],
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

      // 2026-06-XX 修正 (IM-7): 履歴を保持しつつ updateDoc で部分更新
      const stateHistory = (data as { stateHistory?: unknown[] }).stateHistory || []
      await updateDoc(docRef, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        stateHistory: [
          ...stateHistory,
          { at: new Date().toISOString(), by: worker.id, action: 'cancel', previousStatus: data.status },
        ],
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
      const rvRole = await getApiRole(request)
      if (!rvRole || !isManagerRole(rvRole.role)) {
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
      // 2026-06-12 (監査 Sprint2-B): ロック済み月の有給取消は拒否（支払額確定後のデータ変更防止）
      const attYm = data.date.replace(/-/g, '').slice(0, 6)
      {
        const mainForLock = await getMainData()
        const wOrg = mainForLock.workers.find(w => w.id === data.workerId)?.org
        if (isMonthLockedInLocks(mainForLock.locks, attYm, wOrg)) {
          return NextResponse.json({ error: `${attYm.slice(0, 4)}年${parseInt(attYm.slice(4, 6))}月は月次締め済みのため取消できません。先にロックを解除してください` }, { status: 409 })
        }
      }
      // att から p=1 をピンポイント削除（IM-11 と同じく他フィールドは温存）
      // 2026-08-27 修正（有給総点検・第3回）: 申請時の siteId 固定をやめ、
      //   その日の全現場キーから p を削除する。承認後に職長が現場を付け替えていると
      //   旧実装は削除が空振りし、「取消済みなのに p が残って残数が戻らない」状態になっていた
      // 2026-09-02 修正（有給総点検・第4回）: 削除を共通ヘルパー removePaidLeaveForDay に寄せ、
      //   失敗したら revoked 化せずに中断する（旧: catch で握りつぶして revoked に更新 →
      //   「取消済みなのに p が残り残数が戻らない」状態を作っていた）
      try {
        const { removePaidLeaveForDay } = await import('@/lib/attendance')
        const removed = await removePaidLeaveForDay(data.workerId, data.date)
        if (removed.length === 0) console.warn(`[revoke] 対象日に p が見つかりません: wid=${data.workerId} ${data.date}`)
      } catch (delErr) {
        console.error('[revoke] att p 削除失敗:', delErr)
        return NextResponse.json({ error: '出面の有給を消せなかったため取消を中断しました。もう一度お試しください' }, { status: 500 })
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
      // 2026-08-27 修正（有給総点検・第3回）: 承認済み有給の日付変更は
      //   管理者・事業責任者のみ（approve/revoke と同一基準。旧: 誰のパスワードでも可）
      const authForModify = await getApiAuthUser(request)
      if (!authForModify.authorized) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const mdRole = await getApiRole(request)
      if (!mdRole || !isManagerRole(mdRole.role)) {
        return NextResponse.json({ error: '日付変更は管理者・事業責任者のみ実行できます' }, { status: 403 })
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

      // 2026-06-12 (監査 Sprint2-B): request アクションと同じガードを日付変更にも適用
      // ① 新日付はカレンダー上の稼働日のみ（非稼働日への変更は有給日給の過払いになる）
      if (!await isScheduledWorkDay(data.siteId, newDate)) {
        return NextResponse.json(
          { error: '変更先の日付は出勤予定日ではないため有給にできません（休日・所定休は対象外）' },
          { status: 400 },
        )
      }
      // ② 旧日付・新日付の月がロック済みなら拒否（締め後の支払額変更防止）
      {
        const mainForLock = await getMainData()
        const wOrg = mainForLock.workers.find(w => w.id === data.workerId)?.org
        for (const checkYm of [data.ym, newYm]) {
          if (isMonthLockedInLocks(mainForLock.locks, checkYm, wOrg)) {
            return NextResponse.json({ error: `${checkYm.slice(0, 4)}年${parseInt(checkYm.slice(4, 6))}月は月次締め済みのため日付変更できません。先にロックを解除してください` }, { status: 409 })
          }
        }
      }
      // ③ 新日付に既存のアクティブな有給申請があれば拒否（重複防止。docId は旧日付のままのため
      //    request アクションの existing チェックが効かない）
      {
        const dupRef = doc(db, 'leaveRequests', `${data.workerId}_${newDate.replace(/-/g, '')}`)
        const dupSnap = await getDoc(dupRef)
        if (dupSnap.exists()) {
          const dup = dupSnap.data() as LeaveRequest
          if (dup.status !== 'rejected' && dup.status !== 'cancelled' && (dup as { status?: string }).status !== 'revoked') {
            return NextResponse.json({ error: '変更先の日付には既に有給申請があります' }, { status: 409 })
          }
        }
      }

      // ④ 付与期をまたぐ移動は、移動先の期の残数を確認（2026-09-02 追加）
      {
        const { getLeaveBalance } = await import('@/lib/leave-balance')
        const balOld = await getLeaveBalance(data.workerId, data.date, data.date)
        const balNew = await getLeaveBalance(data.workerId, newDate, newDate)
        if (balNew.grantDate !== balOld.grantDate && balNew.remaining < 1 && body.allowOverdraft !== true) {
          return NextResponse.json({
            error: balNew.noGrant
              ? `変更先の日付には有給が付与されていません（付与レコードなし）`
              : `変更先の付与期の残数が 0 日です（枠 ${balNew.total}日 / 消化 ${balNew.used}日）`,
            code: 'LEAVE_OVERDRAFT',
            balance: balNew,
          }, { status: 409 })
        }
      }

      // approved 状態の場合は att データの差し替えが必要
      if (data.status === 'approved') {
        // 2026-09-02 修正（有給総点検・第4回）: 旧日の p は「申請時の siteId」だけでなく
        //   その日の全現場から外す（revoke と同じ共通ヘルパー）。職長が現場を付け替えた後に
        //   日付変更すると旧 p が残り、残数が1日余計に減って給与も有給2日扱いになっていた。
        //   ヘルパーは dot-notation で .p だけ消す（併存フィールドは温存＝IM-11 の方針維持）
        {
          const { removePaidLeaveForDay } = await import('@/lib/attendance')
          await removePaidLeaveForDay(data.workerId, data.date)
        }

        // 新日付に p=1 を書込
        // 残骸掃除つきで p を書く（approve と同方式・2026-08-27）
        {
          // 多現場重複ガード（2026-08-31 横展開・approve と同じ）
          const { detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
          const attDocM = await getAttendanceDoc(newYm)
          const sitesAllM = ((await getDoc(doc(db, 'demmen', 'main'))).data()?.sites || []) as { id: string; name?: string }[]
          const conflictM = detectMultiSiteConflict(attDocM, data.siteId, data.workerId, newYm, newDay, sitesAllM, { w: 0, p: 1 })
          if (conflictM) {
            const cName = sitesAllM.find(s2 => s2.id === conflictM.conflictSiteId)?.name || conflictM.conflictSiteId
            return NextResponse.json({
              error: `変更先の日付は「${cName}」に同日の出面が既にあるため変更できません`,
            }, { status: 409 })
          }
          const mvEntry = { w: 0, p: 1 }
          await setAttendanceEntry(data.siteId, data.workerId, newYm, newDay, mvEntry,
            { deleteFields: computeAttendanceDeleteFields(mvEntry) })
        }
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

import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, updateDoc, deleteDoc, query, where } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { getWorkers, resolveWorkerName } from '@/lib/workers'
import { HOME_LEAVE_SENTINEL_END } from '@/lib/homeLeave'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 同一スタッフの他のアクティブ申請（approved/pending/foreman_approved）と
 * 期間が重なっていないか調べる（2026-08-27 追加・休暇届総点検）。
 * 旧: doc id（workerId_開始日）の完全一致のみで、開始日を1日ずらせば
 * 重なる期間を何件でも登録でき、削除時に hk の巻き添え消しを起こしていた。
 * endDate は「最終帰国日」（期間に含む）なので重なりは inclusive で判定する。
 */
async function findOverlappingLeave(
  workerId: number, startDate: string, endDate: string, excludeId?: string,
): Promise<{ id: string; startDate: string; endDate: string; status: string } | null> {
  const snap = await getDocs(query(collection(db, 'homeLongLeave'), where('workerId', '==', Number(workerId))))
  let hit: { id: string; startDate: string; endDate: string; status: string } | null = null
  snap.forEach(d => {
    if (hit) return
    if (excludeId && d.id === excludeId) return
    const v = d.data() as { startDate?: string; endDate?: string; status?: string }
    if (!v.startDate || !v.endDate) return
    if (v.status !== 'approved' && v.status !== 'pending' && v.status !== 'foreman_approved') return
    if (startDate <= v.endDate && v.startDate <= endDate) {
      hit = { id: d.id, startDate: v.startDate, endDate: v.endDate, status: v.status || '' }
    }
  })
  return hit
}

/**
 * 期間（旧∪新）が本人の組織のロック済み月にかかっていないか（2026-08-27 追加）。
 * 締め済み給与は帰国期間の事後変更で黙って変わってはいけない。
 * 変更が必要な場合は月次集計画面でロックを解除してから行う運用に統一する。
 * 番兵（復帰未定）は12ヶ月で打ち切って走査する。
 */
async function findLockedMonthInRanges(
  workerId: number,
  ranges: { startDate?: string; endDate?: string }[],
): Promise<string | null> {
  const { checkMonthLocked } = await import('@/lib/locks')
  const { getWorkers } = await import('@/lib/workers')
  const company = (await getWorkers()).find(w => w.id === Number(workerId))?.company
  const org = company === 'HFU' ? 'hfu' : company ? 'hibi' : undefined
  const seen = new Set<string>()
  for (const r of ranges) {
    if (!r?.startDate || !r?.endDate || !ISO_DATE_RE.test(r.startDate)) continue
    let ym = r.startDate.slice(0, 7).replace('-', '')
    let endYm = (r.endDate >= HOME_LEAVE_SENTINEL_END ? '' : r.endDate.slice(0, 7).replace('-', ''))
    // 番兵は開始から12ヶ月で打ち切り（syncHomeLeaveAttendance の horizon と同じ）
    if (!endYm || Number(endYm.slice(0, 4)) > Number(ym.slice(0, 4)) + 2) {
      const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6)) - 1 + 12
      endYm = `${y + Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, '0')}`
    }
    let guard = 0
    while (ym <= endYm && guard++ < 30) {
      if (!seen.has(ym)) {
        seen.add(ym)
        const lockErr = await checkMonthLocked(ym, org)
        if (lockErr) return ym
      }
      const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6))
      ym = m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`
    }
  }
  return null
}

/**
 * 管理者の手動帰国登録 API（2026-05-13 単一ソース化）
 *
 * 旧: `demmen/main.homeLeaves` 配列に書き込み（スマホ申請の `homeLongLeave`
 *     コレクションと dual storage 状態 → 編集時の不整合事故が頻発）
 * 新: `homeLongLeave/{wid}_{startDate}` ドキュメントに status='approved' で
 *     直接書き込み（スマホ申請と同じストレージ）
 *
 * - GET:    status='approved' の帰国情報一覧を返す（旧UIとの互換のため
 *           shape は { homeLeaves: [...] } のまま）
 * - add:    homeLongLeave コレクションに status='approved' で create
 * - update: doc を直接 updateDoc
 * - delete: doc を直接 deleteDoc
 */

/**
 * ISO日付の前日を返す（文字列演算・タイムゾーン非依存）。
 * 「最初の出勤日の前日」＝正しい最終帰国日 を画面に提案するために使う。
 */
function prevDateIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

/** 期間の変更履歴（当初の予定日を後から追えるようにする） */
interface HomeLeaveChange {
  field: string
  before: string
  after: string
  at: string
  by: string
}

interface HomeLeaveRecord {
  id: string
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  note?: string
  createdAt: string
  status?: string
  returnUndecided?: boolean  // 2026-07-18: 復帰未定（番兵終了日）フラグ
  changeHistory?: HomeLeaveChange[]  // 2026-08-25: 期間の変更履歴
  // 2026-08-25: 申請〜承認の経緯。既に保存されていたが画面に出していなかった
  requestedAt?: string
  foremanApprovedAt?: string
  foremanApprovedBy?: number
  reviewedAt?: string
  reviewedBy?: number
}

export async function GET(request: NextRequest) {
  try {
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // homeLongLeave コレクションから approved のものだけ取得
    // workerName は人員マスタから都度ルックアップして最新名を返す
    const workers = await getWorkers()
    const homeLeaves: HomeLeaveRecord[] = []
    try {
      const q = query(collection(db, 'homeLongLeave'), where('status', '==', 'approved'))
      const snap = await getDocs(q)
      snap.forEach(d => {
        const v = d.data()
        homeLeaves.push({
          id: d.id,
          workerId: v.workerId,
          workerName: resolveWorkerName(workers, v.workerId, v.workerName),
          startDate: v.startDate,
          endDate: v.endDate,
          reason: v.reason || '一時帰国',
          ...(v.note ? { note: v.note } : {}),
          ...(v.returnUndecided || v.endDate >= HOME_LEAVE_SENTINEL_END ? { returnUndecided: true } : {}),
          ...(Array.isArray(v.changeHistory) && v.changeHistory.length > 0 ? { changeHistory: v.changeHistory } : {}),
          ...(v.requestedAt ? { requestedAt: v.requestedAt } : {}),
          ...(v.foremanApprovedAt ? { foremanApprovedAt: v.foremanApprovedAt } : {}),
          ...(v.foremanApprovedBy !== undefined ? { foremanApprovedBy: v.foremanApprovedBy } : {}),
          ...(v.reviewedAt ? { reviewedAt: v.reviewedAt } : {}),
          ...(v.reviewedBy !== undefined ? { reviewedBy: v.reviewedBy } : {}),
          createdAt: v.requestedAt || v.createdAt || '',
        })
      })
    } catch (e) {
      console.warn('homeLeave GET fetch failed:', e)
    }

    // startDate 順にソート（UIで表示順を安定化）
    homeLeaves.sort((a, b) => a.startDate.localeCompare(b.startDate))

    return NextResponse.json({ homeLeaves })
  } catch (error) {
    console.error('Home leave GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    // 2026-08-27（休暇届総点検）: 帰国記録の登録・変更・削除は給与（基本給の按分）に
    //   直結するため、代表・管理者のみに制限（旧: 任意の個人パスワードで可能だった）
    { const denied = await requireExecutiveAuth(request); if (denied) return denied }
    const authUser = await getApiAuthUser(request)
    const actorLabel = authUser.authorized
      ? (typeof authUser.actor === 'number' ? `worker:${authUser.actor}` : String(authUser.actor))
      : 'admin'

    const body = await request.json()
    const { action } = body

    // ── 管理者の手動追加 ──
    // 旧UI が action='create' を送ってきていた経緯があるので両方受け付ける
    if (action === 'add' || action === 'create') {
      const { workerId, workerName, startDate, reason, note, returnUndecided } = body
      // 2026-07-18 追加: 「復帰未定（急な帰国）」対応。終了日に番兵値を入れて
      //   既存の文字列比較ロジック（endDate >= 月末 等）を壊さずに「開始日以降ずっと帰国中」を表現する。
      //   復帰時は update で実際の復帰日に置き換える。
      const endDate = returnUndecided ? HOME_LEAVE_SENTINEL_END : body.endDate

      if (!Number.isInteger(Number(workerId)) || !workerName || !startDate || !endDate || !reason) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }
      // 2026-08-27: 日付は ISO 形式を強制（空文字や不正形式が保存されると
      //   同期の文字列比較が全日 true になり hk が一斉スタンプされる事故経路だった）
      if (!ISO_DATE_RE.test(startDate) || (!returnUndecided && !ISO_DATE_RE.test(endDate))) {
        return NextResponse.json({ error: '日付は YYYY-MM-DD 形式で指定してください' }, { status: 400 })
      }
      if (startDate >= endDate) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
      }
      const overlapAdd = await findOverlappingLeave(Number(workerId), startDate, endDate)
      if (overlapAdd) {
        return NextResponse.json({
          error: `既存の帰国期間（${overlapAdd.startDate}〜${overlapAdd.endDate}・${overlapAdd.status}）と重なっています。既存の記録を編集してください`,
        }, { status: 409 })
      }
      {
        const lockedYm = await findLockedMonthInRanges(Number(workerId), [{ startDate, endDate }])
        if (lockedYm) {
          return NextResponse.json({ error: `${lockedYm.slice(0, 4)}年${Number(lockedYm.slice(4, 6))}月は月次締め済みのため、この期間の帰国は登録できません。先にロックを解除してください` }, { status: 409 })
        }
      }

      const id = `${workerId}_${startDate}`
      const ref = doc(db, 'homeLongLeave', id)
      const existing = await getDoc(ref)
      if (existing.exists()) {
        return NextResponse.json({ error: 'Already exists' }, { status: 409 })
      }

      // 2026-08-20 追加: 帰国期間の中に出勤打刻がある日が無いかを保存前に確認する。
      //   終了日に「復帰日」を入れる入力ミスが繰り返し起きたため（ファン/フン事案）。
      //   force:true が明示されたときだけ通す（帰国中の一時出勤など正当なケース用）。
      if (!body.force) {
        const { findWorkedDaysInHomeLeave } = await import('@/lib/home-leave-sync')
        const conflicts = await findWorkedDaysInHomeLeave(Number(workerId), startDate, endDate)
        if (conflicts.length > 0) {
          return NextResponse.json({
            error: 'WORKED_DAYS_IN_RANGE',
            message: `帰国期間の中に出勤打刻のある日が ${conflicts.length}日 あります。終了日には「最終帰国日」を入れてください（復帰日ではありません）。`,
            conflicts,
            suggestedEndDate: prevDateIso(conflicts[0].date),
          }, { status: 409 })
        }
      }

      await setDoc(ref, {
        workerId,
        workerName,
        startDate,
        endDate,
        reason,
        ...(note ? { note } : {}),
        ...(returnUndecided ? { returnUndecided: true } : {}),
        status: 'approved',
        // 管理者直接登録は申請プロセスをスキップ。createdAt は監査用。
        createdAt: new Date().toISOString(),
      })
      // 出面の帰国フラグを同期（2026-08-03 追加）。
      // 手動登録は status='approved' で作るのに、これまで出面へ何も書いていなかった。
      // 承認経路と同じ状態になるよう、ここでも必ず同期する。
      const { syncHomeLeaveAttendance } = await import('@/lib/home-leave-sync')
      const sync = await syncHomeLeaveAttendance(Number(workerId), null, { startDate, endDate }, { excludeDocId: id })

      const endLabel = returnUndecided ? '復帰未定' : endDate
      await logActivity('admin', 'homeLeave.add', `${workerName} 一時帰国登録 ${startDate}〜${endLabel}`)

      return NextResponse.json({ success: true, id, attendanceSync: sync })
    }

    // ── 更新 ──
    if (action === 'update') {
      const { id, startDate, reason, note, returnUndecided } = body
      if (!id) {
        return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      }

      const ref = doc(db, 'homeLongLeave', id)
      const snap = await getDoc(ref)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const current = snap.data()

      // 2026-07-18: endDate の決定。
      //   - returnUndecided===true  → 番兵値（復帰未定へ変更）
      //   - returnUndecided===false → body.endDate が実際の復帰日（未定 → 復帰確定）
      //   - returnUndecided 未指定   → 従来どおり body.endDate をそのまま採用
      let newEnd: string
      if (returnUndecided === true) {
        newEnd = HOME_LEAVE_SENTINEL_END
      } else if (body.endDate !== undefined) {
        newEnd = body.endDate
      } else {
        newEnd = current.endDate
      }
      const newStart = startDate !== undefined ? startDate : current.startDate
      if (!ISO_DATE_RE.test(newStart) || !(ISO_DATE_RE.test(newEnd) || newEnd >= HOME_LEAVE_SENTINEL_END)) {
        return NextResponse.json({ error: '日付は YYYY-MM-DD 形式で指定してください' }, { status: 400 })
      }
      if (newStart >= newEnd) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
      }
      const overlapUpd = await findOverlappingLeave(Number(current.workerId), newStart, newEnd, id)
      if (overlapUpd) {
        return NextResponse.json({
          error: `別の帰国期間（${overlapUpd.startDate}〜${overlapUpd.endDate}・${overlapUpd.status}）と重なっています`,
        }, { status: 409 })
      }
      {
        const lockedYm = await findLockedMonthInRanges(Number(current.workerId), [
          { startDate: current.startDate, endDate: current.endDate },
          { startDate: newStart, endDate: newEnd },
        ])
        if (lockedYm) {
          return NextResponse.json({ error: `${lockedYm.slice(0, 4)}年${Number(lockedYm.slice(4, 6))}月は月次締め済みのため変更できません。先にロックを解除してください` }, { status: 409 })
        }
      }

      // 2026-08-20 追加: add と同じ「帰国期間内の出勤打刻」チェック。
      //   期間を伸ばす方向の編集でも入力ミスを止められるようにする。
      if (!body.force) {
        const { findWorkedDaysInHomeLeave } = await import('@/lib/home-leave-sync')
        const conflicts = await findWorkedDaysInHomeLeave(Number(current.workerId), newStart, newEnd)
        if (conflicts.length > 0) {
          return NextResponse.json({
            error: 'WORKED_DAYS_IN_RANGE',
            message: `帰国期間の中に出勤打刻のある日が ${conflicts.length}日 あります。終了日には「最終帰国日」を入れてください（復帰日ではありません）。`,
            conflicts,
            suggestedEndDate: prevDateIso(conflicts[0].date),
          }, { status: 409 })
        }
      }

      const updates: Record<string, string | boolean> = {}
      if (startDate !== undefined) updates.startDate = startDate
      if (returnUndecided === true) {
        updates.endDate = HOME_LEAVE_SENTINEL_END
        updates.returnUndecided = true
      } else if (returnUndecided === false) {
        // 復帰日を確定 → 未定フラグを解除
        updates.returnUndecided = false
        if (body.endDate !== undefined) updates.endDate = body.endDate
      } else if (body.endDate !== undefined) {
        updates.endDate = body.endDate
      }
      if (reason !== undefined) updates.reason = reason
      if (note !== undefined) updates.note = note

      // ── 変更履歴をレコード自体に残す（2026-08-25 追加）──
      // 「当初の帰国予定日は何日だったか」を後から画面で追えるようにする。
      // 活動ログ(activity)にも記録は残るが、出面編集のログに埋もれて実用的に辿れない
      // （実際 200件遡っても出面編集で埋まっていた）。有給の adjustmentHistory と同じ方式で
      // レコードに持たせ、休暇管理画面のカードから直接見られるようにする。
      const changeEntries: { field: string; before: string; after: string; at: string; by: string }[] = []
      const nowIso = new Date().toISOString()
      if (updates.startDate !== undefined && updates.startDate !== current.startDate) {
        changeEntries.push({ field: 'startDate', before: String(current.startDate), after: String(updates.startDate), at: nowIso, by: actorLabel })
      }
      if (updates.endDate !== undefined && updates.endDate !== current.endDate) {
        changeEntries.push({ field: 'endDate', before: String(current.endDate), after: String(updates.endDate), at: nowIso, by: actorLabel })
      }
      if (changeEntries.length > 0) {
        const prevHistory = Array.isArray(current.changeHistory) ? current.changeHistory : []
        ;(updates as Record<string, unknown>).changeHistory = [...prevHistory, ...changeEntries]
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(ref, updates)
      }

      // 出面の帰国フラグを同期（2026-08-03 追加 / グエン タイン フウ事案の直接原因）。
      // ここで旧期間を渡すのが肝。渡さないと旧期間に書いた hk が消えず、
      // 「9/1開始に直したのに7/30から帰国中」という残骸が生まれる。
      // hk は承認済みの申請にしか書かれないので、それ以外の状態では触らない。
      let sync = null
      if (current.status === 'approved') {
        const { syncHomeLeaveAttendance } = await import('@/lib/home-leave-sync')
        sync = await syncHomeLeaveAttendance(
          current.workerId,
          { startDate: current.startDate, endDate: current.endDate },
          { startDate: newStart, endDate: newEnd },
          { excludeDocId: id },
        )
      }

      const endLabel = newEnd >= HOME_LEAVE_SENTINEL_END ? '復帰未定' : newEnd
      await logActivity('admin', 'homeLeave.update', `${current.workerName} 一時帰国更新 ${newStart}〜${endLabel}`)

      return NextResponse.json({ success: true, attendanceSync: sync })
    }

    // ── 削除 ──
    if (action === 'delete') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'Missing id' }, { status: 400 })
      }

      const ref = doc(db, 'homeLongLeave', id)
      const snap = await getDoc(ref)
      if (!snap.exists()) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const data = snap.data()
      {
        const lockedYm = await findLockedMonthInRanges(Number(data.workerId), [
          { startDate: data.startDate, endDate: data.endDate },
        ])
        if (lockedYm) {
          return NextResponse.json({ error: `${lockedYm.slice(0, 4)}年${Number(lockedYm.slice(4, 6))}月は月次締め済みのため削除できません。先にロックを解除してください` }, { status: 409 })
        }
      }
      await deleteDoc(ref)

      // 出面の帰国フラグも消す（2026-08-03 追加）。
      // 申請だけ消して出面に hk が残ると、どの申請にも紐づかない孤立フラグになり
      // 原因を追えなくなる。削除は「新期間 null」として同期する。
      let sync = null
      if (data.status === 'approved') {
        const { syncHomeLeaveAttendance } = await import('@/lib/home-leave-sync')
        sync = await syncHomeLeaveAttendance(
          data.workerId,
          { startDate: data.startDate, endDate: data.endDate },
          null,
          { excludeDocId: id },
        )
      }

      await logActivity('admin', 'homeLeave.delete', `${data.workerName} 一時帰国削除 ${data.startDate}〜${data.endDate}`)

      return NextResponse.json({ success: true, attendanceSync: sync })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Home leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

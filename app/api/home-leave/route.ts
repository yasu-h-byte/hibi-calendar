import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, getDocs, collection, updateDoc, deleteDoc, query, where } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { getWorkers, resolveWorkerName } from '@/lib/workers'
import { HOME_LEAVE_SENTINEL_END } from '@/lib/homeLeave'

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
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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

      if (!workerId || !workerName || !startDate || !endDate || !reason) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }
      if (startDate >= endDate) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
      }

      const id = `${workerId}_${startDate}`
      const ref = doc(db, 'homeLongLeave', id)
      const existing = await getDoc(ref)
      if (existing.exists()) {
        return NextResponse.json({ error: 'Already exists' }, { status: 409 })
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
      const endLabel = returnUndecided ? '復帰未定' : endDate
      await logActivity('admin', 'homeLeave.add', `${workerName} 一時帰国登録 ${startDate}〜${endLabel}`)

      return NextResponse.json({ success: true, id })
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
      if (newStart >= newEnd) {
        return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
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

      if (Object.keys(updates).length > 0) {
        await updateDoc(ref, updates)
      }
      const endLabel = newEnd >= HOME_LEAVE_SENTINEL_END ? '復帰未定' : newEnd
      await logActivity('admin', 'homeLeave.update', `${current.workerName} 一時帰国更新 ${newStart}〜${endLabel}`)

      return NextResponse.json({ success: true })
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
      await deleteDoc(ref)
      await logActivity('admin', 'homeLeave.delete', `${data.workerName} 一時帰国削除 ${data.startDate}〜${data.endDate}`)

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Home leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

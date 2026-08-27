import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'

/**
 * バックアップスナップショットの一覧/プレビュー/復元
 *
 * GET (list/preview):
 *   - ?action=list  → 直近30件のバックアップ一覧
 *   - ?action=preview&snapshotId=<id>  → 指定スナップショットの中身（先頭部分）を返す
 *
 * POST (restore):
 *   - body: { snapshotId, mode: 'overwrite' | 'merge' }
 *   - mode='overwrite': 復元前に現状をもう一度バックアップ → 復元
 *   - mode='merge': 復元前に現状をバックアップ → 既存データに不足分のみ追加
 *
 * 認証: x-admin-password ヘッダ（admin/super-admin のみ）
 */
export async function GET(request: NextRequest) {
  // バックアップ一覧・プレビューも admin 限定（中身に給与情報等が含まれるため）
  const authResult = await getApiAuthUser(request)
  if (!authResult.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (authResult.actor !== 'admin' && authResult.actor !== 'super-admin') {
    return NextResponse.json({ error: 'admin 権限が必要です' }, { status: 403 })
  }
  const action = request.nextUrl.searchParams.get('action') || 'list'

  if (action === 'list') {
    const snap = await getDocs(query(collection(db, 'backups'), orderBy('snapshotAt', 'desc'), limit(50)))
    const items = snap.docs.map(d => ({
      id: d.id,
      sourceId: d.data().sourceId,
      ym: d.data().ym ?? null,
      snapshotAt: d.data().snapshotAt,
      sizeApprox: JSON.stringify(d.data().data || {}).length,
    }))
    return NextResponse.json({ items })
  }

  if (action === 'preview') {
    const snapshotId = request.nextUrl.searchParams.get('snapshotId')
    if (!snapshotId) return NextResponse.json({ error: 'snapshotId required' }, { status: 400 })
    const ref = doc(db, 'backups', snapshotId)
    const ds = await getDoc(ref)
    if (!ds.exists()) return NextResponse.json({ error: 'snapshot not found' }, { status: 404 })
    const d = ds.data() as { sourceId: string; ym?: string; snapshotAt: string; data: Record<string, unknown> }
    // dフィールドのキー数だけ返す（中身は重いので返さない）
    const data = d.data || {}
    const summary: Record<string, unknown> = {
      sourceId: d.sourceId,
      ym: d.ym ?? null,
      snapshotAt: d.snapshotAt,
    }
    if (data.d && typeof data.d === 'object') {
      summary.dKeyCount = Object.keys(data.d as Record<string, unknown>).length
      summary.dKeysSample = Object.keys(data.d as Record<string, unknown>).slice(0, 10)
    }
    if (data.sd && typeof data.sd === 'object') {
      summary.sdKeyCount = Object.keys(data.sd as Record<string, unknown>).length
    }
    if (data.workers && Array.isArray(data.workers)) {
      summary.workersCount = data.workers.length
    }
    if (data.plData && typeof data.plData === 'object') {
      summary.plDataWorkerCount = Object.keys(data.plData as Record<string, unknown>).length
    }
    return NextResponse.json({ summary })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  // ⚠️ 復元は admin / super-admin (靖仁さん) 限定。職長・事務・経理の個人パスワードでは拒否。
  // 任意のスナップショットで demmen/main や att_YYYYMM を全置換できる強力な操作のため。
  const authResult = await getApiAuthUser(request)
  if (!authResult.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (authResult.actor !== 'admin' && authResult.actor !== 'super-admin') {
    return NextResponse.json({ error: 'admin 権限が必要です' }, { status: 403 })
  }
  const actor = String(authResult.actor)
  const { snapshotId, mode, confirmText } = (await request.json()) as {
    snapshotId?: string
    mode?: 'overwrite' | 'merge'
    confirmText?: string
  }

  if (!snapshotId) return NextResponse.json({ error: 'snapshotId required' }, { status: 400 })
  if (mode !== 'overwrite' && mode !== 'merge') {
    return NextResponse.json({ error: 'mode must be "overwrite" or "merge"' }, { status: 400 })
  }
  // 誤実行防止のためのフレーズチェック
  if (confirmText !== `RESTORE ${snapshotId}`) {
    return NextResponse.json({
      error: '確認フレーズが一致しません',
      hint: `body.confirmText に "RESTORE ${snapshotId}" を入れてください`,
    }, { status: 400 })
  }

  const ds = await getDoc(doc(db, 'backups', snapshotId))
  if (!ds.exists()) return NextResponse.json({ error: 'snapshot not found' }, { status: 404 })
  const backup = ds.data() as { sourceId: string; data: Record<string, unknown> }

  const safetyStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safetyRef = doc(db, 'backups', `safety_pre_restore_${safetyStamp}`)

  // ── コレクション型バックアップ（sourceId にスラッシュ無し: leaveRequests 等）の復元 ──
  // 2026-08-27 追加（バックアップ実効性検証）: 従来はドキュメント型しか復元できず、
  //   コレクション退避（leavereq/homeleave/paysnap 等）は「取れるが戻せない」片道だった。
  //   data.docs[] を各ドキュメントへ書き戻す。
  //   - overwrite: バックアップ内の全 doc を setDoc（存在しない doc も復活）
  //   - merge:     現在存在しない doc のみ復活（既存 doc は一切触らない）
  if (!backup.sourceId.includes('/')) {
    const collName = backup.sourceId.replace(/\(.*\)$/, '')  // 'calendarSign(2026-08)' → 'calendarSign'
    const docsArr = (backup.data as { docs?: ({ id: string } & Record<string, unknown>)[] }).docs
    if (!Array.isArray(docsArr)) {
      return NextResponse.json({ error: 'このスナップショットは docs 配列を持たないため復元できません' }, { status: 400 })
    }
    // safety: 現在のコレクション全体を同形式で退避
    const curSnap = await getDocs(query(collection(db, collName), limit(2000)))
    await setDoc(safetyRef, {
      sourceId: backup.sourceId,
      snapshotAt: new Date().toISOString(),
      reason: `safety backup before restore from ${snapshotId}`,
      count: curSnap.docs.length,
      data: { docs: curSnap.docs.map(d => ({ id: d.id, ...d.data() })) },
    })
    const existingIds = new Set(curSnap.docs.map(d => d.id))
    let restored = 0
    let skipped = 0
    for (const item of docsArr) {
      const { id: itemId, ...payload } = item
      if (!itemId) continue
      if (mode === 'merge' && existingIds.has(itemId)) { skipped++; continue }
      await setDoc(doc(db, collName, itemId), payload)
      restored++
    }
    await logActivity(actor, 'backup.restore',
      `${snapshotId} を ${mode} で復元（コレクション ${collName}: ${restored}件復元/${skipped}件スキップ, safety: ${safetyRef.id}）`)
    return NextResponse.json({ success: true, restoredFrom: snapshotId, mode, collection: collName, restored, skipped, safetyBackup: safetyRef.id })
  }

  // ── ドキュメント型バックアップ（sourceId: 'demmen/main' 等）の復元 ──
  const currentRef = doc(db, backup.sourceId.split('/')[0], backup.sourceId.split('/')[1])
  const currentSnap = await getDoc(currentRef)
  if (currentSnap.exists()) {
    await setDoc(safetyRef, {
      sourceId: backup.sourceId,
      snapshotAt: new Date().toISOString(),
      reason: `safety backup before restore from ${snapshotId}`,
      data: currentSnap.data(),
    })
  }

  // 復元実行
  if (mode === 'overwrite') {
    // 全置換
    await setDoc(currentRef, backup.data)
  } else {
    // merge: 既存データに不足分のみ追加（既存キーは保持）
    // d / sd / plData などの map 型のみ対応
    const existing = currentSnap.exists() ? currentSnap.data() : {}
    const merged: Record<string, unknown> = { ...existing }
    for (const [key, value] of Object.entries(backup.data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const existingMap = (existing[key] || {}) as Record<string, unknown>
        const backupMap = value as Record<string, unknown>
        const mergedMap: Record<string, unknown> = { ...existingMap }
        for (const [mk, mv] of Object.entries(backupMap)) {
          if (!(mk in mergedMap)) {
            mergedMap[mk] = mv
          }
        }
        merged[key] = mergedMap
      } else if (existing[key] === undefined) {
        merged[key] = value
      }
    }
    await setDoc(currentRef, merged)
  }

  await logActivity(actor, 'backup.restore', `${snapshotId} を ${mode} で復元 (safety: ${safetyRef.id})`)

  return NextResponse.json({
    success: true,
    restoredFrom: snapshotId,
    mode,
    safetyBackup: safetyRef.id,
  })
}

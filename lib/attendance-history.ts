/**
 * 出面の変更履歴（誤削除・誤上書きからの復元用）
 *
 * ## なぜ必要か（2026-08-28 の事故）
 * 管理者が 8/27 IHI のセルを削除したとき、
 * - 操作ログ(activityLog) には「削除した」事実は残っていたが **中身が残っていなかった**
 * - 日次バックアップは 2:00 の1回だけなので、**当日入れて当日消したデータは救えなかった**
 * 結果、トゥアンさんはバックアップから救えたが、フウさんは手入力で復旧するしかなかった。
 *
 * ## 設計
 * - **既存エントリを壊す操作（削除・上書き）のときだけ**記録する。新規作成は記録しない
 *   （復元の必要がなく、書き込み量を増やす意味がないため）
 * - 記録は独立コレクション。出面ドキュメント本体は膨らませない（読み取りが重くなるため）
 * - 保持 90日。日次バックアップ cron のついでに古い分を削除する
 */
import { db } from './firebase'
import { collection, addDoc, query, orderBy, limit, where, getDocs } from '@/lib/fsdb'
import type { AttendanceEntry } from '@/types'

const COLLECTION = 'attendanceHistory'
/** 履歴の保持日数。これより古いものは日次 cron で削除する */
export const HISTORY_RETENTION_DAYS = 90

export interface AttendanceHistoryEntry {
  id?: string
  /** 出面キー `${siteId}_${workerId}_${ym}_${day}` */
  key: string
  siteId: string
  workerId: number
  ym: string
  day: number
  /** 変更前の内容。復元はこれを書き戻す */
  before: AttendanceEntry
  /** 変更後の内容。削除なら null */
  after: AttendanceEntry | null
  /** 変更前の入力元（'staff' ならスマホ入力を壊した＝復元の優先度が高い） */
  beforeSource: string
  /** 操作者（'admin' / 'foreman:12' / 'staff:104' など） */
  actor: string
  /** 操作の種類 */
  kind: 'delete' | 'overwrite'
  at: string
}

/**
 * 既存エントリが壊れる直前に呼ぶ。before が無い（新規作成）ときは何もしない。
 *
 * ⚠️ 記録の失敗で本体処理を止めないこと（履歴はあくまで保険）。
 */
export async function recordAttendanceChange(params: {
  siteId: string
  workerId: number
  ym: string
  day: number | string
  before: AttendanceEntry | undefined | null
  after: AttendanceEntry | null
  actor: string
}): Promise<void> {
  const { siteId, workerId, ym, before, after, actor } = params
  const day = Number(params.day)
  // 新規作成（壊すものが無い）は記録しない
  if (!before || Object.keys(before).length === 0) return
  try {
    await addDoc(collection(db, COLLECTION), {
      key: `${siteId}_${workerId}_${ym}_${day}`,
      siteId, workerId, ym, day,
      before,
      after: after ?? null,
      beforeSource: (before as { s?: string }).s || '',
      actor,
      kind: after ? 'overwrite' : 'delete',
      at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[attendance-history] 記録に失敗（本体処理は継続）:', e)
  }
}

/** 直近の変更履歴。ym を指定するとその月だけ */
export async function getAttendanceHistory(opts?: {
  ym?: string
  limitCount?: number
}): Promise<AttendanceHistoryEntry[]> {
  const col = collection(db, COLLECTION)
  const cons = []
  if (opts?.ym) cons.push(where('ym', '==', opts.ym))
  cons.push(orderBy('at', 'desc'))
  cons.push(limit(opts?.limitCount || 100))
  const snap = await getDocs(query(col, ...cons))
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<AttendanceHistoryEntry, 'id'>) }))
}

/** 保持期間を過ぎた履歴を削除して件数を返す（日次 cron から呼ぶ） */
export async function purgeOldHistory(): Promise<number> {
  const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 86400000).toISOString()
  const snap = await getDocs(query(
    collection(db, COLLECTION),
    where('at', '<', cutoff),
    limit(400),
  ))
  const { deleteDoc } = await import('@/lib/fsdb')
  let n = 0
  for (const d of snap.docs) { await deleteDoc(d.ref); n++ }
  return n
}

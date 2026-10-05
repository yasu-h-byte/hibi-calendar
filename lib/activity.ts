import { db } from './firebase'
import {
  collection,
  addDoc,
  doc,
  setDoc,
  query,
  orderBy,
  limit,
  getDocs,
  where,
  deleteDoc,
  QueryConstraint,
} from '@/lib/fsdb'

export interface ActivityEntry {
  id?: string
  userId: string
  action: string
  details: string
  timestamp: string
}

const ACTIVITY_COLLECTION = 'activityLog'

/**
 * 操作ログの保ち方（2026-10-02 総合点検）
 *
 * 旧: 1件書くたびに「新しい順に550件」を読み、500件を超えた分を消していた。
 *   - PC の出面を1マス保存するたびに約500件の読み取り（1日200マスで約10万回）。保存の待ち時間にも乗る
 *   - 出面の記録で500件がすぐ埋まり、請求書の発行・単価・マスタの変更の記録が数日で押し出された
 * 新:
 *   - 書くときは addDoc だけ。間引きは日次バックアップの cron（app/api/backup/snapshot）が pruneActivityLog() で行う
 *   - 「出面の入力」の記録（attendance.*・毎日大量に出る）は新しい NOISY_KEEP 件だけ残し、
 *     それ以外（請求・単価・マスタ・有給・カレンダー等）は別枠で IMPORTANT_KEEP 件残す＝出面の記録に押し出されない
 *   - お金・マスタの記録（DURABLE_PREFIXES）は、削除処理を持たない auditTrail にも同じ内容を残す
 *     （auditTrail は給与欄の変更記録と同じ扱い・日次バックアップの対象）
 */
/** 出面の入力の記録（量が多い）。新しいこの件数だけ残す */
const NOISY_KEEP = 500
/** それ以外の記録。新しいこの件数だけ残す（合計で日次バックアップの1件 1MB・2000件に収まる量） */
const IMPORTANT_KEEP = 1000
/** 1回の間引きで消す上限（cron の時間切れを防ぐ。残りは翌日） */
const PRUNE_PER_RUN = 400

/** 出面の入力の記録か（毎日大量に出る＝500件の枠で回す） */
export function isNoisyAction(action: string): boolean {
  return action.startsWith('attendance.')
}

/** 消えない記録（auditTrail）にも残す種類: 請求書・紙の請求書・外注の請求書・請求額・単価・現場/取引先/人員マスタ・設定・復元・月締め */
const DURABLE_PREFIXES = ['peerInvoice.', 'paperInvoice.', 'subconInvoice.', 'billing.', 'rates.', 'site.', 'subcon.', 'worker.', 'settings.', 'backup.', 'monthly.', 'integration.']
export function isDurableAction(action: string): boolean {
  return DURABLE_PREFIXES.some(p => action.startsWith(p))
}

/**
 * 操作ログを1件書く（書くだけ。間引きはしない）。
 * 失敗しても呼び出し元の処理は止めない（ログはあくまで記録）。
 */
export async function logActivity(
  userId: string,
  action: string,
  details: string,
): Promise<void> {
  const timestamp = new Date().toISOString()
  try {
    await addDoc(collection(db, ACTIVITY_COLLECTION), { userId, action, details, timestamp })
  } catch (error) {
    console.error('Failed to log activity:', error)
  }
  if (isDurableAction(action)) {
    try {
      await setDoc(doc(db, 'auditTrail', `activity-${timestamp.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`), {
        type: 'activity', action, userId, details, at: timestamp,
      })
    } catch (error) {
      console.error('Failed to write auditTrail:', error)
    }
  }
}

/**
 * 日次 cron から呼ぶ間引き。出面の記録は新しい NOISY_KEEP 件、それ以外は新しい IMPORTANT_KEEP 件を残して消す。
 * 戻り値は消した件数。
 */
export async function pruneActivityLog(opts?: { noisyKeep?: number; importantKeep?: number; maxDelete?: number }): Promise<number> {
  const noisyKeep = opts?.noisyKeep ?? NOISY_KEEP
  const importantKeep = opts?.importantKeep ?? IMPORTANT_KEEP
  const maxDelete = opts?.maxDelete ?? PRUNE_PER_RUN
  const col = collection(db, ACTIVITY_COLLECTION)
  // 残す件数＋消す上限より多くは読まない（新しい順）
  const snap = await getDocs(query(col, orderBy('timestamp', 'desc'), limit(noisyKeep + importantKeep + maxDelete)))
  let noisy = 0, important = 0
  const victims: { ref: unknown }[] = []
  for (const d of snap.docs) {
    const action = String((d.data() as { action?: string }).action || '')
    if (isNoisyAction(action)) { noisy++; if (noisy > noisyKeep) victims.push(d) }
    else { important++; if (important > importantKeep) victims.push(d) }
  }
  const toDelete = victims.slice(0, maxDelete)
  for (let i = 0; i < toDelete.length; i += 20) {
    await Promise.all(toDelete.slice(i, i + 20).map(d => deleteDoc(d.ref)))
  }
  return toDelete.length
}

/**
 * Fetch activity log entries with optional filters.
 */
export async function getActivityLog(opts?: {
  startDate?: string
  endDate?: string
  userId?: string
  action?: string
  limitCount?: number
}): Promise<ActivityEntry[]> {
  const col = collection(db, ACTIVITY_COLLECTION)
  const constraints: QueryConstraint[] = []

  constraints.push(orderBy('timestamp', 'desc'))

  if (opts?.startDate) {
    constraints.push(where('timestamp', '>=', opts.startDate))
  }
  if (opts?.endDate) {
    constraints.push(where('timestamp', '<=', opts.endDate + 'T23:59:59.999Z'))
  }

  constraints.push(limit(opts?.limitCount || 200))

  const q = query(col, ...constraints)
  const snap = await getDocs(q)

  let entries: ActivityEntry[] = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
  })) as ActivityEntry[]

  // Client-side filter for userId and action (Firestore compound queries require indexes)
  if (opts?.userId) {
    entries = entries.filter(e => e.userId === opts.userId)
  }
  if (opts?.action) {
    entries = entries.filter(e => e.action === opts.action)
  }

  return entries
}

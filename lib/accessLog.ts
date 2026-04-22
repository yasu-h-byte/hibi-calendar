/**
 * アクセスログ管理
 * - accessLog コレクションに、workerId + YYYY-MM-DD をキーとして1日1レコード
 * - firstAccessAt / lastAccessAt / accessCount を記録
 */

import { db } from './firebase'
import { doc, getDoc, setDoc, getDocs, collection, query, where, orderBy, deleteDoc } from 'firebase/firestore'

export type AccessRole = 'admin' | 'approver' | 'foreman' | 'jimu' | 'staff'

export interface AccessLogEntry {
  workerId: number
  workerName: string
  role: AccessRole
  org: string              // 'hibi' | 'hfu'
  date: string             // YYYY-MM-DD (JST)
  firstAccessAt: string    // ISO datetime
  lastAccessAt: string     // ISO datetime
  accessCount: number
  ipHash?: string
}

/**
 * 文字列のハッシュ値を計算（IP匿名化用）
 */
function hashString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * JST の YYYY-MM-DD を取得
 */
function getJstDate(d: Date = new Date()): string {
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`
}

/**
 * アクセス記録（その日に初アクセスなら新規作成、既にあれば更新）
 * エラーが発生しても呼び出し元に影響を与えないよう、例外を吸収
 */
export async function recordAccess(opts: {
  workerId: number
  workerName: string
  role: AccessRole
  org?: string
  ip?: string | null
}): Promise<void> {
  try {
    const now = new Date()
    const date = getJstDate(now)
    const docId = `${opts.workerId}_${date}`
    const ref = doc(db, 'accessLog', docId)
    const snap = await getDoc(ref)

    const ipHash = opts.ip ? hashString(opts.ip) : undefined
    const nowIso = now.toISOString()

    if (snap.exists()) {
      const data = snap.data() as AccessLogEntry
      await setDoc(ref, {
        ...data,
        lastAccessAt: nowIso,
        accessCount: (data.accessCount || 0) + 1,
        ...(ipHash ? { ipHash } : {}),
      })
    } else {
      const entry: AccessLogEntry = {
        workerId: opts.workerId,
        workerName: opts.workerName,
        role: opts.role,
        org: opts.org || 'hibi',
        date,
        firstAccessAt: nowIso,
        lastAccessAt: nowIso,
        accessCount: 1,
        ...(ipHash ? { ipHash } : {}),
      }
      await setDoc(ref, entry)
    }
  } catch (e) {
    console.warn('Failed to record access:', e)
  }
}

/**
 * IP取得ヘルパー（Next.js Request から）
 */
export function getRequestIp(request: Request): string | null {
  const headers = request.headers
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return headers.get('x-real-ip')
}

/**
 * 期間内のアクセスログを取得
 */
export async function getAccessLogsInRange(fromDate: string, toDate: string): Promise<AccessLogEntry[]> {
  const q = query(
    collection(db, 'accessLog'),
    where('date', '>=', fromDate),
    where('date', '<=', toDate),
    orderBy('date', 'desc'),
  )
  const snap = await getDocs(q)
  const result: AccessLogEntry[] = []
  snap.forEach(d => {
    result.push(d.data() as AccessLogEntry)
  })
  return result
}

/**
 * 各ワーカーの最終アクセス情報を集計
 */
export interface WorkerLastAccess {
  workerId: number
  workerName: string
  role: AccessRole
  org: string
  lastAccessDate: string | null       // YYYY-MM-DD
  lastAccessAt: string | null         // ISO datetime
  accessCountLast7Days: number
}

/**
 * 直近N日のアクセスログから、各ワーカーの最終アクセス情報を集計
 */
export async function getWorkerLastAccessMap(days: number = 90): Promise<Map<number, WorkerLastAccess>> {
  const to = getJstDate(new Date())
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - days)
  const from = getJstDate(fromDate)

  const logs = await getAccessLogsInRange(from, to)
  const map = new Map<number, WorkerLastAccess>()

  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const sevenAgoStr = getJstDate(sevenDaysAgo)

  for (const log of logs) {
    const existing = map.get(log.workerId)
    const isWithin7 = log.date >= sevenAgoStr
    if (!existing) {
      map.set(log.workerId, {
        workerId: log.workerId,
        workerName: log.workerName,
        role: log.role,
        org: log.org,
        lastAccessDate: log.date,
        lastAccessAt: log.lastAccessAt,
        accessCountLast7Days: isWithin7 ? log.accessCount : 0,
      })
    } else {
      // すでにエントリあり → より新しい日付で更新
      if (log.date > (existing.lastAccessDate || '')) {
        existing.lastAccessDate = log.date
        existing.lastAccessAt = log.lastAccessAt
      }
      if (isWithin7) {
        existing.accessCountLast7Days += log.accessCount
      }
    }
  }

  return map
}

/**
 * 古いアクセスログを削除（90日より前）
 */
export async function cleanupOldAccessLogs(retainDays: number = 90): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retainDays)
  const cutoffStr = getJstDate(cutoff)

  const q = query(collection(db, 'accessLog'), where('date', '<', cutoffStr))
  const snap = await getDocs(q)
  let deleted = 0
  for (const d of snap.docs) {
    await deleteDoc(d.ref)
    deleted++
  }
  return deleted
}

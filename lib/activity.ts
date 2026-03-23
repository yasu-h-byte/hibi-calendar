import { db } from './firebase'
import {
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  where,
  deleteDoc,
  QueryConstraint,
} from 'firebase/firestore'

export interface ActivityEntry {
  id?: string
  userId: string
  action: string
  details: string
  timestamp: string
}

const ACTIVITY_COLLECTION = 'activityLog'
const MAX_ENTRIES = 500

/**
 * Log an activity event to Firestore.
 * Keeps at most MAX_ENTRIES by cleaning up old entries on write.
 */
export async function logActivity(
  userId: string,
  action: string,
  details: string,
): Promise<void> {
  try {
    const col = collection(db, ACTIVITY_COLLECTION)

    await addDoc(col, {
      userId,
      action,
      details,
      timestamp: new Date().toISOString(),
    })

    // Cleanup: if total exceeds MAX_ENTRIES, delete oldest
    const countQuery = query(col, orderBy('timestamp', 'desc'), limit(MAX_ENTRIES + 50))
    const countSnap = await getDocs(countQuery)
    if (countSnap.size > MAX_ENTRIES) {
      const docs = countSnap.docs
      const toDelete = docs.slice(MAX_ENTRIES)
      for (const d of toDelete) {
        await deleteDoc(d.ref)
      }
    }
  } catch (error) {
    console.error('Failed to log activity:', error)
  }
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

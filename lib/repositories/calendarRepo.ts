/**
 * 就業カレンダー関連のFirestoreアクセスを集約
 *
 * - siteCalendar: 現場ごとのカレンダー（draft/submitted/approved）
 * - calendarSign: スタッフの署名記録
 *
 * APIルートに分散していた重複コードを統一。
 */

import { db } from '@/lib/firebase'
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  type DocumentSnapshot,
} from 'firebase/firestore'
import type { DayType } from '@/types'
import type { Ym7 } from '@/lib/ym'

// ────────────────────────────────────────
//  Site Calendar
// ────────────────────────────────────────

export type CalendarStatus = 'draft' | 'submitted' | 'approved' | 'rejected'

export interface SiteCalendarRecord {
  id: string // siteId_ym7（YYYY-MM）
  siteId: string
  ym: Ym7
  days: Record<string, DayType>
  status: CalendarStatus
  submittedBy?: number
  submittedAt?: string
  approvedBy?: number
  approvedAt?: string
  rejectedBy?: number
  rejectedAt?: string
  rejectedReason?: string
  revertedBy?: number
  revertedAt?: string
  updatedBy?: number
  updatedAt?: string
}

const CALENDAR_COL = 'siteCalendar'

/** 1現場・1月のカレンダーを取得 */
export async function getSiteCalendar(
  siteId: string,
  ym: Ym7,
): Promise<SiteCalendarRecord | null> {
  const id = `${siteId}_${ym}`
  const snap = await getDoc(doc(db, CALENDAR_COL, id))
  return snap.exists() ? ({ id, ...snap.data() } as SiteCalendarRecord) : null
}

/** 指定月の全現場カレンダーを取得 */
export async function getMonthlyCalendars(ym: Ym7): Promise<SiteCalendarRecord[]> {
  const q = query(collection(db, CALENDAR_COL), where('ym', '==', ym))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SiteCalendarRecord))
}

/** カレンダーを作成 or 更新 */
export async function saveSiteCalendar(
  siteId: string,
  ym: Ym7,
  data: Partial<Omit<SiteCalendarRecord, 'id' | 'siteId' | 'ym'>>,
): Promise<void> {
  const id = `${siteId}_${ym}`
  await setDoc(
    doc(db, CALENDAR_COL, id),
    { siteId, ym, ...data },
    { merge: true },
  )
}

/** カレンダーのフィールド更新 */
export async function updateSiteCalendar(
  siteId: string,
  ym: Ym7,
  updates: Partial<SiteCalendarRecord>,
): Promise<void> {
  const id = `${siteId}_${ym}`
  await updateDoc(doc(db, CALENDAR_COL, id), updates)
}

// ────────────────────────────────────────
//  Calendar Signatures
// ────────────────────────────────────────

const SIGN_COL = 'calendarSign'

export interface CalendarSignRecord {
  id: string // workerId_ym7_siteId
  workerId: number
  ym: Ym7
  siteId: string
  signedAt: string
  ipHash?: string
}

/** 指定月の全署名を取得 */
export async function getMonthlySignatures(ym: Ym7): Promise<CalendarSignRecord[]> {
  const q = query(collection(db, SIGN_COL), where('ym', '==', ym))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarSignRecord))
}

/** 指定現場・月の署名を取得 */
export async function getSiteSignatures(
  siteId: string,
  ym: Ym7,
): Promise<CalendarSignRecord[]> {
  const q = query(
    collection(db, SIGN_COL),
    where('ym', '==', ym),
    where('siteId', '==', siteId),
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarSignRecord))
}

/** 署名を保存 */
export async function saveSignature(
  workerId: number,
  ym: Ym7,
  siteId: string,
  data: { signedAt: string; ipHash?: string },
): Promise<void> {
  const id = `${workerId}_${ym}_${siteId}`
  await setDoc(doc(db, SIGN_COL, id), {
    workerId,
    ym,
    siteId,
    ...data,
  })
}

/** 署名を削除（承認取消し時等） */
export async function deleteSignature(
  workerId: number,
  ym: Ym7,
  siteId: string,
): Promise<void> {
  const id = `${workerId}_${ym}_${siteId}`
  await deleteDoc(doc(db, SIGN_COL, id))
}

/** 指定現場・月の全署名を削除（承認取消し時に一括削除） */
export async function deleteSiteSignatures(siteId: string, ym: Ym7): Promise<number> {
  const q = query(
    collection(db, SIGN_COL),
    where('ym', '==', ym),
    where('siteId', '==', siteId),
  )
  const snap = await getDocs(q)
  let count = 0
  for (const d of snap.docs) {
    await deleteDoc(d.ref)
    count++
  }
  return count
}

// ────────────────────────────────────────
//  Reset
// ────────────────────────────────────────

/** 指定月の全カレンダー＋全署名を削除（テスト用） */
export async function resetMonthlyData(ym: Ym7): Promise<{
  deletedCalendars: number
  deletedSignatures: number
}> {
  let deletedCalendars = 0
  let deletedSignatures = 0

  const calQ = query(collection(db, CALENDAR_COL), where('ym', '==', ym))
  const calSnap = await getDocs(calQ)
  for (const d of calSnap.docs) {
    await deleteDoc(d.ref)
    deletedCalendars++
  }

  const signQ = query(collection(db, SIGN_COL), where('ym', '==', ym))
  const signSnap = await getDocs(signQ)
  for (const d of signSnap.docs) {
    await deleteDoc(d.ref)
    deletedSignatures++
  }

  return { deletedCalendars, deletedSignatures }
}

// 内部利用: ドキュメントスナップショットの型が必要な場合
export type CalendarDocSnapshot = DocumentSnapshot

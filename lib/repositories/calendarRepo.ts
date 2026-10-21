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
} from '@/lib/fsdb'
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

/** 指定月の全現場カレンダーを取得 */
export async function getMonthlyCalendars(ym: Ym7): Promise<SiteCalendarRecord[]> {
  const q = query(collection(db, CALENDAR_COL), where('ym', '==', ym))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SiteCalendarRecord))
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

// 内部利用: ドキュメントスナップショットの型が必要な場合
export type CalendarDocSnapshot = DocumentSnapshot

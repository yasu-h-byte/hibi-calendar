/**
 * GET /api/calendar/history?siteId=xxx&ym=YYYY-MM
 *
 * 就業カレンダー 月×現場 の「提出・最終承認・差し戻し・取り消し・承認後の修正」の時系列（2026-10-22）。
 * 正本は calendarStatusLog（append-only）。ログを書き始める前の月は siteCalendar の項目から起こして補う。
 * 名前は人員マスタの名前だけ（給与の項目は返さない）。
 */
import { requireCap } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { ym7 } from '@/lib/ym'
import { loadCalendarStatusLog, workerNamesById } from '@/lib/calendar-status-log.server'
import { synthesizeTrailFromDoc, mergeTrailHistory, type CalendarTrailFields } from '@/lib/calendar-approval-trail'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // 権限表（lib/permissions.ts calendar.view）: 職長・事務・事業責任者・代表
  { const denied = await requireCap(request, 'calendar.view'); if (denied) return denied }

  const siteId = request.nextUrl.searchParams.get('siteId')
  const ymRaw = request.nextUrl.searchParams.get('ym')
  if (!siteId || !ymRaw) return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
  const ym = ym7(ymRaw)

  try {
    const [logEntries, calSnap, names] = await Promise.all([
      loadCalendarStatusLog(siteId, ym),
      getDoc(doc(db, 'siteCalendar', `${siteId}_${ym}`)),
      workerNamesById(),
    ])
    const raw = calSnap.exists() ? (calSnap.data() as Record<string, unknown>) : null
    const nameOf = (id: unknown) => (typeof id === 'number' ? names.get(id) ?? null : null)
    const current: CalendarTrailFields | null = raw ? {
      status: (raw.status as string) || null,
      submittedBy: (raw.submittedBy as number) ?? null, submittedAt: (raw.submittedAt as string) ?? null, submittedByName: nameOf(raw.submittedBy),
      approvedBy: (raw.approvedBy as number) ?? null, approvedAt: (raw.approvedAt as string) ?? null, approvedByName: nameOf(raw.approvedBy),
      rejectedBy: (raw.rejectedBy as number) ?? null, rejectedAt: (raw.rejectedAt as string) ?? null, rejectedByName: nameOf(raw.rejectedBy), rejectedReason: (raw.rejectedReason as string) ?? null,
      revertedBy: (raw.revertedBy as number) ?? null, revertedAt: (raw.revertedAt as string) ?? null, revertedByName: nameOf(raw.revertedBy),
      updatedBy: (raw.updatedBy as number) ?? null, updatedAt: (raw.updatedAt as string) ?? null, updatedByName: nameOf(raw.updatedBy),
    } : null
    const entries = mergeTrailHistory(logEntries, synthesizeTrailFromDoc(current))
    return NextResponse.json({ siteId, ym, entries, current })
  } catch (error) {
    console.error('calendar history error:', error)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }
}

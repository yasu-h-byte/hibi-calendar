/**
 * 就業カレンダーの法令チェックをサーバーで行う入口（2026-10-02 総合点検）。
 * 承認（approve）・一括確定（bulk-confirm）・承認後の修正（save-days）が同じこれを使う。
 *   - 前月・翌月の同じ現場のカレンダーがあれば読んで、月をまたぐ週の法定休日・連勤も見る（lib/calendar-legal.ts）
 *   - error（月の総枠超え）は無条件に拒否、warn（法定休日の無い週）は acknowledgeWarnings のときだけ通す
 */
import { NextResponse } from 'next/server'
import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { ym7 } from './ym'
import { addMonthsSafe } from './date-utils'
import { checkCalendarLegal, type CalendarLegalResult } from './calendar-legal'
import type { DayType } from '@/types'

async function loadSiteDays(siteId: string, ym: string): Promise<Record<string, DayType> | null> {
  const snap = await getDoc(doc(db, 'siteCalendar', `${siteId}_${ym}`))
  if (!snap.exists()) return null
  return (snap.data().days as Record<string, DayType> | undefined) || null
}

/** 隣の月のカレンダー込みで検査する（ym は "YYYY-MM" or "YYYYMM"） */
export async function checkSiteCalendarLegal(
  siteId: string, ymRaw: string, days: Record<string, DayType | string> | null | undefined,
): Promise<CalendarLegalResult> {
  const ym = ym7(ymRaw)
  const first = `${ym}-01`
  const prevYm = addMonthsSafe(first, -1).slice(0, 7)
  const nextYm = addMonthsSafe(first, 1).slice(0, 7)
  const [prevMonthDays, nextMonthDays] = await Promise.all([loadSiteDays(siteId, prevYm), loadSiteDays(siteId, nextYm)])
  return checkCalendarLegal(days, ym, { prevMonthDays, nextMonthDays })
}

/** 拒否する応答。通すなら null（error は無条件、warn は確認が無いとき） */
export function legalBlockResponse(
  legal: CalendarLegalResult, acknowledgeWarnings: boolean | undefined, prefix = '',
): Response | null {
  if (legal.hasError) {
    return NextResponse.json({
      error: legal.findings.filter(f => f.severity === 'error').map(f => `${prefix}${f.message}`).join('\n'),
    }, { status: 400 })
  }
  if (legal.hasWarn && !acknowledgeWarnings) {
    return NextResponse.json({
      error: '法令上の確認事項があります。内容を確認の上で承認してください。',
      requiresAcknowledge: true,
      warnings: legal.findings.filter(f => f.severity === 'warn').map(f => `${prefix}${f.message}`),
    }, { status: 400 })
  }
  return null
}

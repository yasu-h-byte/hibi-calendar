import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc, getDoc, setDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'
import { ym7 } from '@/lib/ym'
import { checkCalendarLegal } from '@/lib/calendar-legal'

export async function POST(request: NextRequest) {
  // 最終承認は管理者・事業責任者のみ（職長は提出まで）。サーバ側でロール強制。
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: '承認権限がありません（最終承認は管理者・事業責任者のみ）' }, { status: 403 })
  }

  try {
    const { siteId, ym: ymRaw, approvedBy, acknowledgeWarnings } = await request.json()
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    // Get the calendar data to count work days
    const calSnap = await getDoc(doc(db, 'siteCalendar', docId))
    const calData = calSnap.exists() ? calSnap.data() : null
    const days: Record<string, DayType> | null = calData?.days || null

    // 法令適合チェック（変形労働: 月総枠/法定休日/連続勤務）
    if (days) {
      const legal = checkCalendarLegal(days, ym)
      if (legal.hasError) {
        // 月の総労働時間超過などは無条件ブロック
        return NextResponse.json({
          error: legal.findings.filter(f => f.severity === 'error').map(f => f.message).join('\n'),
        }, { status: 400 })
      }
      if (legal.hasWarn && !acknowledgeWarnings) {
        // 法定休日のない週など。例外（4週4日制等）があり得るため確認の上で承認可
        return NextResponse.json({
          error: '法令上の確認事項があります。内容を確認の上で承認してください。',
          requiresAcknowledge: true,
          warnings: legal.findings.filter(f => f.severity === 'warn').map(f => f.message),
        }, { status: 400 })
      }
    }

    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy,
    })

    // Auto-calculate work days from the calendar and save per-site
    if (days) {
      const workDayCount = Object.values(days).filter(d => d === 'work').length

      // Convert ym from "YYYY-MM" to "YYYYMM" for workDays key
      const ymKey = ym.replace('-', '')

      // Save per-site workDays: siteWorkDays.{YYYYMM}.{siteId} = count
      const mainRef = doc(db, 'demmen', 'main')
      await setDoc(mainRef, {
        siteWorkDays: { [ymKey]: { [siteId]: workDayCount } },
      }, { merge: true })

      // Also update global workDays with the max across all sites
      const mainSnap = await getDoc(mainRef)
      const mainData = mainSnap.exists() ? mainSnap.data() : {}
      const siteWorkDaysForMonth = (mainData.siteWorkDays || {})[ymKey] || {}
      const maxWorkDays = Math.max(...Object.values(siteWorkDaysForMonth) as number[])
      await setDoc(mainRef, {
        workDays: { [ymKey]: maxWorkDays },
      }, { merge: true })
    }

    await logActivity(String(approvedBy || 'admin'), 'calendar.approve', `${siteId} ${ym} を承認`)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to approve:', error)
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 })
  }
}

import { getApiRole, isManagerRole, requireCap } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc, getDoc, setDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { DayType } from '@/types'
import { ym7 } from '@/lib/ym'
import { checkSiteCalendarLegal, legalBlockResponse } from '@/lib/calendar-legal-check'
import { countWorkDays } from '@/lib/calendar'

export async function POST(request: NextRequest) {
  // 最終承認は管理者・事業責任者のみ（職長は提出まで）。サーバ側でロール強制。
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: '承認権限がありません（最終承認は管理者・事業責任者のみ）' }, { status: 403 })
  }

  try {
    const { siteId, ym: ymRaw, acknowledgeWarnings } = await request.json()
    // 誰がやったかは通行証（getApiRole）から決める。旧: 画面が送る body の値をそのまま記録していた（2026-10-21 総点検）
    const approvedBy = role.workerId ?? 0
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    // Get the calendar data to count work days
    const calSnap = await getDoc(doc(db, 'siteCalendar', docId))
    const calData = calSnap.exists() ? calSnap.data() : null
    const days: Record<string, DayType> | null = calData?.days || null

    // 提出されていないカレンダーの承認（直接承認）は権限表の calendar.forceApprove（代表）だけ（2026-10-21）。
    //   旧: 画面は代表にだけボタンを出していたが、サーバは事業責任者でも通していた
    if (calData?.status !== 'submitted') {
      const denied = await requireCap(request, 'calendar.forceApprove')
      if (denied) return NextResponse.json({ error: '提出されていないカレンダーを直接承認できるのは代表だけです。職長の提出を待ってから承認してください' }, { status: 403 })
    }

    // 法令適合チェック（変形労働: 月総枠/法定休日/連続勤務）。前月・翌月のカレンダー込み（2026-10-02 総合点検）
    //   error は無条件ブロック、warn（法定休日のない週など）は例外（4週4日制等）があり得るため確認の上で承認可
    if (days) {
      const legal = await checkSiteCalendarLegal(siteId, ym, days)
      const blocked = legalBlockResponse(legal, acknowledgeWarnings)
      if (blocked) return blocked
    }

    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy,
    })

    // Auto-calculate work days from the calendar and save per-site
    if (days) {
      // 欠けた日の扱いを法令チェック・画面と同じにする（resolveDayType・2026-10-02 総合点検）
      const workDayCount = countWorkDays(days, ym)

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

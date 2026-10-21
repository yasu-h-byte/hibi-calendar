import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { ym7 } from '@/lib/ym'
import { appendCalendarStatusLog } from '@/lib/calendar-status-log.server'

export async function POST(request: NextRequest) {
  // 差し戻しは管理者・事業責任者のみ
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: '差し戻し権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
  }

  try {
    const { siteId, ym: ymRaw, reason } = await request.json()
    // 誰がやったかは通行証（getApiRole）から決める。旧: 画面が送る body の値をそのまま記録していた（2026-10-21 総点検）
    const rejectedBy = role.workerId ?? 0
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    const rejectedAt = new Date().toISOString()
    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'rejected',
      rejectedReason: reason || null,
      rejectedAt,
      rejectedBy: rejectedBy,
    })
    // 「いつ・誰が」の台帳（append-only・2026-10-22）
    await appendCalendarStatusLog({ siteId, ym, event: 'reject', by: rejectedBy, at: rejectedAt, reason: reason || null })

    await logActivity(String(rejectedBy || 'admin'), 'calendar.reject', `${siteId} ${ym} を差し戻し${reason ? `（理由: ${reason}）` : ''}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to reject:', error)
    return NextResponse.json({ error: 'Failed to reject' }, { status: 500 })
  }
}

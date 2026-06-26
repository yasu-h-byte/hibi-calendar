import { getApiRole, isManagerRole } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { ym7 } from '@/lib/ym'

export async function POST(request: NextRequest) {
  // 差し戻しは管理者・事業責任者のみ
  const role = await getApiRole(request)
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(role.role)) {
    return NextResponse.json({ error: '差し戻し権限がありません（管理者・事業責任者のみ）' }, { status: 403 })
  }

  try {
    const { siteId, ym: ymRaw, rejectedBy, reason } = await request.json()
    const ym = ym7(ymRaw)
    const docId = `${siteId}_${ym}`

    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'rejected',
      rejectedReason: reason || null,
      rejectedAt: new Date().toISOString(),
      rejectedBy: rejectedBy,
    })

    await logActivity(String(rejectedBy || 'admin'), 'calendar.reject', `${siteId} ${ym} を差し戻し${reason ? `（理由: ${reason}）` : ''}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to reject:', error)
    return NextResponse.json({ error: 'Failed to reject' }, { status: 500 })
  }
}

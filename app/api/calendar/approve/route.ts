import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, approvedBy } = await request.json()
    const docId = `${siteId}_${ym}`

    await updateDoc(doc(db, 'siteCalendar', docId), {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy,
    })

    await logActivity(String(approvedBy || 'admin'), 'calendar.approve', `${siteId} ${ym} を承認`)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to approve:', error)
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 })
  }
}

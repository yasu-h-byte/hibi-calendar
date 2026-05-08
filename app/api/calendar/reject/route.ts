import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { ym7 } from '@/lib/ym'

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to reject:', error)
    return NextResponse.json({ error: 'Failed to reject' }, { status: 500 })
  }
}

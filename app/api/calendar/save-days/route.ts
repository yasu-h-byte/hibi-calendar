import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, days, updatedBy } = await request.json()
    const docId = `${siteId}_${ym}`

    // Get existing doc to preserve status
    const existing = await getDoc(doc(db, 'siteCalendar', docId))
    const existingData = existing.exists() ? existing.data() : {}

    await setDoc(doc(db, 'siteCalendar', docId), {
      siteId,
      ym,
      days,
      status: existingData.status === 'rejected' ? 'draft' : (existingData.status || 'draft'),
      submittedAt: existingData.submittedAt || null,
      submittedBy: existingData.submittedBy || null,
      approvedAt: existingData.approvedAt || null,
      approvedBy: existingData.approvedBy || null,
      rejectedReason: existingData.status === 'rejected' ? null : (existingData.rejectedReason || null),
      updatedAt: new Date().toISOString(),
      updatedBy,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to save days:', error)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}

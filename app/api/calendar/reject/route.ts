import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, rejectedBy, reason } = await request.json()
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

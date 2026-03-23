import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { siteId, ym, submittedBy } = await request.json()
    const docId = `${siteId}_${ym}`
    const docRef = doc(db, 'siteCalendar', docId)
    const existing = await getDoc(docRef)

    if (!existing.exists()) {
      return NextResponse.json({ error: 'Calendar not found. Save first.' }, { status: 404 })
    }

    await updateDoc(docRef, {
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      submittedBy,
      rejectedReason: null,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to submit:', error)
    return NextResponse.json({ error: 'Failed to submit' }, { status: 500 })
  }
}

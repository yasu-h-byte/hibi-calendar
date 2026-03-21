import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, setDoc } from 'firebase/firestore'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || authHeader !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { workerId, ym, patternId } = await request.json()
    const docId = `${workerId}_${ym}`
    await setDoc(doc(db, 'workerCalendar', docId), {
      workerId,
      ym,
      patternId,
      assignedAt: new Date().toISOString(),
      assignedBy: 'admin',
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to assign calendar:', error)
    return NextResponse.json({ error: 'Failed to assign' }, { status: 500 })
  }
}

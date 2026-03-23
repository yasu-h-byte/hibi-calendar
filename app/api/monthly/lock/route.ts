import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { ym, locked } = await request.json()
    if (!ym) {
      return NextResponse.json({ error: 'ym required' }, { status: 400 })
    }

    const docRef = doc(db, 'demmen', 'main')
    await updateDoc(docRef, { [`locks.${ym}`]: locked ? true : false })

    await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} を${locked ? '締め' : '締め解除'}`)
    return NextResponse.json({ success: true, locked: !!locked })
  } catch (error) {
    console.error('Lock POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'

function hashIP(ip: string): string {
  // Simple hash for IP anonymization
  let hash = 0
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export async function POST(request: NextRequest) {
  try {
    const { workerId, ym, token } = await request.json()

    // Verify token
    const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
    if (!mainDoc.exists()) {
      return NextResponse.json({ error: 'Data not found' }, { status: 404 })
    }
    const workers = mainDoc.data().workers || []
    const worker = workers.find((w: Record<string, unknown>) => w.token === token && w.id === workerId)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Check if already signed
    const signDocId = `${workerId}_${ym}`
    const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))
    if (existingSign.exists()) {
      return NextResponse.json({ error: 'Already signed', signedAt: existingSign.data().signedAt }, { status: 409 })
    }

    // Check if calendar is assigned
    const assignDoc = await getDoc(doc(db, 'workerCalendar', signDocId))
    if (!assignDoc.exists()) {
      return NextResponse.json({ error: 'Calendar not assigned' }, { status: 404 })
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const ipHash = hashIP(ip)

    await setDoc(doc(db, 'calendarSign', signDocId), {
      workerId,
      ym,
      signedAt: new Date().toISOString(),
      method: 'tap',
      ipHash,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to sign:', error)
    return NextResponse.json({ error: 'Failed to sign' }, { status: 500 })
  }
}

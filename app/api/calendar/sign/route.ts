import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getWorkersForSite } from '@/lib/sites'

function hashIP(ip: string): string {
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
    const { workerId, ym, siteId } = await request.json()

    if (!workerId || !ym || !siteId) {
      return NextResponse.json({ error: 'workerId, ym, siteId required' }, { status: 400 })
    }

    // Verify worker belongs to the site
    const workers = await getWorkersForSite(siteId)
    const worker = workers.find(w => w.id === workerId)
    if (!worker) {
      return NextResponse.json({ error: 'Worker not found on this site' }, { status: 401 })
    }

    // Check if site calendar is approved
    const calDocId = `${siteId}_${ym}`
    const calDoc = await getDoc(doc(db, 'siteCalendar', calDocId))
    if (!calDoc.exists()) {
      return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
    }
    if (calDoc.data().status !== 'approved') {
      return NextResponse.json({ error: 'Calendar not yet approved' }, { status: 403 })
    }

    // Check if already signed
    const signDocId = `${workerId}_${ym}_${siteId}`
    const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))
    if (existingSign.exists()) {
      return NextResponse.json({ error: 'Already signed', signedAt: existingSign.data().signedAt }, { status: 409 })
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

    await setDoc(doc(db, 'calendarSign', signDocId), {
      workerId,
      ym,
      siteId,
      signedAt: new Date().toISOString(),
      method: 'tap',
      ipHash: hashIP(ip),
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to sign:', error)
    return NextResponse.json({ error: 'Failed to sign' }, { status: 500 })
  }
}

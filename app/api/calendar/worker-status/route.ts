import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const ym = request.nextUrl.searchParams.get('ym')

  if (!token || !ym) {
    return NextResponse.json({ error: 'token and ym parameters required' }, { status: 400 })
  }

  try {
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const docId = `${worker.id}_${ym}`

    // Get assignment
    const assignDoc = await getDoc(doc(db, 'workerCalendar', docId))
    const assignment = assignDoc.exists() ? assignDoc.data() : null

    // Get signature
    const signDoc = await getDoc(doc(db, 'calendarSign', docId))
    const signature = signDoc.exists() ? signDoc.data() : null

    return NextResponse.json({
      worker: { id: worker.id, name: worker.name, nameVi: worker.nameVi },
      assignment,
      signature,
    })
  } catch (error) {
    console.error('Failed to fetch worker status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}

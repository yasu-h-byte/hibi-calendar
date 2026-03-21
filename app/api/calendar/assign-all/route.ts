import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, setDoc } from 'firebase/firestore'
import { getWorkers } from '@/lib/workers'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || authHeader !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { ym, patternId } = await request.json()
    const workers = await getWorkers()

    for (const worker of workers) {
      const docId = `${worker.id}_${ym}`
      await setDoc(doc(db, 'workerCalendar', docId), {
        workerId: worker.id,
        ym,
        patternId,
        assignedAt: new Date().toISOString(),
        assignedBy: 'admin',
      })
    }

    return NextResponse.json({ success: true, count: workers.length })
  } catch (error) {
    console.error('Failed to assign all:', error)
    return NextResponse.json({ error: 'Failed to assign all' }, { status: 500 })
  }
}

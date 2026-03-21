import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('x-admin-password')
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || authHeader !== adminPassword) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ym = request.nextUrl.searchParams.get('ym')
  if (!ym) {
    return NextResponse.json({ error: 'ym parameter required' }, { status: 400 })
  }

  try {
    // Get assignments
    const assignQ = query(collection(db, 'workerCalendar'), where('ym', '==', ym))
    const assignSnap = await getDocs(assignQ)
    const assignments: Record<number, string> = {}
    assignSnap.forEach(d => {
      const data = d.data()
      assignments[data.workerId] = data.patternId
    })

    // Get signatures
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym))
    const signSnap = await getDocs(signQ)
    const signatures: Record<number, string> = {}
    signSnap.forEach(d => {
      const data = d.data()
      signatures[data.workerId] = data.signedAt
    })

    return NextResponse.json({ assignments, signatures })
  } catch (error) {
    console.error('Failed to fetch status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}

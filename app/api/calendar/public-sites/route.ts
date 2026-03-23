import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkers } from '@/lib/sites'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const ym = url.searchParams.get('ym')
  if (!ym) {
    return NextResponse.json({ error: 'ym required' }, { status: 400 })
  }

  try {
    // Get approved calendars only
    const calQ = query(
      collection(db, 'siteCalendar'),
      where('ym', '==', ym),
      where('status', '==', 'approved')
    )
    const calSnap = await getDocs(calQ)
    const approvedSites = new Set<string>()
    calSnap.forEach(d => approvedSites.add(d.data().siteId))

    // Get sites with workers
    const sitesWithWorkers = await getAllSitesWithWorkers()

    // Get signatures
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym))
    const signSnap = await getDocs(signQ)
    const sigs: Record<string, boolean> = {}
    signSnap.forEach(d => {
      const data = d.data()
      sigs[`${data.workerId}_${data.siteId}`] = true
    })

    const sites = sitesWithWorkers
      .filter(sw => approvedSites.has(sw.site.id))
      .map(sw => ({
        id: sw.site.id,
        name: sw.site.name,
        workerCount: sw.workers.length,
        signedCount: sw.workers.filter(w => sigs[`${w.id}_${sw.site.id}`]).length,
      }))

    return NextResponse.json({ sites })
  } catch (error) {
    console.error('Failed to fetch public sites:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

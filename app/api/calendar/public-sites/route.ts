import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
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
    const approvedCalendars: Record<string, Record<string, string>> = {}
    calSnap.forEach(d => {
      const data = d.data()
      approvedSites.add(data.siteId)
      approvedCalendars[data.siteId] = data.days || {}
    })

    // Get sites with workers
    const sitesWithWorkers = await getAllSitesWithWorkers()

    // Get signatures
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym))
    const signSnap = await getDocs(signQ)
    const sigs: Record<string, string> = {} // key: workerId_siteId, value: signedAt
    signSnap.forEach(d => {
      const data = d.data()
      sigs[`${data.workerId}_${data.siteId}`] = data.signedAt || 'true'
    })

    // Build site list (backwards compatible)
    const sites = sitesWithWorkers
      .filter(sw => approvedSites.has(sw.site.id))
      .map(sw => ({
        id: sw.site.id,
        name: sw.site.name,
        workerCount: sw.workers.filter(w => !!w.token).length,
        signedCount: sw.workers.filter(w => !!w.token && sigs[`${w.id}_${sw.site.id}`]).length,
        days: approvedCalendars[sw.site.id] || {},
      }))

    // Build foreign workers list: ALL foreign workers × ALL approved sites
    // (全員が全現場のカレンダーに署名する方式)
    const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
    const allWorkers = mainDoc.exists() ? (mainDoc.data().workers || []) : []
    const foreignWorkers = allWorkers.filter((w: Record<string, unknown>) =>
      w.token && w.visa && w.visa !== 'none' && !w.retired
    )

    const approvedSiteList = sitesWithWorkers.filter(sw => approvedSites.has(sw.site.id))

    const workerMap = new Map<number, {
      id: number
      name: string
      nameVi: string
      token: string
      sites: { siteId: string; siteName: string; signed: boolean; signedAt: string | null }[]
    }>()

    for (const w of foreignWorkers) {
      const wId = w.id as number
      workerMap.set(wId, {
        id: wId,
        name: w.name as string,
        nameVi: (w.nameVi as string) || '',
        token: w.token as string,
        sites: approvedSiteList.map(sw => {
          const sigKey = `${wId}_${sw.site.id}`
          return {
            siteId: sw.site.id,
            siteName: sw.site.name,
            signed: !!sigs[sigKey],
            signedAt: sigs[sigKey] && sigs[sigKey] !== 'true' ? sigs[sigKey] : null,
          }
        }),
      })
    }

    const workers = Array.from(workerMap.values()).map(w => ({
      ...w,
      allSigned: w.sites.every(s => s.signed),
      unsignedCount: w.sites.filter(s => !s.signed).length,
    }))

    return NextResponse.json({ sites, workers })
  } catch (error) {
    console.error('Failed to fetch public sites:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

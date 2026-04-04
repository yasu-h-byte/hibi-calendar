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

    // Build foreign workers list (workers with tokens) across all approved sites
    // Deduplicate workers across sites
    const workerMap = new Map<number, {
      id: number
      name: string
      nameVi: string
      token: string
      sites: { siteId: string; siteName: string; signed: boolean; signedAt: string | null }[]
    }>()

    for (const sw of sitesWithWorkers) {
      if (!approvedSites.has(sw.site.id)) continue
      for (const w of sw.workers) {
        if (!w.token) continue // only foreign workers with tokens
        if (!workerMap.has(w.id)) {
          workerMap.set(w.id, {
            id: w.id,
            name: w.name,
            nameVi: w.nameVi || '',
            token: w.token,
            sites: [],
          })
        }
        const sigKey = `${w.id}_${sw.site.id}`
        workerMap.get(w.id)!.sites.push({
          siteId: sw.site.id,
          siteName: sw.site.name,
          signed: !!sigs[sigKey],
          signedAt: sigs[sigKey] && sigs[sigKey] !== 'true' ? sigs[sigKey] : null,
        })
      }
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

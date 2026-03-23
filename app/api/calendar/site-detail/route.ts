import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getWorkersForSite, getSiteById } from '@/lib/sites'

export async function GET(request: NextRequest) {
  const siteId = request.nextUrl.searchParams.get('siteId')
  const ym = request.nextUrl.searchParams.get('ym')
  if (!siteId || !ym) {
    return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
  }

  try {
    const site = await getSiteById(siteId)
    if (!site) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404 })
    }

    // Get calendar
    const calDoc = await getDoc(doc(db, 'siteCalendar', `${siteId}_${ym}`))
    if (!calDoc.exists() || calDoc.data().status !== 'approved') {
      return NextResponse.json({ error: 'Calendar not approved' }, { status: 404 })
    }

    const calData = calDoc.data()

    // Get workers for this site
    const workers = await getWorkersForSite(siteId)

    // Get signatures
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym), where('siteId', '==', siteId))
    const signSnap = await getDocs(signQ)
    const sigs: Record<number, string> = {}
    signSnap.forEach(d => {
      const data = d.data()
      sigs[data.workerId] = data.signedAt
    })

    return NextResponse.json({
      site: { id: site.id, name: site.name },
      days: calData.days,
      workers: workers
        .filter(w => !!w.token) // 署名対象は実習生・特定技能生のみ
        .map(w => ({
          id: w.id,
          name: w.name,
          nameVi: w.nameVi,
          signed: !!sigs[w.id],
          signedAt: sigs[w.id] || null,
        })),
    })
  } catch (error) {
    console.error('Failed to fetch site detail:', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

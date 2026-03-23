import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkers } from '@/lib/sites'

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
    // Get site calendar data (days + status)
    const siteCalQ = query(collection(db, 'siteCalendar'), where('ym', '==', ym))
    const siteCalSnap = await getDocs(siteCalQ)
    const siteCalendars: Record<string, {
      days: Record<string, string>
      status: string
      submittedBy: number | null
      approvedBy: number | null
      rejectedReason: string | null
    }> = {}
    siteCalSnap.forEach(d => {
      const data = d.data()
      siteCalendars[data.siteId] = {
        days: data.days || null,
        status: data.status || 'draft',
        submittedBy: data.submittedBy || null,
        approvedBy: data.approvedBy || null,
        rejectedReason: data.rejectedReason || null,
      }
    })

    // Get signatures
    const signQ = query(collection(db, 'calendarSign'), where('ym', '==', ym))
    const signSnap = await getDocs(signQ)
    const signaturesBySite: Record<string, string> = {}
    signSnap.forEach(d => {
      const data = d.data()
      signaturesBySite[`${data.workerId}_${data.siteId}`] = data.signedAt
    })

    // Get all sites with workers
    const sitesWithWorkers = await getAllSitesWithWorkers()

    const sites = sitesWithWorkers.map(sw => {
      const cal = siteCalendars[sw.site.id]
      return {
        siteId: sw.site.id,
        siteName: sw.site.name,
        days: cal?.days || null,
        status: cal?.status || null,
        submittedBy: cal?.submittedBy || null,
        approvedBy: cal?.approvedBy || null,
        rejectedReason: cal?.rejectedReason || null,
        workers: sw.workers
          .filter(w => !!w.token) // 署名対象は実習生・特定技能生（トークン持ち）のみ
          .map(w => ({
            id: w.id,
            name: w.name,
            signed: !!signaturesBySite[`${w.id}_${sw.site.id}`],
            signedAt: signaturesBySite[`${w.id}_${sw.site.id}`] || null,
          })),
      }
    })

    return NextResponse.json({ sites })
  } catch (error) {
    console.error('Failed to fetch status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}

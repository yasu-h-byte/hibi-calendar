import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkers } from '@/lib/sites'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { ym7 } from '@/lib/ym'
import { isCalendarSignTarget } from '@/lib/workers'

export async function GET(request: NextRequest) {

  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ymRaw = request.nextUrl.searchParams.get('ym')
  if (!ymRaw) {
    return NextResponse.json({ error: 'ym parameter required' }, { status: 400 })
  }
  // siteCalendar の ym フィールドは "YYYY-MM" 形式（2026-05-08 正規化）
  const ym = ym7(ymRaw)

  try {
    // 独立した 4 つの I/O を並列化（以前は sequential で 4 RTT、いまは 1 RTT 相当）
    const [siteCalSnap, signSnap, sitesWithWorkers, homeLeaves, mainDoc] = await Promise.all([
      getDocs(query(collection(db, 'siteCalendar'), where('ym', '==', ym))),
      getDocs(query(collection(db, 'calendarSign'), where('ym', '==', ym))),
      getAllSitesWithWorkers(ym),
      getAllActiveHomeLeaves(),
      getDoc(doc(db, 'demmen', 'main')),
    ])

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

    const signaturesBySite: Record<string, string> = {}
    signSnap.forEach(d => {
      const data = d.data()
      signaturesBySite[`${data.workerId}_${data.siteId}`] = data.signedAt
    })

    // 2026-05-27: 「全員が全現場のカレンダーに署名する」モデル。
    //   /api/calendar/public-sites と数字を揃えるため、
    //   全外国人 × 全現場 で集計する（管理画面と公開ページの人数が整合）
    const ymKey = normalizeYm(ym)
    const fullMonthHlIds = new Set(
      ((mainDoc.exists() ? (mainDoc.data().workers || []) : []) as Record<string, unknown>[])
        .map(w => w.id as number)
        .filter(id => isFullMonthHomeLeave(id, ymKey, homeLeaves))
    )
    const allRawWorkers = mainDoc.exists() ? ((mainDoc.data().workers || []) as Record<string, unknown>[]) : []
    const eligibleForeignWorkers = allRawWorkers
      .filter(w => isCalendarSignTarget(
        { id: w.id as number, visa: w.visa as string, token: w.token as string, retired: w.retired as string | undefined },
        ym,
        fullMonthHlIds,
      ))
      .map(w => ({ id: w.id as number, name: w.name as string }))

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
        // 全現場に対して同じ署名対象スタッフを返す
        workers: eligibleForeignWorkers.map(w => ({
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

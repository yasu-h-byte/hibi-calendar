import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { getAllSitesWithWorkers } from '@/lib/sites'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { ym7 } from '@/lib/ym'
import { isStillActiveForMonth } from '@/lib/workers'

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

    // Get all sites with workers（ym を渡して退職月のスタッフも対象）
    const sitesWithWorkers = await getAllSitesWithWorkers(ym)

    // 帰国情報を取得（当該月の全期間が帰国中のスタッフは署名対象から除外）
    const homeLeaves = await getAllActiveHomeLeaves()
    const ymKey = normalizeYm(ym)

    // 2026-05-27: 「全員が全現場のカレンダーに署名する」モデルに変更
    //   従来は site.workers（=その現場に配置されたスタッフのみ）を署名対象としていたが、
    //   /api/calendar/public-sites（外国人スタッフ向けページ）と数字を揃えるため、
    //   全外国人 × 全現場 で集計する。
    //   これで /calendar 管理画面の「3/13名」と /calendar/public の人数が整合する。
    const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
    const allRawWorkers = mainDoc.exists() ? ((mainDoc.data().workers || []) as Record<string, unknown>[]) : []
    const eligibleForeignWorkers = allRawWorkers
      .filter(w =>
        w.token && w.visa && w.visa !== 'none' &&
        isStillActiveForMonth(w.retired as string | undefined, ym)
      )
      .filter(w => !isFullMonthHomeLeave(w.id as number, ymKey, homeLeaves))
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

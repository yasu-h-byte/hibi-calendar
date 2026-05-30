import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { ym7 } from '@/lib/ym'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'

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
    // 共通データ取得 → このルートでは「全現場 × 全外国人 × 署名状態」を投影
    const m = await loadCalendarMatrix(ym)

    const eligibleForeignWorkers = m.eligibleForeignWorkers.map(w => ({ id: w.id, name: w.name }))

    const sites = m.sitesWithWorkers.map(sw => {
      const cal = m.siteCalendars[sw.site.id]
      return {
        siteId: sw.site.id,
        siteName: sw.site.name,
        days: cal?.days || null,
        status: cal?.status || null,
        submittedBy: cal?.submittedBy || null,
        approvedBy: cal?.approvedBy || null,
        rejectedReason: cal?.rejectedReason || null,
        // 全現場に対して同じ署名対象スタッフを返す（公開ページと数字を揃えるため）
        workers: eligibleForeignWorkers.map(w => ({
          id: w.id,
          name: w.name,
          signed: !!m.signaturesBySite[`${w.id}_${sw.site.id}`],
          signedAt: m.signaturesBySite[`${w.id}_${sw.site.id}`] || null,
        })),
      }
    })

    return NextResponse.json({ sites })
  } catch (error) {
    console.error('Failed to fetch status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}

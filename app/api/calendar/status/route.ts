import { checkApiAuth } from "@/lib/auth"
import { NextRequest, NextResponse } from 'next/server'
import { ym7 } from '@/lib/ym'
import { loadCalendarMatrix, projectSignSites } from '@/lib/calendar-matrix'

export async function GET(request: NextRequest) {
  // auth: any-login — 出面入力の画面（職長・事務）がカレンダーの状態を読む

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

    // 投影は lib/calendar-matrix.ts projectSignSites（通知ベルと共通・2026-09-26）
    const sites = projectSignSites(m).map(({ cal, ...p }) => ({
      ...p,
      days: cal?.days || null,
      submittedBy: cal?.submittedBy || null,
      approvedBy: cal?.approvedBy || null,
      approvedAt: cal?.approvedAt || null,
      updatedAt: cal?.updatedAt || null,
      updatedBy: cal?.updatedBy || null,
      rejectedReason: cal?.rejectedReason || null,
    }))

    return NextResponse.json({ sites })
  } catch (error) {
    console.error('Failed to fetch status:', error)
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 })
  }
}

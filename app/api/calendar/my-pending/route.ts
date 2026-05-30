/**
 * GET /api/calendar/my-pending?token=xxx&ym=YYYY-MM
 *
 * トークン認証された外国人スタッフ本人が、対象月のカレンダー承認状況を
 * 取得する。出面入力画面（/attendance/[token]）に「翌月のカレンダー承認」
 * バナーを出すための情報源。
 *
 * セキュリティ: 旧 /calendar/public は「名前を選んで承認」だったため
 * 他人になりすまし可能だった。本 API は token → workerId をサーバ側で
 * 解決するため、本人のサイン状況だけ返す。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import { loadCalendarMatrix } from '@/lib/calendar-matrix'

// query パラメータを使うため強制的に動的レンダリング
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const token = url.searchParams.get('token')
    const ym = url.searchParams.get('ym')  // "YYYY-MM"
    if (!token || !ym) {
      return NextResponse.json({ error: 'token and ym required' }, { status: 400 })
    }

    // Token → worker（なりすまし対策の根幹）
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // 外国人スタッフ以外には機能を提供しない（日本人は承認フローなし）
    if (!worker.visaType || worker.visaType === 'none') {
      return NextResponse.json({ error: 'Not applicable for this worker' }, { status: 400 })
    }

    // 共通データ取得（status/public-sites と同じローダー）
    const m = await loadCalendarMatrix(ym)

    const fullMonthHomeLeave = m.fullMonthHlIds.has(worker.id)

    // 本人の署名状態のみを各現場に投影
    const sites = m.sitesWithWorkers.map(sw => {
      const cal = m.siteCalendars[sw.site.id]
      const sigVal = m.signaturesBySite[`${worker.id}_${sw.site.id}`]
      return {
        siteId: sw.site.id,
        siteName: sw.site.name,
        status: (cal?.status || null) as 'approved' | 'draft' | 'submitted' | null,
        days: cal?.days || null,
        signed: !!sigVal,
        signedAt: sigVal && sigVal !== 'true' ? sigVal : null,
      }
    })

    // 「全現場の翌月カレンダー」が全て approved になっているか
    const allApproved = sites.length > 0 && sites.every(s => s.status === 'approved')

    return NextResponse.json({
      workerId: worker.id,
      workerName: worker.name,
      ym,
      allApproved,
      fullMonthHomeLeave,
      sites,
    })
  } catch (error) {
    console.error('my-pending error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

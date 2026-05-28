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
 *
 * 戻り値:
 *   {
 *     workerId: number,
 *     workerName: string,
 *     ym: string,                       // "YYYY-MM"
 *     allApproved: boolean,             // 全現場（archived 除外）が approved か
 *     fullMonthHomeLeave: boolean,      // 当該月の全期間が帰国中なら true
 *     sites: [
 *       {
 *         siteId, siteName,
 *         status: 'approved' | 'draft' | 'submitted' | null,
 *         days: Record<string, 'work'|'off'|'holiday'> | null,
 *         signed: boolean,
 *         signedAt: string | null,
 *       }
 *     ]
 *   }
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'
import { getAllSitesWithWorkers } from '@/lib/sites'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'

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

    // 当該月の全期間が帰国中なら署名不要
    const homeLeaves = await getAllActiveHomeLeaves()
    const fullMonthHomeLeave = isFullMonthHomeLeave(worker.id, normalizeYm(ym), homeLeaves)

    // 現場一覧（archived 除外、ym で退職月フィルタ）
    const ymCompact = ym.replace('-', '')
    const sitesWithWorkers = await getAllSitesWithWorkers(ymCompact)

    // siteCalendar の状態を取得
    const calQ = query(collection(db, 'siteCalendar'), where('ym', '==', ym))
    const calSnap = await getDocs(calQ)
    const calData: Record<string, { status: string; days: Record<string, string> | null }> = {}
    calSnap.forEach(d => {
      const data = d.data()
      calData[data.siteId] = {
        status: data.status || 'draft',
        days: data.days || null,
      }
    })

    // 本人の署名状態を取得
    const signQ = query(
      collection(db, 'calendarSign'),
      where('ym', '==', ym),
      where('workerId', '==', worker.id),
    )
    const signSnap = await getDocs(signQ)
    const signedSites: Record<string, string> = {}  // siteId → signedAt
    signSnap.forEach(d => {
      const data = d.data()
      signedSites[data.siteId] = data.signedAt || ''
    })

    const sites = sitesWithWorkers.map(sw => {
      const cal = calData[sw.site.id]
      return {
        siteId: sw.site.id,
        siteName: sw.site.name,
        status: (cal?.status || null) as 'approved' | 'draft' | 'submitted' | null,
        days: cal?.days || null,
        signed: !!signedSites[sw.site.id],
        signedAt: signedSites[sw.site.id] || null,
      }
    })

    // 「全現場の翌月カレンダー」が全て approved になっているか
    // archived ではない、かつ getAllSitesWithWorkers が返した現場群が判定対象
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

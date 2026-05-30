/**
 * POST /api/calendar/sign-self
 *
 * Body: { token: string, ym: string ("YYYY-MM"), siteIds?: string[] }
 *
 * トークン認証された外国人スタッフ本人が、自分自身としてカレンダーに
 * 一括サインする（出面入力ページ /attendance/[token] のバナーから起動）。
 *
 * セキュリティ:
 *   - workerId はリクエストボディから受け取らない（トークンから解決）
 *   - calendarSign のドキュメントID: `{workerId}_{ym}_{siteId}`
 *
 * 共通処理は lib/calendar-sign.ts に集約済み。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getWorkerByToken, isStillActiveForMonth } from '@/lib/workers'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { getRequestIpHash, signMultipleSitesForWorker } from '@/lib/calendar-sign'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, ym } = body
    const siteIdsParam: string[] | undefined = body.siteIds

    if (!token || !ym) {
      return NextResponse.json({ error: 'token and ym required' }, { status: 400 })
    }

    // Token → worker
    const worker = await getWorkerByToken(token)
    if (!worker) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // 外国人スタッフ以外は受け付けない
    if (!worker.visaType || worker.visaType === 'none') {
      return NextResponse.json({ error: 'Not applicable for this worker' }, { status: 400 })
    }

    // 退職月チェック + 帰国全期間チェックを並列化
    const [homeLeaves] = await Promise.all([
      getAllActiveHomeLeaves(),
    ])

    if (!isStillActiveForMonth(worker.retired, ym)) {
      return NextResponse.json({ error: 'Worker not active in this month' }, { status: 400 })
    }
    if (isFullMonthHomeLeave(worker.id, normalizeYm(ym), homeLeaves)) {
      return NextResponse.json({ error: 'Sign not required for full-month home leave' }, { status: 400 })
    }

    // siteIds が指定されていなければ「承認済み未署名の全現場」を対象に
    let targetSiteIds: string[]
    if (Array.isArray(siteIdsParam) && siteIdsParam.length > 0) {
      targetSiteIds = siteIdsParam
    } else {
      // 承認済みカレンダー & 既存署名を並列取得
      const [calSnap, signSnap] = await Promise.all([
        getDocs(query(collection(db, 'siteCalendar'),
          where('ym', '==', ym),
          where('status', '==', 'approved'))),
        getDocs(query(collection(db, 'calendarSign'),
          where('ym', '==', ym),
          where('workerId', '==', worker.id))),
      ])
      const approvedSiteIds = calSnap.docs.map(d => d.data().siteId as string)
      const signedSiteIds = new Set(signSnap.docs.map(d => d.data().siteId as string))
      targetSiteIds = approvedSiteIds.filter(id => !signedSiteIds.has(id))
    }

    const ipHash = getRequestIpHash(request.headers)
    const results = await signMultipleSitesForWorker(worker.id, ym, targetSiteIds, ipHash, 'self_tap')

    const signedCount = results.filter(r => r.success).length
    const failedCount = results.filter(r => !r.success).length

    return NextResponse.json({
      success: failedCount === 0,
      signedCount,
      failedCount,
      results,
    })
  } catch (error) {
    console.error('sign-self error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

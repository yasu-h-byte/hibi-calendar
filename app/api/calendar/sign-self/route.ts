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
    // 同意セレモニー: 本人が入力した氏名（なりすまし対策・本人同意の証跡）
    const consentName: string = (body.consentName || '').toString().trim()

    if (!token || !ym) {
      return NextResponse.json({ error: 'token and ym required' }, { status: 400 })
    }
    // 本人による同意の明示を必須化（氏名未入力では承認できない）
    if (consentName.length < 2) {
      return NextResponse.json({ error: 'お名前を入力してください / Vui lòng nhập họ tên' }, { status: 400 })
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

    // siteIds が指定されていなければ「承認済みの全現場」を対象に。
    //   ※ 以前は「未署名の現場」だけに絞っていたが、それだと承認後にカレンダーが修正された現場
    //     （既存署名はあるが古い＝要再確認）が抜け落ち、一括タップで再確認できなかった。
    //   signOneSiteForWorker は冪等（署名がカレンダー最終更新以降なら何もしない／古ければ再署名）
    //   なので、承認済み全現場を渡せば「新規署名＋要再確認」の両方を正しくカバーできる。
    let targetSiteIds: string[]
    if (Array.isArray(siteIdsParam) && siteIdsParam.length > 0) {
      targetSiteIds = siteIdsParam
    } else {
      const calSnap = await getDocs(query(collection(db, 'siteCalendar'),
        where('ym', '==', ym),
        where('status', '==', 'approved')))
      targetSiteIds = calSnap.docs.map(d => d.data().siteId as string)
    }

    const ipHash = getRequestIpHash(request.headers)
    const results = await signMultipleSitesForWorker(worker.id, ym, targetSiteIds, ipHash, 'self_tap', consentName)

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

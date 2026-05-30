/**
 * POST /api/calendar/sign
 *
 * 旧フロー: workerId を直接受け取って署名する（公開ページ /calendar/public 等）
 *
 * セキュリティ注意: 本エンドポイントは workerId をクライアントから受け取るため
 * なりすまし可能。新フロー /api/calendar/sign-self（token 認証）への移行を推奨。
 * 6月までの移行期間中は併存。
 *
 * 共通処理は lib/calendar-sign.ts に集約済み。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getMainData } from '@/lib/compute'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave, normalizeYm } from '@/lib/homeLeave'
import { getRequestIpHash, signMultipleSitesForWorker } from '@/lib/calendar-sign'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { workerId, ym } = body

    // Support both single siteId and bulk siteIds
    const siteIds: string[] = body.siteIds || (body.siteId ? [body.siteId] : [])

    if (!workerId || !ym || siteIds.length === 0) {
      return NextResponse.json({ error: 'workerId, ym, siteId(s) required' }, { status: 400 })
    }

    // workerId の存在確認（なりすまし防止の最低限のチェック）+ 退職者チェック
    // 並列化: main データと帰国情報を同時取得
    const [main, homeLeaves] = await Promise.all([
      getMainData(),
      getAllActiveHomeLeaves(),
    ])

    const worker = main.workers.find(w => w.id === Number(workerId))
    if (!worker || worker.retired) {
      return NextResponse.json({ error: 'Invalid worker' }, { status: 401 })
    }

    // 当該月の全期間が帰国中のスタッフは署名不要
    if (isFullMonthHomeLeave(Number(workerId), normalizeYm(ym), homeLeaves)) {
      return NextResponse.json({ error: 'Sign not required for full-month home leave' }, { status: 400 })
    }

    const ipHash = getRequestIpHash(request.headers)
    const results = await signMultipleSitesForWorker(Number(workerId), ym, siteIds, ipHash, 'tap')

    // For single-site backwards compatibility
    if (siteIds.length === 1) {
      const r = results[0]
      if (!r.success) {
        return NextResponse.json({ error: r.error }, { status: 400 })
      }
      return NextResponse.json({ success: true, signedAt: r.signedAt })
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    console.error('Failed to sign:', error)
    return NextResponse.json({ error: 'Failed to sign' }, { status: 500 })
  }
}

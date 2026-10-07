import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey } from '@/lib/integration'
import { loadIntegrationWorkers } from '@/lib/integration-workers'

/**
 * 経営コックピット向けの在籍スタッフの台帳と、これから6年の給料の見込み（読むだけ）。GET ?months=72
 * 個人の給与を含む。ヘッダ x-integration-key = 環境変数 DEDURA_INTEGRATION_KEY。詳細は docs/integration.md。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // auth: 経営コックピットの合言葉（checkIntegrationKey）
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const months = Number(request.nextUrl.searchParams.get('months') || 72)
  try {
    return NextResponse.json(await loadIntegrationWorkers({ months: Number.isFinite(months) ? months : 72 }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    console.error('[integration/workers] error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey, buildIntegrationMonth } from '@/lib/integration'

/**
 * 経営ダッシュボード向けの月次データ（読むだけ）。GET ?ym=YYYYMM
 * ヘッダ x-integration-key = 環境変数 DEDURA_INTEGRATION_KEY。詳細は docs/integration.md。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ym = request.nextUrl.searchParams.get('ym') || ''
  if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym (YYYYMM) required' }, { status: 400 })
  try {
    return NextResponse.json(await buildIntegrationMonth(ym))
  } catch (e) {
    console.error('[integration/monthly] error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

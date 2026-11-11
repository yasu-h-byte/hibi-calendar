import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey } from '@/lib/integration'
import { loadIntegrationBonuses } from '@/lib/integration-bonus'

/**
 * 経営コックピット向けの、確定した賞与の合計（読むだけ）。GET ?from=YYYY-MM-DD（既定は1年前の今日）
 * 個人ごとの額は返さない（合計だけ）。ヘッダ x-integration-key = 環境変数 DEDURA_INTEGRATION_KEY。詳細は docs/integration.md。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // auth: 経営コックピットの合言葉（checkIntegrationKey）
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const given = request.nextUrl.searchParams.get('from') || ''
  const yearAgo = new Date(Date.now() + 9 * 3_600_000 - 365 * 86_400_000).toISOString().slice(0, 10) // utc-ok（JST に直した日付）
  const from = /^\d{4}-\d{2}-\d{2}$/.test(given) ? given : yearAgo
  try {
    return NextResponse.json(await loadIntegrationBonuses(from), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[integration/bonuses] error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

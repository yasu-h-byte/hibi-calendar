import { NextRequest, NextResponse } from 'next/server'
import { requireCap } from '@/lib/auth'
import { loadSnapshotsForView } from '@/lib/avg-wage.server'
import { buildAvgWageView, type AvgFilter } from '@/lib/avg-wage'

export const dynamic = 'force-dynamic'

/**
 * 平均日給（/wage-average 用・2026-11-14）。
 *
 * 個人の単価から作る数字なので、給与を見られる3人（lib/permissions.ts pay.view）にだけ返す。
 * 返すのは月ごとの平均・人数・最小〜最大と、動いた理由の内訳だけ（1人ずつの単価は返さない）。
 *
 * クエリ: org = all | hibi | hfu ／ monthly = 0（月給の人を外す）
 */
export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'pay.view')
  if (denied) return denied
  const sp = request.nextUrl.searchParams
  const orgQ = sp.get('org')
  const filter: AvgFilter = {
    org: orgQ === 'hibi' || orgQ === 'hfu' ? orgQ : 'all',
    includeMonthly: sp.get('monthly') !== '0',
  }
  try {
    const snaps = await loadSnapshotsForView()
    return NextResponse.json(buildAvgWageView(snaps, filter), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    console.error('[wage-average] 読み込みに失敗:', e)
    return NextResponse.json({ error: '平均日給を読み込めませんでした' }, { status: 500 })
  }
}

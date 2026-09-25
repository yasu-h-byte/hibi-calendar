import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey, setSubconSiteRate } from '@/lib/integration'

/**
 * 経営コックピットから、現場ごとの外注単価を書く（唯一の書き込み窓口）。
 * POST { subconId, siteId, rate, reason? }・ヘッダ x-integration-key。詳細は docs/integration.md。
 */
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json()) as { subconId?: string; siteId?: string; rate?: number; reason?: string }
    const r = await setSubconSiteRate({ subconId: String(body.subconId ?? ''), siteId: String(body.siteId ?? ''), rate: Number(body.rate), reason: body.reason })
    return NextResponse.json(r, { status: r.ok ? 200 : 400 })
  } catch (e) {
    console.error('[integration/subcon-rate] error', e)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getMainData, getMultiMonthAttData, compute } from '@/lib/compute'
import { buildPeerStatements } from '@/lib/peer-statement'

/**
 * 同業者別の請求・支払一覧（2026-09-15）。GET ?ym=YYYYMM
 * 出面の実績から、応援現場の請求見込み（同業者へ）と、応援をもらった分の支払見込み（同業者・外注へ）を返す。
 */
export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ym = request.nextUrl.searchParams.get('ym') || ''
  if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym (YYYYMM) required' }, { status: 400 })
  try {
    const main = await getMainData()
    const att = await getMultiMonthAttData([ym])
    const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
    const c = compute(main, att.d, att.sd, [{ y, m }])
    const statements = buildPeerStatements(main, c, att.d, att.sd, ym)
    return NextResponse.json({ ym, statements })
  } catch (e) {
    console.error('[peer-statement] error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

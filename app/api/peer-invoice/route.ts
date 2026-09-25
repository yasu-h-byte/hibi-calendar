import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, requireExecutiveAuth } from '@/lib/auth'
import { getMainData, getMultiMonthAttData, compute } from '@/lib/compute'
import { buildPeerInvoiceDraft } from '@/lib/peer-invoice'
import {
  listPeerInvoicesForYm, getPeerInvoicesForCompanyYm, issuePeerInvoice, voidPeerInvoice,
} from '@/lib/peer-invoice-store'

/**
 * 応援の請求書（2026-09-25）。
 *
 * GET ?ym=YYYYMM             → その月に発行・取り消しされた請求書の一覧（/peer-statement のバッジ用）
 * GET ?ym=YYYYMM&companyId=X → 会社×月の1件。発行済みがあればそのスナップショット、無ければ下書き
 * POST { action:'issue', ym, companyId }  → 発行（事業責任者・管理者のみ）
 * POST { action:'void', id, reason? }     → 取り消し（事業責任者・管理者のみ）
 */
export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ym = request.nextUrl.searchParams.get('ym') || ''
  if (!/^\d{6}$/.test(ym)) return NextResponse.json({ error: 'ym (YYYYMM) required' }, { status: 400 })
  const companyId = request.nextUrl.searchParams.get('companyId')

  try {
    if (!companyId) {
      const invoices = await listPeerInvoicesForYm(ym)
      return NextResponse.json({ ym, invoices })
    }

    const history = await getPeerInvoicesForCompanyYm(ym, companyId)
    const issued = history.find(inv => inv.status === 'issued')
    if (issued) {
      return NextResponse.json({ status: 'issued', record: issued, history })
    }

    const main = await getMainData()
    const att = await getMultiMonthAttData([ym])
    const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
    const c = compute(main, att.d, att.sd, [{ y, m }])
    const draft = buildPeerInvoiceDraft(main, c, att.d, att.sd, ym, companyId)
    if (!draft) return NextResponse.json({ status: 'empty', history })
    return NextResponse.json({ status: 'draft', draft, issuer: main.companyProfile || null, history })
  } catch (e) {
    console.error('[peer-invoice] GET error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireExecutiveAuth(request)
  if (denied) return denied

  try {
    const body = await request.json()
    const { action } = body
    const auth = await getApiAuthUser(request)
    const actor = auth.authorized ? String(auth.actor) : 'unknown'

    if (action === 'issue') {
      const { ym, companyId } = body
      if (!/^\d{6}$/.test(ym) || !companyId) {
        return NextResponse.json({ error: 'ym と companyId が必要です' }, { status: 400 })
      }
      const main = await getMainData()
      const att = await getMultiMonthAttData([ym])
      const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
      const c = compute(main, att.d, att.sd, [{ y, m }])
      const result = await issuePeerInvoice({ main, c, attD: att.d, attSD: att.sd, ym, companyId, actor })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ success: true, record: result.record })
    }

    if (action === 'void') {
      const { id, reason } = body
      if (!id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
      const result = await voidPeerInvoice({ id, actor, reason })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ success: true, record: result.record })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (e) {
    console.error('[peer-invoice] POST error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

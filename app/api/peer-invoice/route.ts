import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, getApiRole, requireExecutiveAuth } from '@/lib/auth'
import { getMainData, getMultiMonthAttData, compute } from '@/lib/compute'
import {
  resolveInvoiceDraft, requestPeerInvoice, approvePeerInvoice, rejectPeerInvoice, listPeerInvoicesForYm, getPeerInvoicesForCompanyYm, issuePeerInvoice, voidPeerInvoice,
} from '@/lib/peer-invoice-store'

/**
 * 応援の請求書（2026-09-25）。
 *
 * GET ?ym=YYYYMM             → その月に発行・取り消しされた請求書の一覧（/peer-statement のバッジ用）
 * GET ?ym=YYYYMM&companyId=X → 会社×月の1件。発行済みがあればそのスナップショット、無ければ下書き
 *   companyId が HFU_INVOICE_COMPANY_ID（lib/hfu-invoice.ts）なら HFU → 日比建設 の請求書
 * POST { action:'request', ym, companyId } → 発行を申請（事務。内容を凍結・番号はまだ）
 * POST { action:'withdraw', id }           → 申請の取り下げ（事務・事業責任者・管理者）
 * POST { action:'approve', id }            → 申請を承認して発行（事業責任者・管理者のみ）
 * POST { action:'reject', id, reason? }    → 申請の差し戻し（事業責任者・管理者のみ）
 * POST { action:'issue', ym, companyId }   → 直接発行（事業責任者・管理者のみ）
 * POST { action:'void', id, reason? }      → 発行済みの取り消し（事業責任者・管理者のみ）
 * 承認フロー: 事務（森田さん）が作って申請 → 政仁さんが承認（2026-09-26 代表指示）
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
    // 申請中は凍結した内容を表示する（承認者が見る内容 = 発行される内容）
    const pending = history.find(inv => inv.status === 'pending')
    if (pending) {
      return NextResponse.json({ status: 'pending', record: pending, history })
    }

    const main = await getMainData()
    const att = await getMultiMonthAttData([ym])
    const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
    const c = compute(main, att.d, att.sd, [{ y, m }])
    const { draft, issuer } = resolveInvoiceDraft({ main, c, attD: att.d, attSD: att.sd, ym, companyId })
    if (!draft) return NextResponse.json({ status: 'empty', history })
    return NextResponse.json({ status: 'draft', draft, issuer, history })
  } catch (e) {
    console.error('[peer-invoice] GET error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await request.json()
    const { action } = body
    const auth = await getApiAuthUser(request)
    const actor = auth.authorized ? String(auth.actor) : 'unknown'

    // 申請・取り下げは事務（jimu）も可。それ以外は事業責任者・管理者のみ
    if (action === 'request' || action === 'withdraw') {
      const denied = await requireExecutiveAuth(request)
      if (denied) {
        const role = await getApiRole(request)
        if (role?.role !== 'jimu') {
          return NextResponse.json({ error: 'この操作は事務・管理者・事業責任者のみ実行できます' }, { status: 403 })
        }
      }
    } else {
      const denied = await requireExecutiveAuth(request)
      if (denied) return denied
    }

    if (action === 'issue' || action === 'request') {
      const { ym, companyId } = body
      if (!/^\d{6}$/.test(ym) || !companyId) {
        return NextResponse.json({ error: 'ym と companyId が必要です' }, { status: 400 })
      }
      const main = await getMainData()
      const att = await getMultiMonthAttData([ym])
      const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10)
      const c = compute(main, att.d, att.sd, [{ y, m }])
      const args = { main, c, attD: att.d, attSD: att.sd, ym, companyId, actor }
      const result = action === 'issue' ? await issuePeerInvoice(args) : await requestPeerInvoice(args)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ success: true, record: result.record })
    }

    if (action === 'approve') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
      const main = await getMainData()
      const result = await approvePeerInvoice({ main, id, actor })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ success: true, record: result.record })
    }

    if (action === 'reject' || action === 'withdraw') {
      const { id, reason } = body
      if (!id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
      const result = await rejectPeerInvoice({ id, actor, reason, withdraw: action === 'withdraw' })
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

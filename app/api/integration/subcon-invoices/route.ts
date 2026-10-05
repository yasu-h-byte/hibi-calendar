import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey } from '@/lib/integration'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, where } from '@/lib/fsdb'
import { signedReadUrl, getStaffDocsBucket } from '@/lib/storage-admin'
import type { SubconInvoice } from '@/lib/subcon-invoice'
import type { PaperInvoice } from '@/lib/paper-invoice'

/**
 * 経営コックピット向け: 受け取った外注の請求書（読むだけ・2026-10-05）。GET ?from=YYYYMM
 * ヘッダ x-integration-key = 環境変数 DEDURA_INTEGRATION_KEY。詳細は docs/integration.md。
 *
 * from の月以降の記録と、1つ目のファイル（請求書の本体）を取り出すための署名つきURL（15分）を返す。
 * 経営コックピットは毎朝これを読み、まだ取り込んでいない請求書のファイルを自分の置き場に写して AI で読む。
 * 2つ目以降のファイル（添付）は返さない（AI が請求書として読むと二重になるため）。
 *
 * kind: received = 外注から届いた請求書 / remittance = 一次から届いた支払内訳書 /
 *       issued = 一次（山岡建設工業など）へ出した請求書（紙の請求書の控え paperInvoices のうち現場を選んだもの・2026-10-05）
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // auth: 経営コックピットの合言葉（checkIntegrationKey）
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const from = request.nextUrl.searchParams.get('from') || ''
  if (!/^\d{6}$/.test(from)) return NextResponse.json({ error: 'from (YYYYMM) required' }, { status: 400 })
  try {
    const snap = await getDocs(query(collection(db, 'subconInvoices'), where('ym', '>=', from)))
    const records: (SubconInvoice & { kind: 'received' | 'remittance' | 'issued'; siteName?: string | null; trade?: string | null })[] = []
    snap.forEach(d => {
      const r = { ...(d.data() as unknown as SubconInvoice), id: d.id }
      records.push({ ...r, kind: r.docType === 'remittance' ? 'remittance' : 'received' })
    })
    // 一次へ出した請求書（応援の請求書の控えは経営コックピットでは使わないので、現場を選んだ一次の分だけ）
    const paperSnap = await getDocs(query(collection(db, 'paperInvoices'), where('ym', '>=', from)))
    paperSnap.forEach(d => {
      const p = { ...(d.data() as unknown as PaperInvoice), id: d.id }
      if (!p.siteId) return
      records.push({
        id: p.id, kind: 'issued', companyId: p.companyId, companyName: p.companyName, ym: p.ym, total: p.total,
        subtotal: p.subtotal, tax: p.tax, no: p.no, issueDate: p.issueDate, dueDate: null,
        note: [p.siteName, p.trade, p.note].filter(Boolean).join('・') || null,
        files: p.files, uploadedAt: p.uploadedAt, uploadedBy: p.uploadedBy, uploadedByName: p.uploadedByName, updatedAt: p.updatedAt,
        siteName: p.siteName, trade: p.trade,
      })
    })
    const storage = !!getStaffDocsBucket()
    const invoices = await Promise.all(records.map(async r => {
      const f = r.files?.[0]
      return {
        id: r.id,
        kind: r.kind,
        siteName: r.siteName ?? null,
        trade: r.trade ?? null,
        companyId: r.companyId,
        companyName: r.companyName,
        ym: r.ym,
        total: r.total,
        subtotal: r.subtotal ?? null,
        tax: r.tax ?? null,
        no: r.no ?? null,
        issueDate: r.issueDate ?? null,
        dueDate: r.dueDate ?? null,
        note: r.note ?? null,
        uploadedAt: r.uploadedAt,
        uploadedByName: r.uploadedByName || '',
        updatedAt: r.updatedAt || r.uploadedAt,
        attachments: Math.max(0, (r.files?.length || 0) - 1),
        file: f ? { name: f.name, contentType: f.contentType, size: f.size, url: storage ? await signedReadUrl(f.path, f.name) : null } : null,
      }
    }))
    invoices.sort((a, b) => a.ym.localeCompare(b.ym) || a.uploadedAt.localeCompare(b.uploadedAt))
    return NextResponse.json({ generatedAt: new Date().toISOString(), invoices })
  } catch (e) {
    console.error('[integration/subcon-invoices] error', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { checkIntegrationKey } from '@/lib/integration'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, where } from '@/lib/fsdb'
import { signedReadUrl, getStaffDocsBucket } from '@/lib/storage-admin'
import type { SubconInvoice } from '@/lib/subcon-invoice'
import type { PaperInvoice } from '@/lib/paper-invoice'
import type { PrimeInvoiceBundle } from '@/lib/prime-invoice'

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
 *       issued（source: 'system'）= DEDURA＋ で大林組の控えから作って発行した一次への請求書（primeInvoices・発行済みだけ・2026-10-20）。
 *         工種ごとに1件。file は無し（印刷は DEDURA＋ の画面）。prime に 85%の元の額・控除の合計（給与の内訳は渡さない）
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // auth: 経営コックピットの合言葉（checkIntegrationKey）
  if (!checkIntegrationKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const from = request.nextUrl.searchParams.get('from') || ''
  if (!/^\d{6}$/.test(from)) return NextResponse.json({ error: 'from (YYYYMM) required' }, { status: 400 })
  try {
    const snap = await getDocs(query(collection(db, 'subconInvoices'), where('ym', '>=', from)))
    type Prime = { source: 'system'; gcAmount: number; deductions: number; ratio: number; bundleNo: string; siteId: string }
    const records: (SubconInvoice & { kind: 'received' | 'remittance' | 'issued'; siteName?: string | null; trade?: string | null; prime?: Prime })[] = []
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
    // DEDURA＋ で作って発行した一次への請求書（2026-10-20）。工種ごとに1件。給与の内訳は渡さない（控除の合計だけ）
    const primeSnap = await getDocs(query(collection(db, 'primeInvoices'), where('ym', '>=', from)))
    primeSnap.forEach(d => {
      const b = { ...(d.data() as unknown as PrimeInvoiceBundle), id: d.id }
      if (b.status !== 'issued') return
      b.sheets.forEach((s, i) => {
        const deductions = s.borrowed.reduce((t, x) => t + x.amount, 0) + s.wageDeductions.reduce((t, x) => t + x.amount, 0)
        records.push({
          id: `${b.id}_${i}`, kind: 'issued', companyId: b.companyId, companyName: b.companyName, ym: b.ym, total: s.total,
          subtotal: s.amount, tax: s.tax, no: b.no ? `${b.no}-${i + 1}` : null, issueDate: b.issueDate || null, dueDate: null,
          note: [b.siteName, s.tradeName].filter(Boolean).join('・') || null,
          files: [], uploadedAt: b.issuedAt || b.createdAt, uploadedBy: b.issuedBy || b.createdBy, uploadedByName: b.createdByName, updatedAt: b.updatedAt,
          siteName: b.siteName, trade: s.tradeName,
          prime: { source: 'system', gcAmount: s.gcAmount, deductions, ratio: b.ratio, bundleNo: b.no, siteId: b.siteId },
        })
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
        prime: r.prime ?? null,
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

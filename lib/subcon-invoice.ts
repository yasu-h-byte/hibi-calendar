/**
 * 受け取った外注の請求書の保管と、出面 × 単価との見比べ（2026-10-05・代表指示）。
 *
 * ## 背景
 * 外注・同業者から紙で届く請求書を、DEDURA＋ に入れて共有する（今は代表、数か月後から森田さん）。
 * 出した請求書（紙の控え・lib/paper-invoice.ts）と同じ「請求・支払」の中に置き、出面・単価・取引先がある DEDURA＋ で
 * 「出面 × 単価」とすぐ見比べられるようにする。
 * 経営コックピットは連携の窓口（/api/integration/subcon-invoices）からこれを毎朝読み、AI で明細を読む・帳簿と照合する・
 * 13週資金繰りの支払に入れる・確定する（経営コックピット docs/specs/27-dedura.md）。
 *
 * ## 入れるもの
 * - ファイル（PDF・写真）… 必須。**1つ目が請求書の本体**（経営コックピットの AI が読むのはこれだけ）。2つ目以降は添付（出面の明細など）
 *   Firebase Storage `subcon-invoices/{docId}/{i}-{name}`（書類庫と同じバケット・署名つきURLでブラウザから直接 PUT）
 *   HEIC は経営コックピットの AI が読めないので入れない（iPhone の写真は「写真を選ぶ」なら JPEG で届く）
 * - 外注先・対象月・税込合計 … 必須
 * - 税抜小計・消費税・請求書番号・発行日・支払期日・メモ … 任意
 * 記録は独立コレクション `subconInvoices`（1件 = 受け取った請求書1枚）。
 *
 * ## 支払内訳書（2026-10-05）
 * 山岡建設工業など一次から届く支払内訳書（支払通知書・支払明細）も、種類 docType: 'remittance' でここに入れる（入口を DEDURA＋ に1本化）。
 * 請求元は一次の会社、税込合計の代わりに振込額（任意・total は 0 のことがある）。出面との見比べ・「まだ届いていない」には入れない。
 * 何か月分載っていても1件で入れる（経営コックピットの AI が月ごとに読み、帳簿の入金と照らす）。
 *
 * ## 見比べ
 * 同じ外注先・同じ月の「出面 × 単価」（compute の subcons・税抜）と、請求書の税抜（無ければ税込 ÷ 1.1）を比べる。
 * 1万円以内か3%以内は「ほぼ一致」（残業・交通費・端数の範囲。経営コックピットの照合と同じ目安）。
 * 同じ外注先に2枚以上ある月は合算で見比べる。
 */

export interface SubconInvoiceFile {
  path: string
  name: string
  contentType: string
  size: number
}

/** invoice = 外注・同業者から届いた請求書 / remittance = 一次から届いた支払内訳書 */
export type SubconDocType = 'invoice' | 'remittance'

export interface SubconInvoice {
  id: string
  /** 無い記録（2026-10-05 の最初の版）は invoice */
  docType?: SubconDocType
  companyId: string     // 取引先マスタの id
  companyName: string
  ym: string            // 対象月（締めの月） YYYYMM
  total: number         // 税込合計（支払内訳書は振込額・入れなければ 0）
  // 任意項目は「修正で空にした」とき Firestore に null が入る
  subtotal?: number | null
  tax?: number | null
  no?: string | null
  issueDate?: string | null   // 発行日 YYYY-MM-DD
  dueDate?: string | null     // 支払期日 YYYY-MM-DD
  note?: string | null
  files: SubconInvoiceFile[]
  uploadedAt: string
  uploadedBy: string
  /** 入れた人の名前（画面と経営コックピットに出す） */
  uploadedByName?: string
  updatedAt?: string
}

/** 見比べに使う出面側の数字（税抜） */
export interface SubconExpected {
  workDays: number
  otCount: number
  cost: number
  sites: { siteId: string; siteName: string; workDays: number; otCount: number; cost: number; rate: number; otRate: number }[]
}

export type SubconMatch = 'match' | 'close' | 'diff' | 'noWork'

export interface SubconComparison {
  /** 請求書の税抜（入れてなければ税込 ÷ 1.1 の推定） */
  invoiceExTax: number
  exTaxEstimated: boolean
  expected: number
  /** 請求書 − 出面 × 単価 */
  diff: number
  result: SubconMatch
}

// ── アップロードの制限（書類庫と同じ大きさ。HEIC は入れない）──
export const SUBCON_INVOICE_MAX_FILE_BYTES = 20 * 1024 * 1024   // 経営コックピットの取り込みの上限（20MB）に合わせる
export const SUBCON_INVOICE_MAX_FILES = 10
export const SUBCON_INVOICE_ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
/** 「ほぼ一致」の目安（経営コックピットの外注の照合と同じ: 1万円以内か3%以内） */
export const SUBCON_CLOSE_YEN = 10_000
export const SUBCON_CLOSE_RATE = 0.03

export const SUBCON_INVOICE_DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const docTypeOf = (r: Pick<SubconInvoice, 'docType'>): SubconDocType => (r.docType === 'remittance' ? 'remittance' : 'invoice')

/** 請求書の税抜（入っていれば税抜小計、無ければ税込 ÷ 1.1 を四捨五入） */
export function invoiceExTax(inv: Pick<SubconInvoice, 'subtotal' | 'total'>): { value: number; estimated: boolean } {
  if (typeof inv.subtotal === 'number') return { value: inv.subtotal, estimated: false }
  return { value: Math.round(inv.total / 1.1), estimated: true }
}

/** 請求書（同じ外注先・同じ月の1枚以上）と出面 × 単価を見比べる（純粋） */
export function compareSubconInvoice(invoices: Pick<SubconInvoice, 'subtotal' | 'total'>[], expected: Pick<SubconExpected, 'cost'> | null | undefined): SubconComparison {
  const parts = invoices.map(invoiceExTax)
  const ex = parts.reduce((s, p) => s + p.value, 0)
  const exp = Math.round(expected?.cost || 0)
  const diff = ex - exp
  let result: SubconMatch
  if (exp <= 0) result = 'noWork'
  else if (diff === 0) result = 'match'
  else if (Math.abs(diff) <= SUBCON_CLOSE_YEN || Math.abs(diff) <= exp * SUBCON_CLOSE_RATE) result = 'close'
  else result = 'diff'
  return { invoiceExTax: ex, exTaxEstimated: parts.some(p => p.estimated), expected: exp, diff, result }
}

/**
 * 「税抜小計＋消費税＝税込合計」の確認（純粋）。小計と消費税の両方が入っているときだけ見る。
 */
export function subconTotalsError(f: { subtotal?: number | null; tax?: number | null; total: number }): string | null {
  if (typeof f.subtotal !== 'number' || typeof f.tax !== 'number') return null
  if (f.subtotal + f.tax === f.total) return null
  return `税抜小計 ${f.subtotal.toLocaleString()} ＋ 消費税 ${f.tax.toLocaleString()} ＝ ${(f.subtotal + f.tax).toLocaleString()} で、税込合計 ${f.total.toLocaleString()} と合いません`
}

/** 出面で人工がある外注先のうち、その月の請求書がまだ入っていないもの（純粋） */
export function missingSubconInvoices(
  expectedByCompany: Record<string, SubconExpected>,
  records: Pick<SubconInvoice, 'companyId'>[],
  names: Record<string, string>,
): { companyId: string; companyName: string; workDays: number; cost: number }[] {
  const have = new Set(records.map(r => r.companyId))
  return Object.entries(expectedByCompany)
    .filter(([id, e]) => !have.has(id) && e.cost > 0)
    .map(([id, e]) => ({ companyId: id, companyName: names[id] || id, workDays: e.workDays, cost: e.cost }))
    .sort((a, b) => b.cost - a.cost)
}

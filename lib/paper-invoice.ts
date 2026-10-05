/**
 * 紙（手作り）で出した請求書の保管と、システムの請求書との見比べ（2026-10-02・代表指示）。
 *
 * ## 背景
 * 同業者（畠山組・吉本建設工業など）への応援の請求書は、しばらく今まで通り手作りで発行する。
 * システムの請求書（lib/peer-invoice.ts）が出されていなくてもエラーではない。
 * 手作りの請求書を何回分かここに入れてもらい、システムの計算と合っているかを確かめ、
 * 手作りと同じルールでシステムから出せるようにしていく（差が出たら計算ルールを直す材料にする）。
 *
 * ## 入れるもの
 * - ファイル（PDF・写真）… 必須。Firebase Storage `paper-invoices/{docId}/{i}-{name}`（書類庫と同じバケット・
 *   署名つきURLでブラウザから直接 PUT。lib/storage-admin.ts）
 * - 会社・対象月・税込合計 … 必須
 * - 請求書番号・発行日・税抜小計・消費税・明細（現場・内容・数量・単位・単価・金額）… 任意（入れるほど細かく見比べられる）
 * 記録は独立コレクション `paperInvoices`（1件 = 手作りの請求書1枚）。
 *
 * ## 一次（山岡建設工業など）へ出した請求書（2026-10-05）
 * 一次への請求書も紙の控えとしてここに入れる（入口を DEDURA＋ に1本化・代表 2026-10-05）。現場（siteId）は必須、工種は任意。
 * 見比べは「同じ現場・同じ月の全部の合計 vs 原価・収益で入れた現場の請求額」（comparePrimeSheets）。応援の請求書の一覧（請求・支払）には出さない。
 *
 * ## 見比べ
 * 同じ会社・同じ月について、システムが作る請求書の下書き（resolveInvoiceDraft・発行済みならその凍結内容）と
 * 税抜小計・消費税・税込合計・人工の合計・残業時間の合計を並べ、差を出す（comparePaperWithSystem）。
 */
import type { PeerInvoiceLine } from './peer-invoice'

export interface PaperInvoiceFile {
  path: string
  name: string
  contentType: string
  size: number
}

/** 手作りの請求書の明細1行（書いてあるとおりに入れる） */
export interface PaperInvoiceLine {
  site: string      // 現場名（請求書の表記のまま）
  item: string      // 内容（鳶・土工・鳶 残業 など）
  qty: number       // 数量
  unit: string      // 単位（人工・h・式 など）
  rate: number      // 単価（税抜）
  amount: number    // 金額（税抜）
}

export interface PaperInvoice {
  id: string
  companyId: string     // 取引先マスタの id（HFU → 日比建設 は HFU_INVOICE_COMPANY_ID）
  companyName: string
  ym: string            // 対象月 YYYYMM
  // 任意項目は「修正で空にした」とき Firestore に null が入る（app/api/paper-invoice の update）
  no?: string | null           // 請求書番号
  issueDate?: string | null    // 発行日 YYYY-MM-DD
  subtotal?: number | null     // 税抜小計
  tax?: number | null          // 消費税
  total: number                // 税込合計
  lines?: PaperInvoiceLine[] | null
  note?: string | null
  files: PaperInvoiceFile[]
  uploadedAt: string
  uploadedBy: string
  updatedAt?: string
  /**
   * 一次（山岡建設工業など）へ出した請求書のとき（2026-10-05）: どの現場の分か（工種サイトでなく親の現場）と工種の書き添え。
   * 一次への請求書は工種ごとに1つの現場で5〜6枚になることがあるので、同じ現場・同じ月の全部の合計を
   * DEDURA＋ の現場の請求額（原価・収益で入れたもの・工種サイトの分も足す）と比べる（comparePrimeSheets）
   */
  siteId?: string | null
  siteName?: string | null
  trade?: string | null
  /** 入れた人の名前（経営コックピットに出す） */
  uploadedByName?: string
}

/** 一次への請求書（同じ現場・同じ月の全部）と DEDURA＋ の現場の請求額の見比べ */
export interface PrimeSiteComparison {
  siteId: string
  siteName: string
  /** 請求書の枚数 */
  count: number
  /** 請求書の税抜の合計（税抜小計が無い枚は 税込 ÷ 1.1） */
  invoiceExTax: number
  exTaxEstimated: boolean
  /** DEDURA＋ の現場の請求額（税抜・0 = 未入力） */
  billing: number
  /** 請求書 − 請求額 */
  diff: number
  /** match = 1円も違わない / close = 1,000円以内（端数・税の丸め） / diff = それ以上 / noBilling = 請求額が未入力 */
  result: 'match' | 'close' | 'diff' | 'noBilling'
}

/** 一次への請求書を現場ごとに足して、DEDURA＋ の請求額と比べる（純粋） */
export function comparePrimeSheets(
  sheets: Pick<PaperInvoice, 'subtotal' | 'total'>[], billing: number, site: { siteId: string; siteName: string },
): PrimeSiteComparison {
  let est = false
  const ex = sheets.reduce((s, p) => {
    if (typeof p.subtotal === 'number') return s + p.subtotal
    est = true
    return s + Math.round(p.total / 1.1)
  }, 0)
  const b = Math.round(billing)
  const diff = ex - b
  const result: PrimeSiteComparison['result'] = b <= 0 ? 'noBilling' : diff === 0 ? 'match' : Math.abs(diff) <= 1_000 ? 'close' : 'diff'
  return { ...site, count: sheets.length, invoiceExTax: ex, exTaxEstimated: est, billing: b, diff, result }
}

/** 見比べに使うシステム側の数字（下書き or 発行済みの凍結内容） */
export interface SystemInvoiceFigures {
  source: 'issued' | 'pending' | 'draft' | 'none'
  no?: string
  subtotal: number
  tax: number
  total: number
  lines: PeerInvoiceLine[]
}

export interface PaperComparison {
  /** システム側に請求が無い（下書きが作れない）月 */
  systemMissing: boolean
  subtotalDiff: number | null   // 紙 − システム（紙の小計が無ければ null）
  taxDiff: number | null
  totalDiff: number
  /** 人工・残業時間の合計（紙は明細があるときだけ） */
  paperDays: number | null
  systemDays: number
  paperOtHours: number | null
  systemOtHours: number
  /** 税込合計が1円も違わない */
  match: boolean
}

// ── アップロードの制限（書類庫と同じ）──
export const PAPER_INVOICE_MAX_FILE_BYTES = 25 * 1024 * 1024
export const PAPER_INVOICE_MAX_FILES = 10
export const PAPER_INVOICE_MAX_LINES = 50
export const PAPER_INVOICE_ALLOWED_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]

const round2 = (v: number) => Math.round(v * 100) / 100

/** 単位が時間（残業）か。「h」「時間」「H」 */
export const isHourUnit = (unit: string) => /^(h|時間|ｈ)$/i.test((unit || '').trim())
/** 単位が人工か。「人工」「人」「工」 */
export const isManDayUnit = (unit: string) => /^(人工|人|工)$/.test((unit || '').trim())

/**
 * 紙の請求書とシステムの数字を見比べる（純粋計算）。
 * 人工の合計: 紙は単位が「人工」の行の数量、システムは unit の無い行（人工）の days。
 * 残業時間の合計: 紙は単位が「h・時間」の行、システムは unit 'h' の行（HFU → 日比建設 の残業の行）。
 * 応援の請求書は残業を人工に換算して含めるので、システム側の残業時間は 0 になる（人工の差として出る）。
 */
export function comparePaperWithSystem(paper: Pick<PaperInvoice, 'subtotal' | 'tax' | 'total' | 'lines'>, sys: SystemInvoiceFigures): PaperComparison {
  const lines = paper.lines || []
  const hasLines = lines.length > 0
  const paperDays = hasLines ? round2(lines.filter(l => isManDayUnit(l.unit)).reduce((s, l) => s + (l.qty || 0), 0)) : null
  const paperOtHours = hasLines ? round2(lines.filter(l => isHourUnit(l.unit)).reduce((s, l) => s + (l.qty || 0), 0)) : null
  const systemDays = round2(sys.lines.filter(l => l.unit !== 'h').reduce((s, l) => s + l.days, 0))
  const systemOtHours = round2(sys.lines.filter(l => l.unit === 'h').reduce((s, l) => s + l.days, 0))
  const totalDiff = paper.total - sys.total
  return {
    systemMissing: sys.source === 'none',
    subtotalDiff: typeof paper.subtotal === 'number' ? paper.subtotal - sys.subtotal : null,
    taxDiff: typeof paper.tax === 'number' ? paper.tax - sys.tax : null,
    totalDiff,
    paperDays,
    systemDays,
    paperOtHours,
    systemOtHours,
    match: sys.source !== 'none' && totalDiff === 0,
  }
}

/**
 * 請求書に書いてある数字を読む（純粋）。全角数字・全角カンマ・全角マイナス・「¥」「円」・空白を許す。
 * 先に NFKC で半角にそろえてから記号を外す（「３００，０００円」→ 300000）。
 * 空欄は 0（呼び出し側で「空欄かどうか」は isBlankNumberInput で別に見る）。読めなければ NaN。
 */
export function parsePaperNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  const s = String(v ?? '').normalize('NFKC').replace(/[,¥￥円\s]/g, '').replace(/[−‐–—]/g, '-')
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}
/** 数字の欄が空欄か（空白だけも空欄） */
export const isBlankNumberInput = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.normalize('NFKC').trim() === '')

/**
 * 明細の入力を整える（純粋）。不正なら error。
 * 空行として捨てるのは「現場・内容が空 かつ 数量・単価・金額がすべて空欄」の行だけ。
 * 数字の欄に何か書いてあって読めないときは捨てずにエラーにする（黙って消えると見比べが狂う）。
 */
export function sanitizePaperLines(raw: unknown): { ok: true; lines: PaperInvoiceLine[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, lines: [] }
  if (!Array.isArray(raw)) return { ok: false, error: '明細の形式が不正です' }
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const out: PaperInvoiceLine[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const line = {
      site: text(r.site, 80), item: text(r.item, 40), unit: text(r.unit, 10),
      qty: parsePaperNumber(r.qty), rate: parsePaperNumber(r.rate), amount: parsePaperNumber(r.amount),
    }
    const empty = !line.site && !line.item && isBlankNumberInput(r.qty) && isBlankNumberInput(r.rate) && isBlankNumberInput(r.amount)
    if (empty) continue
    if ([line.qty, line.rate, line.amount].some(n => Number.isNaN(n))) {
      return { ok: false, error: `明細の数字が読めません（${line.site || line.item || '行'}）` }
    }
    out.push(line)
  }
  if (out.length > PAPER_INVOICE_MAX_LINES) return { ok: false, error: `明細は${PAPER_INVOICE_MAX_LINES}行までです` }
  return { ok: true, lines: out }
}

/** その会社・その月に入れた紙の請求書の件数と税込合計（純粋） */
export function paperSummaryFor(records: Pick<PaperInvoice, 'companyId' | 'ym' | 'total'>[], ym: string, companyId: string): { count: number; total: number } {
  const xs = records.filter(r => r.ym === ym && r.companyId === companyId)
  return { count: xs.length, total: xs.reduce((s, r) => s + (r.total || 0), 0) }
}

/**
 * 二重請求の防止（純粋）。同じ会社・同じ月に紙の請求書を入れてあれば、システムからの申請・発行を止める文言を返す。
 * 紙で出した月をシステムからも出すと、相手に同じ月の請求書が2枚届く（2026-10-02 レビュー指摘）。
 */
export function paperDoubleBillingError(records: Pick<PaperInvoice, 'companyId' | 'ym' | 'total'>[], ym: string, companyId: string): string | null {
  const { count } = paperSummaryFor(records, ym, companyId)
  if (count === 0) return null
  return `この会社の${parseInt(ym.slice(4, 6), 10)}月分は紙の請求書を登録済みです。二重請求になるので、システムからは発行できません（紙の請求書を削除してから）`
}

/**
 * 「税抜小計＋消費税＝税込合計」の確認（純粋・2026-10-02 総合点検）。
 * 小計と消費税の両方が入っているときだけ見る（片方だけなら見比べの材料として受け入れる）。
 * 打ち間違いを黙って保存すると見比べが狂うので、合わないときは理由を返す。
 */
export function paperTotalsError(f: { subtotal?: number | null; tax?: number | null; total: number }): string | null {
  if (typeof f.subtotal !== 'number' || typeof f.tax !== 'number') return null
  if (f.subtotal + f.tax === f.total) return null
  return `税抜小計 ${f.subtotal.toLocaleString()} ＋ 消費税 ${f.tax.toLocaleString()} ＝ ${(f.subtotal + f.tax).toLocaleString()} で、税込合計 ${f.total.toLocaleString()} と合いません`
}

/**
 * 逆方向の二重請求の防止（純粋・2026-10-02 総合点検）。
 * システムで発行済み・承認待ちの会社・月に紙の請求書を入れると、相手に同じ月の請求書が2枚届く
 * （旧: システム側からの発行だけ止めていて、紙の側は確認が無かった）。
 */
export function systemDoubleBillingError(
  records: { companyId: string; ym: string; status: string; no?: string }[], ym: string, companyId: string,
): string | null {
  const hit = records.filter(r => r.ym === ym && r.companyId === companyId && (r.status === 'issued' || r.status === 'pending'))
  if (hit.length === 0) return null
  const issued = hit.find(r => r.status === 'issued')
  const m = parseInt(ym.slice(4, 6), 10)
  return issued
    ? `この会社の${m}月分はシステムで発行済み（${issued.no || '番号なし'}）です。二重請求になるので紙の請求書は入れられません（システムの請求書を取り消してから）`
    : `この会社の${m}月分はシステムで承認待ちの申請があります。先に差し戻し・取り下げをしてから入れてください`
}

/**
 * 同じ会社・同じ月の紙の請求書をまとめて1枚とみなす（純粋・2026-10-02 総合点検）。
 * 現場別・工種別に2枚出した月は、1枚ずつをシステムの月合計と比べると必ず「差あり」になるので、合算でも見比べる。
 * - 小計・消費税は全部に入っているときだけ合算（1枚でも空なら null）
 * - 明細は全部に入っているときだけつなぐ（1枚でも無ければ無し＝人工の見比べは出さない）
 */
export function mergePaperInvoices(papers: Pick<PaperInvoice, 'subtotal' | 'tax' | 'total' | 'lines'>[]): Pick<PaperInvoice, 'subtotal' | 'tax' | 'total' | 'lines'> {
  const allNum = (k: 'subtotal' | 'tax') => papers.every(p => typeof p[k] === 'number')
  const allLines = papers.every(p => Array.isArray(p.lines) && p.lines.length > 0)
  return {
    subtotal: allNum('subtotal') ? papers.reduce((s, p) => s + (p.subtotal as number), 0) : null,
    tax: allNum('tax') ? papers.reduce((s, p) => s + (p.tax as number), 0) : null,
    total: papers.reduce((s, p) => s + (p.total || 0), 0),
    lines: allLines ? papers.flatMap(p => p.lines as PaperInvoiceLine[]) : null,
  }
}

/** 紙の請求書のドキュメント id（prepare で randomUUID() が作る形） */
export const PAPER_INVOICE_DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

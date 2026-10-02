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
  no?: string           // 請求書番号
  issueDate?: string    // 発行日 YYYY-MM-DD
  subtotal?: number     // 税抜小計
  tax?: number          // 消費税
  total: number         // 税込合計
  lines?: PaperInvoiceLine[]
  note?: string
  files: PaperInvoiceFile[]
  uploadedAt: string
  uploadedBy: string
  updatedAt?: string
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

/** 明細の入力を整える（空行は捨てる・数値でないものは 0）。不正なら error */
export function sanitizePaperLines(raw: unknown): { ok: true; lines: PaperInvoiceLine[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, lines: [] }
  if (!Array.isArray(raw)) return { ok: false, error: '明細の形式が不正です' }
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,，¥円\s]/g, ''))
    return Number.isFinite(n) ? n : NaN
  }
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const out: PaperInvoiceLine[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const line = {
      site: text(r.site, 80), item: text(r.item, 40), unit: text(r.unit, 10),
      qty: num(r.qty), rate: num(r.rate), amount: num(r.amount),
    }
    const empty = !line.site && !line.item && !(line.amount) && !(line.qty)
    if (empty) continue
    if ([line.qty, line.rate, line.amount].some(n => Number.isNaN(n))) {
      return { ok: false, error: `明細の数字が読めません（${line.site || line.item || '行'}）` }
    }
    out.push(line)
  }
  if (out.length > PAPER_INVOICE_MAX_LINES) return { ok: false, error: `明細は${PAPER_INVOICE_MAX_LINES}行までです` }
  return { ok: true, lines: out }
}

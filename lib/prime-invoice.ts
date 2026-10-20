/**
 * 一次（山岡建設工業など）への請求書（2026-10-20・代表指示）。
 *
 * ## 背景
 * 自社現場（笹塚・IHI など。山岡から直接受けている現場）の請求は、毎月「山岡 → 大林組 の請求書（控え）」が
 * 工種ごとに5枚前後届き、その「今回請求金額計」の85%を日比建設が山岡へ請求する。
 * 借受職人の調整があるときは、山岡の「所属元の異なる借受職人給与の控除」のメモ（控除計算書）が付き、
 *   - 他社から借りた職人の人工分を、85%を掛ける前に差し引く
 *   - 山岡が直接払っている日比の人の給与（出向者）を、85%を掛けた後に差し引く
 * これを事務が手で写して請求書を作っていたので、金額の写し間違い（2026-09 分は100%のまま出していた）が起きた。
 * 控えとメモの PDF を入れると、読み取り → 計算 → 山岡の請求書フォーマットで印刷、までを自動にする。
 *
 * ## 計算（1枚＝大林組の控え1枚＝工種1つ）
 *   base        = 今回請求金額計（税抜） − Σ他社借受の人工分
 *   ratioAmount = floor(base × 85%)
 *   amount      = ratioAmount − Σ山岡が払った給与（控除）
 *   tax         = floor(amount × 10%)、total = amount + tax
 * 月の請求書は「一次会社 × 現場 × 対象月」で1つ（bundle）。中に工種ごとの sheets[] を持つ。
 *
 * ## 人工の期間
 * 山岡が大林組へ出す人工は 前月21日〜当月20日（出来高調査日は当月末・帳票は翌月15日）。
 * 出面との検算（笹塚の 鳶/土工 人工・残業h）はこの期間で集計する（primePeriodOf）。
 *
 * ## このファイルは純粋関数だけ（Firestore・PDF ライブラリに触らない）。
 *   PDF の文字の取り出しは lib/pdf-text.server.ts、保存・承認は lib/prime-invoice-store.ts。
 *
 * ## 給与の取り扱い
 * 控除の給与額（大川さんの月の給与）は個人の給与なので、API は pay.view の無い人には伏せて返す（maskPrimeBundleForViewer）。
 */
import { calcManDays, calcOvertimeHours, type AttendanceEntry, type SiteWorkSchedule } from '@/types'
import { parseDKey, parseSdKey, getSiteRates, isDispatched, INTERMEDIARY_BASE_RATIO, type MainData, type CompanyProfile } from './compute'
import { isTobiGroup, isDokoGroup } from './jobs'

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

/** 一次経由の現場で当社が受け取る割合（現場マスタの受取単価と同じ決まり・lib/compute.ts） */
export const PRIME_INVOICE_RATIO = INTERMEDIARY_BASE_RATIO
export const PRIME_INVOICE_TAX_RATE = 0.10
/** 人工の締め日（前月21日〜当月20日） */
export const PRIME_CUTOFF_DAY = 20
export const PRIME_INVOICE_ALLOWED_TYPES = ['application/pdf']
/** 1ファイルの上限。ブラウザ → API → Storage と通す（Vercel の API は本文 4.5MB まで）。控えは数KB・控除計算書は数百KB */
export const PRIME_INVOICE_MAX_FILE_BYTES = 4 * 1024 * 1024
/** 1回の送信にまとめる上限（これを超えるときは何回かに分けて送る） */
export const PRIME_INVOICE_MAX_REQUEST_BYTES = 3.5 * 1024 * 1024
export const PRIME_INVOICE_MAX_FILES = 12
export const PRIME_INVOICE_DOC_ID_RE = /^[0-9a-f-]{36}$/
/** 請求書番号の接頭辞に足す印（応援の請求書 HC-202609-01 と番号を混ぜない → HCP-202609-01） */
export const PRIME_INVOICE_NO_SUFFIX = 'P'

// ─────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────

/** statement = 大林組の控え（工種1枚）／ memo = 山岡の控除計算書／ other = その他の添付 */
export type PrimeFileKind = 'statement' | 'memo' | 'other'

export interface PrimeInvoiceFile {
  path: string
  name: string
  contentType: string
  size: number
  kind: PrimeFileKind
  /** 読み取れなかったときの理由（読めたら null） */
  parseError?: string | null
}

/** 大林組の控え1枚から読んだもの */
export interface GcStatement {
  tradeCode: string
  tradeName: string
  /** 帳票No */
  docNo: string
  /** 帳票年月日 YYYY-MM-DD（請求年月日に使う） */
  billDate: string
  /** 出来高調査日 YYYY-MM-DD */
  surveyDate: string
  /** 工事場所受渡し場所名称（笹塚駅南口東地区開発計画 施工業務） */
  projectName: string
  /** 発注者名（株式会社大林組） */
  gcName: string
  /** 受注者の会社名（山岡建設工業株式会社） */
  contractorName: string
  /** 今回請求金額計（税抜） */
  amount: number
  tax: number
  /** 最終帳票金額（税込） */
  total: number
  /** 出来高調査回数 */
  round?: number
  contractTotal?: number
  cumulative?: number
}

export interface MemoLine {
  item: string
  qty: number
  unit: string
  rate: number
  amount: number
}

/** 他社から借りた職人（志賀さんなど）の切り出し */
export interface MemoBorrowed {
  /** 職人の名前（「志賀分出面」の志賀） */
  name: string
  /** 貸し元（吉本建設など。「吉本建設支払額」から） */
  companyName: string
  lines: MemoLine[]
  /** 人工分の合計（85%を掛ける前に大林組の請求額から引く） */
  amount: number
  ratioAmount: number | null
  wage: number | null
  payable: number | null
}

/** 山岡の控除計算書1枚から読んだもの */
export interface MemoParsed {
  /** 「8/21～9/20」 */
  periodLabel: string
  /** 「地上仮設工事」 */
  tradeLabel: string
  /** 大林組への請求額の内訳（鳶工・残業・土工・残業・値引き） */
  gcLines: MemoLine[]
  gcTotal: number
  borrowed: MemoBorrowed[]
  hibi: {
    base: number
    ratioAmount: number
    wageName: string
    wage: number
    payable: number
  } | null
}

export interface PrimeBorrowedLine {
  name: string
  companyName: string
  amount: number
}
export interface PrimeWageDeduction {
  name: string
  amount: number
}

/** 請求書1枚（工種1つ） */
export interface PrimeSheet {
  tradeCode: string
  tradeName: string
  docNo: string
  billDate: string
  surveyDate: string
  projectName: string
  gcAmount: number
  gcTax: number
  gcTotal: number
  /** 他社借受の切り出し（85%の前に引く） */
  borrowed: PrimeBorrowedLine[]
  /** 山岡が直接払った給与（85%の後に引く）。個人の給与＝pay.view の無い人には伏せる */
  wageDeductions: PrimeWageDeduction[]
  base: number
  ratioAmount: number
  /** 請求額（税抜） */
  amount: number
  tax: number
  total: number
  /** メモに書かれた「日比建設支払額（税別）」。計算と合っているかの確認用 */
  memoPayable: number | null
  memo: MemoParsed | null
  /** parsed = PDF から読んだまま ／ manual = 手で直した */
  source: 'parsed' | 'manual'
  warnings: string[]
  /** 元になった控え・メモのファイル（path） */
  statementFile: string | null
  memoFile: string | null
}

/**
 * draft（下書き・森田さんが格納）→ pending（確認1待ち・政仁さん）→ checked（確認2待ち・代表）→ issued（発行・番号）→ void（取り消し）
 * 差し戻し・取り下げは draft に戻す（rejected / withdrawn は使わない・型の互換のため残す）
 */
export type PrimeInvoiceStatus = 'draft' | 'pending' | 'checked' | 'issued' | 'void' | 'rejected' | 'withdrawn'

export interface PrimeInvoiceBundle {
  id: string
  companyId: string
  companyName: string
  siteId: string
  siteName: string
  ym: string
  /** 人工の期間（前月21日〜当月20日） */
  period: { from: string; to: string }
  /** 請求書に印字する期間（対象月の1日〜末日・摘要の月日欄） */
  billingPeriod: { from: string; to: string }
  /** 請求年月日（控えの帳票年月日。無ければ翌月15日） */
  invoiceDate: string
  /** 一次からの受取割合（既定 85%・PRIME_INVOICE_RATIO）。発行ごと（この請求書ごと）に下書きの間に変えられる（2026-10-20 代表: IHI は事情があって 90% の月がある） */
  ratio: number
  /** 割合を既定から変えた理由（85% 以外のときに書く） */
  ratioNote?: string
  taxRate: number
  sheets: PrimeSheet[]
  files: PrimeInvoiceFile[]
  /** 読み取り全体の注意（どの工種のメモか分からない・控えの受注者が違う など） */
  warnings: string[]
  subtotal: number
  tax: number
  total: number
  /** 発行時に凍結する自社情報（下書きの間は null・発行で入る） */
  issuer: CompanyProfile | null
  status: PrimeInvoiceStatus
  no: string
  issueDate: string
  issuedAt: string
  issuedBy: string
  requestedAt?: string
  requestedBy?: string
  requestedByName?: string
  /** 確認1（政仁さん）。確認2（代表）は issuedAt / issuedBy */
  checkedAt?: string
  checkedBy?: string
  checkedByName?: string
  rejectedAt?: string
  rejectedBy?: string
  rejectReason?: string
  voidedAt?: string
  voidedBy?: string
  voidReason?: string
  createdAt: string
  createdBy: string
  createdByName?: string
  updatedAt: string
}

// ─────────────────────────────────────────────
// 数字・日付
// ─────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

/** '¥13,123,000'・'▲ 604,743'・'182.25'・'¥-760' → 数（読めなければ null）。▲ は控除の印（正の数で返す） */
export function parseMoneyToken(t: string | undefined): number | null {
  if (typeof t !== 'string') return null
  const s = t.normalize('NFKC').replace(/[¥￥,\s円]/g, '').replace(/^▲/, '').replace(/^△/, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

const isNumToken = (t: string | undefined) => parseMoneyToken(t) !== null

export function shiftYmLocal(ym: string, delta: number): string {
  let y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10) + delta
  while (m < 1) { m += 12; y-- }
  while (m > 12) { m -= 12; y++ }
  return `${y}${pad2(m)}`
}

function daysInYm(ym: string): number {
  return new Date(parseInt(ym.slice(0, 4), 10), parseInt(ym.slice(4, 6), 10), 0).getDate()
}

const isoOf = (ym: string, day: number) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${pad2(day)}`

/** 人工の期間: 前月21日〜当月20日 */
export function primePeriodOf(ym: string, cutoff = PRIME_CUTOFF_DAY): { from: string; to: string; fromYm: string; toYm: string } {
  const prev = shiftYmLocal(ym, -1)
  return { from: isoOf(prev, cutoff + 1), to: isoOf(ym, cutoff), fromYm: prev, toYm: ym }
}

/** 請求書に印字する期間（対象月の1日〜末日） */
export function primeBillingPeriodOf(ym: string): { from: string; to: string } {
  return { from: isoOf(ym, 1), to: isoOf(ym, daysInYm(ym)) }
}

/** 請求年月日の既定（翌月15日）。控えの帳票年月日があればそちらを使う */
export function defaultPrimeInvoiceDate(ym: string): string {
  return isoOf(shiftYmLocal(ym, 1), 15)
}

/** 'YYYY-MM-DD' → '令和N年M月D日' */
export function reiwaDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const y = parseInt(m[1], 10)
  const era = y - 2018
  return `令和${era === 1 ? '元' : era}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`
}

/** 「2026 | 年 | 10 | 月 | 15 | 日」の並びから日付を取り出す（見つからなければ ''） */
function dateFromTokens(tokens: string[], start: number): string {
  const seg = tokens.slice(start, start + 7).map(t => t.normalize('NFKC'))
  const joined = seg.join('')
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(joined)
  if (!m) return ''
  return `${m[1]}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[3], 10))}`
}

// ─────────────────────────────────────────────
// 大林組の控え（請求書（控え））の読み取り
// ─────────────────────────────────────────────

/** 行ごとの文字（lib/pdf-text.server.ts が x 座標順に並べたもの）から、ラベルの右隣の値を取り出す */
function valuesAfter(lines: string[][], label: string): string[] | null {
  for (const tokens of lines) {
    const idx = tokens.findIndex(t => t.normalize('NFKC').replace(/\s/g, '') === label)
    if (idx >= 0) return tokens.slice(idx + 1)
  }
  return null
}

function moneyAfter(lines: string[][], label: string): number | null {
  const v = valuesAfter(lines, label)
  if (!v) return null
  return parseMoneyToken(v[0])
}

/** 大林組の請求書（控え）か */
export function looksLikeGcStatement(lines: string[][]): boolean {
  const head = lines.slice(0, 3).map(t => t.join('').normalize('NFKC').replace(/\s/g, '')).join('')
  return head.includes('請求書') && head.includes('控え') && lines.some(t => t.some(x => x.normalize('NFKC').replace(/\s/g, '') === '今回請求金額計'))
}

/** 山岡の控除計算書か */
export function looksLikeMemo(lines: string[][]): boolean {
  const all = lines.map(t => t.join('')).join('\n').normalize('NFKC')
  return all.includes('借受職人') || (all.includes('支払額') && all.includes('85'))
}

export function parseGcStatement(lines: string[][]): { ok: true; statement: GcStatement } | { ok: false; error: string } {
  if (!looksLikeGcStatement(lines)) return { ok: false, error: '大林組の請求書（控え）の形ではありません' }
  const tradeName = (valuesAfter(lines, '取引件名') || []).join(' ').trim()
  const tradeCode = (valuesAfter(lines, '取引件名コード') || [''])[0] || ''
  const amount = moneyAfter(lines, '今回請求金額計')
  const tax = moneyAfter(lines, '消費税額')
  const total = moneyAfter(lines, '最終帳票金額')
  if (!tradeName) return { ok: false, error: '取引件名（工種）が読めません' }
  if (amount === null) return { ok: false, error: '今回請求金額計が読めません' }
  const docLine = valuesAfter(lines, '帳票No/帳票年月日/注文番号') || []
  const docNo = docLine[0] && isNumToken(docLine[0]) ? docLine[0] : ''
  const billDate = dateFromTokens(docLine, docLine.findIndex((t, i) => i > 0 && /^\d{4}$/.test(t.normalize('NFKC'))))
  const surveyLine = valuesAfter(lines, '出来高調査日') || []
  const surveyDate = dateFromTokens(surveyLine, 0)
  const roundTok = (valuesAfter(lines, '出来高調査回数') || [])[0]
  const round = roundTok && /^\d+$/.test(roundTok) ? parseInt(roundTok, 10) : undefined
  // 「笹塚駅南口東地区開発計画 | 施工業務」のように複数の塊に分かれる。右隣のラベル（工事場所…）より前まで
  const projectRaw = valuesAfter(lines, '工事場所受渡し場所名称') || []
  const projectName = projectRaw.join(' ').replace(/\s+/g, ' ').trim()
  const gcName = ((valuesAfter(lines, '発注者名') || [])[0] || '').trim()
  const contractorRaw = valuesAfter(lines, '会社名') || []
  const contractorName = (contractorRaw[0] || '').trim()
  const contractTotal = moneyAfter(lines, '契約金額計') ?? undefined
  const cumulative = moneyAfter(lines, '今回迄累積請求金額計') ?? undefined
  const taxN = tax ?? Math.floor(amount * PRIME_INVOICE_TAX_RATE)
  return {
    ok: true,
    statement: {
      tradeCode, tradeName, docNo, billDate, surveyDate, projectName, gcName, contractorName,
      amount, tax: taxN, total: total ?? amount + taxN, round, contractTotal, cumulative,
    },
  }
}

// ─────────────────────────────────────────────
// 山岡の控除計算書（所属元の異なる借受職人給与の控除）の読み取り
// ─────────────────────────────────────────────

const ITEM_WORDS = ['鳶工', '土工', '残業', '値引き', '値引', '鳶', '土工手間']

/** 「鳶工 | 182.25 | 人 | 36,000 | ＝ | 6,561,000」の左側の塊を1行として読む（右側に給与の列が続いていても最初の「＝」まで） */
function parseMemoLine(tokens: string[]): MemoLine | null {
  const norm = tokens.map(t => t.normalize('NFKC').trim())
  const itemIdx = norm.findIndex(t => ITEM_WORDS.includes(t))
  if (itemIdx < 0) return null
  const eqIdx = norm.findIndex((t, i) => i > itemIdx && t === '=')
  if (eqIdx < 0) return null
  const seg = norm.slice(itemIdx + 1, eqIdx)
  const nums = seg.filter(isNumToken).map(t => parseMoneyToken(t) as number)
  const unit = seg.find(t => !isNumToken(t)) || ''
  const amount = parseMoneyToken(norm[eqIdx + 1])
  if (amount === null) return null
  // 数量と単価: 2つあれば [数量, 単価]、1つなら単価だけ（数量なし＝0）
  const qty = nums.length >= 2 ? nums[0] : 0
  const rate = nums.length >= 2 ? nums[1] : (nums[0] ?? 0)
  return { item: norm[itemIdx], qty, unit, rate, amount }
}

/** 「▲ 604,743」または「▲」「604,743」 */
function deductionOn(norm: string[]): number | null {
  for (let i = 0; i < norm.length; i++) {
    const t = norm[i]
    if (/^[▲△]\s*[\d,]+$/.test(t)) return parseMoneyToken(t)
    if ((t === '▲' || t === '△') && isNumToken(norm[i + 1])) return parseMoneyToken(norm[i + 1])
  }
  return null
}

function tokenAfter(norm: string[], pred: (t: string) => boolean): number | null {
  const i = norm.findIndex(pred)
  return i >= 0 ? parseMoneyToken(norm[i + 1]) : null
}

const isRatioToken = (t: string) => /×\s*85\s*[%％]/.test(t)

export function parseMemo(lines: string[][]): { ok: true; memo: MemoParsed } | { ok: false; error: string } {
  if (!looksLikeMemo(lines)) return { ok: false, error: '山岡の控除計算書（借受職人給与の控除）の形ではありません' }
  const normLines = lines.map(t => t.map(x => x.normalize('NFKC').trim()).filter(Boolean))
  const text = (t: string[]) => t.join(' ')

  const periodLabel = (() => {
    for (const t of normLines.slice(0, 3)) { const m = /[（(]([\d/～~〜\-–]+)[）)]/.exec(text(t)); if (m) return m[1] }
    return ''
  })()
  const headerIdx = normLines.findIndex(t => text(t).includes('への請求額'))
  const tradeLabel = (() => {
    if (headerIdx < 0) return ''
    const m = /【(.+?)】/.exec(text(normLines[headerIdx]))
    return m ? m[1].replace(/[（(]税別[）)]/, '').trim() : ''
  })()

  // 大林組への請求額の内訳: ヘッダの次から、最初の「計」の行まで
  const gcLines: MemoLine[] = []
  let gcTotal: number | null = null
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < normLines.length; i++) {
      const t = normLines[i]
      if (t[0] === '計' || (t.includes('計') && t.findIndex(x => x === '計') === 0)) { gcTotal = parseMoneyToken(t[1]); break }
      const l = parseMemoLine(t)
      if (l) gcLines.push(l)
    }
  }
  if (gcTotal === null) return { ok: false, error: '大林組への請求額の「計」が読めません' }

  // 「○○分出面」のブロック（他社借受）: 名前と、次の「計 … ×85%」までの行
  const borrowedBlocks: { name: string; start: number }[] = []
  normLines.forEach((t, i) => { const tok = t.find(x => /分出面/.test(x)); const m = tok ? /^(.+?)分出面/.exec(tok) : null; if (m) borrowedBlocks.push({ name: m[1].trim(), start: i }) })

  // 「○○支払額」の行（会社ごとの支払額）
  const payableLines = normLines.map((t, i) => ({ t, i })).filter(({ t }) => t.some(x => x.includes('支払額')))

  const findUp = (from: number, pred: (t: string[]) => boolean, limit = 12) => {
    for (let i = from; i >= Math.max(0, from - limit); i--) if (pred(normLines[i])) return i
    return -1
  }

  const borrowed: MemoBorrowed[] = []
  let hibi: MemoParsed['hibi'] = null
  for (const { t, i } of payableLines) {
    const payTok = t.find(x => x.includes('支払額')) as string
    const companyName = payTok.replace(/支払額.*$/, '').trim()
    const payIdx = t.indexOf(payTok)
    const payable = parseMoneyToken(t[payIdx - 1])
    const wage = deductionOn(t)
    // ×85% と 計 は同じ行か、少し上の行
    const ratioIdx = t.some(isRatioToken) ? i : findUp(i, x => x.some(isRatioToken))
    const ratioLine = ratioIdx >= 0 ? normLines[ratioIdx] : []
    const ratioAmount = tokenAfter(ratioLine, isRatioToken)
    const base = tokenAfter(ratioLine, x => x === '計')
    // 「大川分差引」は同じ行に人工の列が続いていることがあるので、塊（token）単位で名前を取る
    const nameIdx = findUp(i, x => x.some(tok => /分差引/.test(tok)))
    const wageName = nameIdx >= 0 ? (/^(.+?)分差引/.exec(normLines[nameIdx].find(tok => /分差引/.test(tok)) || '')?.[1] || '').trim() : ''
    if (companyName.includes('日比')) {
      if (payable === null || ratioAmount === null || base === null) return { ok: false, error: '日比建設支払額の行（計 → ×85% → 差引）が読めません' }
      hibi = { base, ratioAmount, wageName, wage: wage ?? 0, payable }
      continue
    }
    // 他社: 「○○分出面」ブロックの人工の行
    const blk = borrowedBlocks.filter(b => b.start < i).sort((a, b) => b.start - a.start)[0]
    const lines: MemoLine[] = []
    if (blk) {
      for (let k = blk.start + 1; k < (ratioIdx >= 0 ? ratioIdx : i); k++) { const l = parseMemoLine(normLines[k]); if (l) lines.push(l) }
    }
    const amount = base ?? lines.reduce((s, l) => s + l.amount, 0)
    borrowed.push({ name: wageName || blk?.name || companyName, companyName, lines, amount, ratioAmount, wage, payable })
  }
  if (!hibi) return { ok: false, error: '「日比建設支払額（税別）」の行が見つかりません' }
  return { ok: true, memo: { periodLabel, tradeLabel, gcLines, gcTotal, borrowed, hibi } }
}

// ─────────────────────────────────────────────
// 請求書1枚の計算
// ─────────────────────────────────────────────

export function computeSheetAmounts(input: { gcAmount: number; borrowed: PrimeBorrowedLine[]; wageDeductions: PrimeWageDeduction[] }, ratio = PRIME_INVOICE_RATIO, taxRate = PRIME_INVOICE_TAX_RATE) {
  const borrowedTotal = input.borrowed.reduce((s, b) => s + Math.round(b.amount), 0)
  const wageTotal = input.wageDeductions.reduce((s, w) => s + Math.round(w.amount), 0)
  const base = Math.round(input.gcAmount) - borrowedTotal
  const ratioAmount = Math.floor(base * ratio + 1e-9)
  const amount = ratioAmount - wageTotal
  const tax = Math.floor(amount * taxRate + 1e-9)
  return { base, ratioAmount, amount, tax, total: amount + tax }
}

/** 控え1枚（＋あればメモ）から請求書1枚を作る。ratio は請求書ごとの割合（既定 85%） */
export function buildSheet(st: GcStatement, memo: MemoParsed | null, files: { statementFile: string | null; memoFile: string | null }, ratio = PRIME_INVOICE_RATIO): PrimeSheet {
  const warnings: string[] = []
  const isDefaultRatio = Math.abs(ratio - PRIME_INVOICE_RATIO) < 1e-9
  const borrowed: PrimeBorrowedLine[] = (memo?.borrowed || []).map(b => ({ name: b.name, companyName: b.companyName, amount: b.amount }))
  const wageDeductions: PrimeWageDeduction[] = memo?.hibi && memo.hibi.wage > 0 ? [{ name: memo.hibi.wageName || '出向者', amount: memo.hibi.wage }] : []
  if (memo && memo.gcTotal !== st.amount) warnings.push(`メモの「大林組への請求額 計」${memo.gcTotal.toLocaleString()}円が、控えの今回請求金額計 ${st.amount.toLocaleString()}円と違います`)
  const amounts = computeSheetAmounts({ gcAmount: st.amount, borrowed, wageDeductions }, ratio)
  const memoPayable = memo?.hibi?.payable ?? null
  if (!isDefaultRatio && memo?.hibi) {
    warnings.push(`割合が ${Math.round(ratio * 100)}% なので、メモの「日比建設支払額（税別）」（85% で計算）とは合いません。割合が正しいか確かめてください`)
  } else {
    if (memoPayable !== null && memoPayable !== amounts.amount) {
      warnings.push(`メモの「日比建設支払額（税別）」${memoPayable.toLocaleString()}円と、計算した請求額 ${amounts.amount.toLocaleString()}円に ${(amounts.amount - memoPayable).toLocaleString()}円の差があります（山岡の端数の扱いの違いか、読み取りの誤り。メモを確認してください）`)
    }
    if (memo?.hibi && memo.hibi.ratioAmount !== amounts.ratioAmount) {
      warnings.push(`メモの85%の額 ${memo.hibi.ratioAmount.toLocaleString()}円と計算 ${amounts.ratioAmount.toLocaleString()}円が違います`)
    }
  }
  if (st.tax !== Math.floor(st.amount * PRIME_INVOICE_TAX_RATE)) warnings.push('控えの消費税額が税抜の10%になっていません')
  return {
    tradeCode: st.tradeCode, tradeName: st.tradeName, docNo: st.docNo, billDate: st.billDate, surveyDate: st.surveyDate, projectName: st.projectName,
    gcAmount: st.amount, gcTax: st.tax, gcTotal: st.total,
    borrowed, wageDeductions, ...amounts, memoPayable, memo, source: 'parsed', warnings,
    statementFile: files.statementFile, memoFile: files.memoFile,
  }
}

/** 手で直した枚・割合を変えた枚を計算し直す（数字の項目はサーバで必ずここを通す）。ratio は請求書ごとの割合 */
export function recomputeSheet(sheet: PrimeSheet, ratio = PRIME_INVOICE_RATIO): PrimeSheet {
  const amounts = computeSheetAmounts({ gcAmount: sheet.gcAmount, borrowed: sheet.borrowed, wageDeductions: sheet.wageDeductions }, ratio)
  const gcTax = Math.floor(sheet.gcAmount * PRIME_INVOICE_TAX_RATE)
  const isDefaultRatio = Math.abs(ratio - PRIME_INVOICE_RATIO) < 1e-9
  const warnings = sheet.warnings.filter(w => !w.startsWith('メモの「日比建設支払額') && !w.startsWith('メモの85%') && !w.startsWith('割合が '))
  if (!isDefaultRatio && sheet.memoPayable !== null) {
    warnings.push(`割合が ${Math.round(ratio * 100)}% なので、メモの「日比建設支払額（税別）」（85% で計算）とは合いません。割合が正しいか確かめてください`)
  } else if (sheet.memoPayable !== null && sheet.memoPayable !== amounts.amount) {
    warnings.push(`メモの「日比建設支払額（税別）」${sheet.memoPayable.toLocaleString()}円と、計算した請求額 ${amounts.amount.toLocaleString()}円に ${(amounts.amount - sheet.memoPayable).toLocaleString()}円の差があります`)
  }
  return { ...sheet, gcTax, gcTotal: sheet.gcAmount + gcTax, ...amounts, warnings }
}

/** メモがどの控え（工種）のものか: 金額が一致する枚 → 工種名が含まれる枚 → 見つからなければ -1 */
export function matchMemoToSheet(memo: MemoParsed, statements: GcStatement[]): number {
  const byAmount = statements.findIndex(s => s.amount === memo.gcTotal)
  if (byAmount >= 0) return byAmount
  const kw = memo.tradeLabel.replace(/工事$/, '').replace(/\s/g, '')
  if (kw) {
    const byName = statements.findIndex(s => s.tradeName.replace(/\s/g, '').includes(kw) || kw.includes(s.tradeName.replace(/[・\s]/g, '').slice(0, 4)))
    if (byName >= 0) return byName
  }
  return -1
}

/** 控えとメモの読み取り結果から、月の請求書の枚を組み立てる（控えの帳票No順） */
export function assembleSheets(
  statements: { st: GcStatement; file: string }[],
  memos: { memo: MemoParsed; file: string }[],
  ratio = PRIME_INVOICE_RATIO,
): { sheets: PrimeSheet[]; warnings: string[] } {
  const warnings: string[] = []
  const sorted = [...statements].sort((a, b) => (a.st.docNo || '').localeCompare(b.st.docNo || '') || a.st.tradeName.localeCompare(b.st.tradeName, 'ja'))
  const memoFor = new Map<number, { memo: MemoParsed; file: string }>()
  for (const m of memos) {
    const idx = matchMemoToSheet(m.memo, sorted.map(s => s.st))
    if (idx < 0) { warnings.push(`控除計算書「${m.memo.tradeLabel || m.file}」がどの工種の控えに当たるか分かりません（金額 ${m.memo.gcTotal.toLocaleString()}円の控えがありません）`); continue }
    if (memoFor.has(idx)) { warnings.push(`「${sorted[idx].st.tradeName}」に控除計算書が2枚あります。あとの1枚は使いません`); continue }
    memoFor.set(idx, m)
  }
  const sheets = sorted.map((s, i) => buildSheet(s.st, memoFor.get(i)?.memo || null, { statementFile: s.file, memoFile: memoFor.get(i)?.file || null }, ratio))
  // 同じ工種が2枚（同じ控えを2回入れた）
  const seen = new Set<string>()
  for (const sh of sheets) {
    const key = sh.tradeCode || sh.tradeName
    if (seen.has(key)) warnings.push(`「${sh.tradeName}」の控えが2枚あります（同じファイルを2回入れていませんか）`)
    seen.add(key)
  }
  return { sheets, warnings }
}

export function sumSheets(sheets: PrimeSheet[]): { subtotal: number; tax: number; total: number } {
  const subtotal = sheets.reduce((s, x) => s + x.amount, 0)
  const tax = sheets.reduce((s, x) => s + x.tax, 0)
  return { subtotal, tax, total: subtotal + tax }
}

// ─────────────────────────────────────────────
// 出面との検算（前月21日〜当月20日の人工）
// ─────────────────────────────────────────────

export interface PrimeManDayRow {
  key: string
  label: string
  group: '鳶' | '土工' | 'その他'
  isSubcon: boolean
  /** 出向者（山岡が給与を払う人。人工は大林組に請求されている） */
  dispatched: boolean
  days: number
  otH: number
}

export interface PrimeManDays {
  period: { from: string; to: string }
  /** 人工のある日（承認がそろっているかの確認に使う） */
  activeDays: { ym: string; day: number }[]
  tobiDays: number
  tobiOtH: number
  dokoDays: number
  dokoOtH: number
  rows: PrimeManDayRow[]
  /** 現場の常用単価（出面側の金額の計算に使う） */
  rates: { tobiRate: number; dokoRate: number; tobiOtRate: number; dokoOtRate: number }
  /** 出面側で計算した大林組への請求額（人工 × 常用単価 ＋ 残業h × 残業単価） */
  amount: number
}

/** 残業単価 = 常用単価 ÷ 8h × 1.25（山岡のメモ: 36,000 → 5,625・28,000 → 4,375） */
export function primeOtRate(dayRate: number): number {
  return Math.round(dayRate / 8 * 1.25)
}

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * 現場（親＋工種サイト）の人工を期間で集計する。
 * 除外は応援の請求書と同じ（有給/欠勤/現場休/帰国中/試験・休業補償(0.6)・鳶土工以外）。
 * 出向者は**含める**（山岡は出向者の人工も大林組に請求し、給与を控除する）。行に印を付けて分けて見せる。
 */
export function aggregatePrimeManDays(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  siteIds: string[],
  ym: string,
  cutoff = PRIME_CUTOFF_DAY,
): PrimeManDays {
  const p = primePeriodOf(ym, cutoff)
  const inPeriod = (entryYm: string, day: number) => (entryYm === p.fromYm && day > cutoff) || (entryYm === p.toYm && day <= cutoff)
  const siteSet = new Set(siteIds)
  const rows = new Map<string, PrimeManDayRow>()
  const active = new Map<string, { ym: string; day: number }>()
  const markActive = (entryYm: string, day: number) => active.set(`${entryYm}_${day}`, { ym: entryYm, day })
  const wsOf = (sid: string) => main.sites.find(s => s.id === sid)?.workSchedule as SiteWorkSchedule | undefined

  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    if (!siteSet.has(pk.sid)) continue
    const day = parseInt(pk.day, 10)
    if (!inPeriod(pk.ym, day)) continue
    const w = main.workers.find(x => x.id === parseInt(pk.wid, 10))
    if (!w) continue
    if (v.w === 0.6 && w.visa !== 'none') continue
    const group: PrimeManDayRow['group'] = isDokoGroup(w.job) ? '土工' : isTobiGroup(w.job) ? '鳶' : 'その他'
    if (group === 'その他') continue
    const md = calcManDays(v)
    const ot = md > 0 ? calcOvertimeHours(v, wsOf(pk.sid)) : 0
    if (md <= 0 && ot <= 0) continue
    const key = `w${w.id}`
    let row = rows.get(key)
    if (!row) { row = { key, label: w.name, group, isSubcon: false, dispatched: isDispatched(main, w.id, pk.sid, pk.ym), days: 0, otH: 0 }; rows.set(key, row) }
    row.days = round2(row.days + md)
    row.otH = round2(row.otH + ot)
    markActive(pk.ym, day)
  }
  const subconIds = main.subcons.map(x => x.id)
  for (const [k, v] of Object.entries(attSD)) {
    if (!v || !(v.n > 0 || v.on > 0)) continue
    const pk = parseSdKey(k, subconIds)
    if (!siteSet.has(pk.sid)) continue
    const day = parseInt(pk.day, 10)
    if (!inPeriod(pk.ym, day)) continue
    const sc = main.subcons.find(x => x.id === pk.wid)
    if (!sc) continue
    const key = `s${sc.id}`
    let row = rows.get(key)
    if (!row) { row = { key, label: `${sc.name}（外注）`, group: sc.type === '土工業者' ? '土工' : '鳶', isSubcon: true, dispatched: false, days: 0, otH: 0 }; rows.set(key, row) }
    row.days = round2(row.days + (v.n || 0))
    row.otH = round2(row.otH + (v.on || 0))
    markActive(pk.ym, day)
  }
  const list = [...rows.values()].sort((a, b) => (a.isSubcon !== b.isSubcon ? (a.isSubcon ? 1 : -1) : a.group !== b.group ? (a.group === '鳶' ? -1 : 1) : a.label.localeCompare(b.label, 'ja')))
  const sum = (g: PrimeManDayRow['group'], f: 'days' | 'otH') => round2(list.filter(r => r.group === g).reduce((s, r) => s + r[f], 0))
  // 単価は対象月の現場マスタ（親現場）の常用単価（受取単価ではなく元請への単価）
  const r = getSiteRates(main, siteIds[0], ym)
  const rates = { tobiRate: r.tobiRate, dokoRate: r.dokoRate, tobiOtRate: primeOtRate(r.tobiRate), dokoOtRate: primeOtRate(r.dokoRate) }
  const tobiDays = sum('鳶', 'days'), tobiOtH = sum('鳶', 'otH'), dokoDays = sum('土工', 'days'), dokoOtH = sum('土工', 'otH')
  const amount = Math.round(tobiDays * rates.tobiRate + tobiOtH * rates.tobiOtRate + dokoDays * rates.dokoRate + dokoOtH * rates.dokoOtRate)
  const activeDays = [...active.values()].sort((a, b) => a.ym.localeCompare(b.ym) || a.day - b.day)
  return { period: { from: p.from, to: p.to }, activeDays, tobiDays, tobiOtH, dokoDays, dokoOtH, rows: list, rates, amount }
}

export interface PrimeCheckRow {
  label: string
  /** 山岡のメモ（大林組への請求額の内訳）の値 */
  memo: number | null
  /** 出面の値 */
  dedura: number
  diff: number | null
  unit: '人' | 'H' | '円'
}

/** メモの内訳（鳶工 182.25人・残業 8H・土工 214人・残業 120H）と出面の人工を並べる */
export function comparePrimeManDays(memo: MemoParsed | null, agg: PrimeManDays): PrimeCheckRow[] {
  const find = (item: string, unit: string, nth = 0) => {
    const xs = (memo?.gcLines || []).filter(l => l.item === item && l.unit.toUpperCase() === unit.toUpperCase())
    return xs[nth]
  }
  // 残業は「鳶工の次」「土工の次」で並ぶ。順番で鳶/土工に割り当てる
  const ot: MemoLine[] = []
  let cur: '鳶' | '土工' | null = null
  const otBy: Record<'鳶' | '土工', MemoLine | undefined> = { 鳶: undefined, 土工: undefined }
  for (const l of memo?.gcLines || []) {
    if (l.item === '鳶工' || l.item === '鳶') cur = '鳶'
    else if (l.item === '土工') cur = '土工'
    else if (l.item === '残業') { ot.push(l); if (cur && !otBy[cur]) otBy[cur] = l }
  }
  const tobi = find('鳶工', '人') || find('鳶', '人')
  const doko = find('土工', '人')
  const row = (label: string, m: number | null | undefined, d: number, unit: PrimeCheckRow['unit']): PrimeCheckRow => ({
    label, memo: m ?? null, dedura: d, diff: m === null || m === undefined ? null : round2(d - m), unit,
  })
  return [
    row('鳶 人工', tobi ? tobi.qty : null, agg.tobiDays, '人'),
    row('鳶 残業', otBy['鳶'] ? otBy['鳶'].qty : null, agg.tobiOtH, 'H'),
    row('土工 人工', doko ? doko.qty : null, agg.dokoDays, '人'),
    row('土工 残業', otBy['土工'] ? otBy['土工'].qty : null, agg.dokoOtH, 'H'),
    row('金額（税抜）', memo ? memo.gcTotal : null, agg.amount, '円'),
  ]
}

// ─────────────────────────────────────────────
// 給与の伏せ字（pay.view の無い人）
// ─────────────────────────────────────────────

/**
 * 控除の給与額（個人の給与）を伏せる。枚の請求額・合計はそのまま（請求書そのものは請求を扱う人が見るもの）。
 * メモのファイル（給与の内訳が書いてある）も一覧から外す。
 */
export function maskPrimeBundleForViewer<T extends Pick<PrimeInvoiceBundle, 'sheets' | 'files'>>(b: T): T & { wageMasked: true } {
  return {
    ...b,
    wageMasked: true as const,
    sheets: b.sheets.map(s => ({
      ...s,
      wageDeductions: s.wageDeductions.map(w => ({ name: w.name, amount: 0 })),
      ratioAmount: 0,
      base: 0,
      memoPayable: null,
      memo: null,
    })),
    files: b.files.filter(f => f.kind !== 'memo'),
  }
}

// ─────────────────────────────────────────────
// 入力の確認（手で直すとき）
// ─────────────────────────────────────────────

/** 割合の入力（% の数。1〜100・小数1桁まで）→ 0.85 のような割合。だめなら null */
export function parseRatioPercent(v: unknown): number | null {
  const n = parseMoneyToken(String(v ?? ''))
  if (n === null || n <= 0 || n > 100) return null
  return Math.round(n * 10) / 1000
}

export function sanitizeSheetEdit(input: unknown): { ok: true; sheet: Pick<PrimeSheet, 'tradeName' | 'tradeCode' | 'docNo' | 'billDate' | 'gcAmount' | 'borrowed' | 'wageDeductions'> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '枚の内容が不正です' }
  const o = input as Record<string, unknown>
  const tradeName = typeof o.tradeName === 'string' ? o.tradeName.trim().slice(0, 60) : ''
  if (!tradeName) return { ok: false, error: '工種（取引件名）を入れてください' }
  const gcAmount = parseMoneyToken(String(o.gcAmount ?? ''))
  if (gcAmount === null || gcAmount <= 0) return { ok: false, error: '大林組への今回請求金額計を入れてください' }
  const lines = (arr: unknown, label: string, withCompany: boolean) => {
    if (arr === undefined || arr === null) return { ok: true as const, list: [] }
    if (!Array.isArray(arr)) return { ok: false as const, error: `${label}の形が不正です` }
    const out: { name: string; companyName: string; amount: number }[] = []
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
      const companyName = typeof r.companyName === 'string' ? r.companyName.trim().slice(0, 60) : ''
      const amount = parseMoneyToken(String(r.amount ?? ''))
      if (!name && amount === null) continue
      if (amount === null || amount < 0) return { ok: false as const, error: `${label}の金額が読めません（${name || '名前なし'}）` }
      if (!name) return { ok: false as const, error: `${label}の名前を入れてください` }
      out.push({ name, companyName: withCompany ? companyName : '', amount: Math.round(amount) })
    }
    return { ok: true as const, list: out }
  }
  const b = lines(o.borrowed, '他社借受', true)
  if (!b.ok) return b
  const w = lines(o.wageDeductions, '給与の控除', false)
  if (!w.ok) return w
  const billDate = typeof o.billDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.billDate) ? o.billDate : ''
  return {
    ok: true,
    sheet: {
      tradeName, tradeCode: typeof o.tradeCode === 'string' ? o.tradeCode.trim().slice(0, 20) : '',
      docNo: typeof o.docNo === 'string' ? o.docNo.trim().slice(0, 20) : '', billDate,
      gcAmount: Math.round(gcAmount), borrowed: b.list, wageDeductions: w.list.map(x => ({ name: x.name, amount: x.amount })),
    },
  }
}

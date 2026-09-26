/**
 * 応援の請求書（2026-09-25・社長指示）。
 *
 * 日比建設が「応援に行った」同業者（peer）へ送る請求書 A4 一式:
 *   1ページ目: 請求書本体（宛名・金額・振込先・登録番号）
 *   2ページ目以降: 出面明細（誰が・いつ・何人工働いたかの根拠）
 *
 * 金額の計算は `buildPeerStatements`（同業者との請求・支払一覧）と同じ数字を使う。
 * 請求書の金額と /peer-statement の「請求する」金額が食い違わないよう、
 * 鳶・土工の内訳へ割るときも合計が１円までズレないように調整している。
 *
 * 出面明細（人が行を持つ表）は、同じフィルタ条件（有給/欠勤/現場休/帰国中/試験の除外、
 * 出向者の除外、休業補償(0.6)の除外、鳶/土工グループのみ）を `calcTobiEquiv` と揃えている
 * ので、明細の行合計を足すと請求書本体の人工と一致する。
 */
import {
  calcManDays, type AttendanceEntry,
} from '@/types'
import {
  calcTobiEquiv, getAssign, getSiteRates, parseDKey,
  type MainData, type ComputeResult, type CompanyPaymentTerms, type RawSubcon,
} from './compute'
import { buildPeerStatements } from './peer-statement'
import { isTobiGroup, isDokoGroup } from './jobs'
import { getHoliday } from './calendar'

// ─────────────────────────────────────────────
// 支払期日（月末締め・翌◯月払い・休日は前営業日）
// ─────────────────────────────────────────────

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + delta
  return { y: Math.floor(total / 12), m: (total % 12) + 1 }
}

function isBusinessDay(y: number, m: number, d: number): boolean {
  const dow = new Date(y, m - 1, d).getDay()
  if (dow === 0 || dow === 6) return false
  return !getHoliday(y, m, d)
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`

/** ym（YYYYMM・請求対象月＝締め月）と支払条件から支払期日を出す。休日なら前営業日へ繰り上げ */
export function computeDueDate(ym: string, terms?: CompanyPaymentTerms | null): string {
  const y = parseInt(ym.slice(0, 4), 10)
  const m = parseInt(ym.slice(4, 6), 10)
  const offset = terms?.payMonthOffset ?? 1
  const payDay = terms?.payDay ?? 'end'
  const target = addMonths(y, m, offset)
  const lastDay = daysInMonth(target.y, target.m)
  const day = payDay === 'end' ? lastDay : Math.min(Math.max(1, payDay), lastDay)

  let yy = target.y, mm = target.m, dd = day
  while (!isBusinessDay(yy, mm, dd)) {
    dd--
    if (dd < 1) {
      mm--
      if (mm < 1) { mm = 12; yy-- }
      dd = daysInMonth(yy, mm)
    }
  }
  return ymd(yy, mm, dd)
}

/** ym（YYYYMM）の請求対象期間（月初〜月末・月末締め固定） */
export function billingPeriodOf(ym: string): { from: string; to: string } {
  const y = parseInt(ym.slice(0, 4), 10)
  const m = parseInt(ym.slice(4, 6), 10)
  return { from: ymd(y, m, 1), to: ymd(y, m, daysInMonth(y, m)) }
}

// ─────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────

export interface PeerInvoiceLine {
  siteId: string
  siteName: string
  role: '鳶' | '土工'
  /** 人工（残業の換算分を含む）。unit === 'h' の行は残業時間 */
  days: number
  /**
   * 'h' = 残業の行（HFU → 日比建設 の請求書・2026-09-26）。数量は時間、単価は残業単価。
   * 無ければ人工の行
   */
  unit?: 'h'
  rate: number
  amount: number
}

export interface PeerInvoiceDetailCell {
  /** その日の人工（1 / 0.5 / 0.6 / 1.5 / 2.5 など） */
  md: number
  /** 残業時間（h）。あれば小さく添える */
  ot?: number
  /** 夜勤を含む日か */
  night?: boolean
}

export interface PeerInvoiceDetailRow {
  key: string
  label: string
  isSubcon: boolean
  /** day(1〜31) → セル */
  cells: Record<number, PeerInvoiceDetailCell>
  total: number
}

export interface PeerInvoiceSiteDetail {
  siteId: string
  siteName: string
  rows: PeerInvoiceDetailRow[]
  /** day → その日の現場合計人工 */
  dayTotals: Record<number, number>
  siteTotal: number
}

export interface PeerInvoiceCompanyInfo {
  postal: string
  address: string
  honorific: string
}

/**
 * 請求書の種類。'peer' = 同業者への応援の請求書、'hfu' = HFU → 日比建設 の請求書（lib/hfu-invoice.ts）。
 * 2026-09-26 より前に発行した記録には無い（= 'peer'）。
 */
export type InvoiceKind = 'peer' | 'hfu'

export interface PeerInvoiceDraft {
  kind?: InvoiceKind
  companyId: string
  companyName: string
  company: PeerInvoiceCompanyInfo
  ym: string
  period: { from: string; to: string }
  lines: PeerInvoiceLine[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
  dueDate: string
  detail: PeerInvoiceSiteDetail[]
}

// ─────────────────────────────────────────────
// 出面明細（現場ごとの人工マトリクス）
// ─────────────────────────────────────────────

function daysInYm(ym: string): number {
  return daysInMonth(parseInt(ym.slice(0, 4), 10), parseInt(ym.slice(4, 6), 10))
}

/**
 * 1現場分の出面明細マトリクスを作る。
 * ⚠️ ここでの除外条件（有給/欠勤/現場休/帰国中/試験・出向者・休業補償(0.6)・鳶土工以外の職種）
 *    は calcTobiEquiv と完全に揃えること。ズレると明細の合計と請求書本体の人工が合わなくなる。
 */
export function buildSiteDetail(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  siteId: string,
  siteName: string,
  /** HFU → 日比建設 の請求書は HFU 所属の作業員だけ・外注なしで作る（lib/hfu-invoice.ts） */
  opts?: { workerFilter?: (w: MainData['workers'][number]) => boolean; includeSubcons?: boolean },
): PeerInvoiceSiteDetail {
  const nDays = daysInYm(ym)
  const dispatchList = getAssign(main, siteId, ym).dispatch
  const rows = new Map<string, PeerInvoiceDetailRow>()

  for (const [k, v] of Object.entries(attD)) {
    if (!v) continue
    const pk = parseDKey(k)
    if (pk.ym !== ym || pk.sid !== siteId) continue
    if (v.p) continue
    if ((v.r ?? 0) > 0 || (v.h ?? 0) > 0 || (v.hk ?? 0) > 0 || ((v as { exam?: number }).exam ?? 0) > 0) continue
    const w = main.workers.find(x => x.id === parseInt(pk.wid, 10))
    if (!w) continue
    if (opts?.workerFilter && !opts.workerFilter(w)) continue
    if (dispatchList.includes(w.id)) continue
    const isComp = v.w === 0.6 && w.visa !== 'none'
    if (isComp) continue
    if (!isTobiGroup(w.job) && !isDokoGroup(w.job)) continue
    const md = calcManDays(v)
    if (md <= 0) continue
    const day = parseInt(pk.day, 10)
    const key = `w${w.id}`
    let row = rows.get(key)
    if (!row) { row = { key, label: w.name, isSubcon: false, cells: {}, total: 0 }; rows.set(key, row) }
    row.cells[day] = { md, ot: v.o || undefined, night: !!v.ns }
    row.total = Math.round((row.total + md) * 100) / 100
  }

  for (const [k, v] of Object.entries(opts?.includeSubcons === false ? {} : attSD)) {
    if (!v || !v.n) continue
    const pk = parseDKey(k)
    if (pk.ym !== ym || pk.sid !== siteId) continue
    const sc = main.subcons.find(x => x.id === pk.wid)
    if (!sc) continue
    if (v.n <= 0) continue
    const day = parseInt(pk.day, 10)
    const key = `s${sc.id}`
    let row = rows.get(key)
    if (!row) { row = { key, label: `${sc.name}（外注）`, isSubcon: true, cells: {}, total: 0 }; rows.set(key, row) }
    row.cells[day] = { md: v.n, ot: v.on || undefined }
    row.total = Math.round((row.total + v.n) * 100) / 100
  }

  const sortedRows = [...rows.values()].sort((a, b) => {
    if (a.isSubcon !== b.isSubcon) return a.isSubcon ? 1 : -1
    return a.label.localeCompare(b.label, 'ja')
  })

  const dayTotals: Record<number, number> = {}
  for (let d = 1; d <= nDays; d++) {
    let t = 0
    for (const row of sortedRows) t += row.cells[d]?.md || 0
    if (t > 0) dayTotals[d] = Math.round(t * 100) / 100
  }
  const siteTotal = Math.round(sortedRows.reduce((s, r) => s + r.total, 0) * 100) / 100

  return { siteId, siteName, rows: sortedRows, dayTotals, siteTotal }
}

// ─────────────────────────────────────────────
// 請求書ドラフト本体
// ─────────────────────────────────────────────

/**
 * 会社×月の請求書ドラフトを作る。会社が見つからない、またはその月の応援請求が無ければ null。
 * 1回のリクエストで main と当月 att を読み込んだあと、この関数（および内部で呼ぶ
 * buildPeerStatements）は純粋計算のみで Firestore アクセスを増やさない。
 */
export function buildPeerInvoiceDraft(
  main: MainData,
  c: ComputeResult,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  companyId: string,
): PeerInvoiceDraft | null {
  const company = main.subcons.find(x => x.id === companyId) as RawSubcon | undefined
  if (!company) return null

  const stmt = buildPeerStatements(main, c, attD, attSD, ym).find(s => s.companyId === companyId)
  if (!stmt || stmt.billing.length === 0) return null

  const lines: PeerInvoiceLine[] = []
  for (const b of stmt.billing) {
    if (b.tobiDays > 0 && b.dokoDays > 0) {
      // 端数はどちらかに寄せず、土工側を丸めた残りを鳶側にすることで
      // 2行の合計が peer-statement と1円までズレないようにする
      const dokoAmount = Math.round(b.dokoDays * b.dokoRate)
      const tobiAmount = b.amount - dokoAmount
      lines.push({ siteId: b.siteId, siteName: b.siteName, role: '鳶', days: b.tobiDays, rate: b.tobiRate, amount: tobiAmount })
      lines.push({ siteId: b.siteId, siteName: b.siteName, role: '土工', days: b.dokoDays, rate: b.dokoRate, amount: dokoAmount })
    } else if (b.tobiDays > 0) {
      lines.push({ siteId: b.siteId, siteName: b.siteName, role: '鳶', days: b.tobiDays, rate: b.tobiRate, amount: b.amount })
    } else if (b.dokoDays > 0) {
      lines.push({ siteId: b.siteId, siteName: b.siteName, role: '土工', days: b.dokoDays, rate: b.dokoRate, amount: b.amount })
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const taxRate = 0.10
  const tax = Math.floor(subtotal * taxRate)
  const total = subtotal + tax

  const detail = stmt.billing.map(b => buildSiteDetail(main, attD, attSD, ym, b.siteId, b.siteName))

  return {
    kind: 'peer',
    companyId,
    companyName: company.name,
    company: {
      postal: company.postal || '',
      address: company.address || '',
      honorific: company.honorific || '御中',
    },
    ym,
    period: billingPeriodOf(ym),
    lines,
    subtotal,
    taxRate,
    tax,
    total,
    dueDate: computeDueDate(ym, company.paymentTerms),
    detail,
  }
}

/** 請求書明細（鳶/土工の行）を現場ごとに集計する。経営コックピット連携（lib/integration.ts）の内訳作りに使う */
export function summarizePeerInvoiceSites(lines: PeerInvoiceLine[]): { siteId: string; siteName: string; amount: number }[] {
  const bySite = new Map<string, { siteId: string; siteName: string; amount: number }>()
  for (const l of lines) {
    const cur = bySite.get(l.siteId)
    if (cur) cur.amount += l.amount
    else bySite.set(l.siteId, { siteId: l.siteId, siteName: l.siteName, amount: l.amount })
  }
  return [...bySite.values()]
}

// 現場単価・鳶土工換算を直接使うことがある呼び出し元向けに re-export
export { calcTobiEquiv, getSiteRates }

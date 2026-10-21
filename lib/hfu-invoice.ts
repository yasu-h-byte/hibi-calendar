/**
 * HFU → 日比建設 の請求書（2026-09-26・代表指示）。
 *
 * HFU 所属の作業員が日比建設の仕事（自社現場・応援現場とも全現場）で働いた人工を、
 * HFU から日比建設へ請求する。金額は 人工 × 社内単価（鳶/土工・settings で設定）。
 * 画面・発行・取り消し・採番は応援の請求書（lib/peer-invoice.ts / peer-invoice-store.ts）と共通で、
 * 違うのは「誰の人工を数えるか」「発行者（HFU）と宛先（日比建設）」「単価の出どころ」だけ。
 *
 * 人工の数え方は応援の請求書（calcTobiEquiv）と同じ:
 *   - 有給/欠勤/現場休/帰国中/試験・出向者・休業補償(0.6)・鳶土工以外の職種は除外
 *   - 夜勤は 1.5 人工（日勤＋夜勤 2.5）
 * 残業は人工に換算せず、HFU がこれまで手作りしていた請求書（2025-12 分の現物）に合わせて
 * 「鳶 残業 ◯h × 残業単価」の別行にする。残業単価 = 1人工の単価 ÷ 8 × 1.25（円未満四捨五入。30,000 → 4,688）。
 * 請求額は出面明細（buildSiteDetail）の行から直接積み上げるので、明細と本体の人工・残業時間は必ず一致する。
 *
 * 待機料（2026-10-21 代表決定・2026年10月分から）: 現場の都合で休ませた日（出面の 0.6補）は、これまで人工に入れず
 * HFU がその日の給与を持っていた。HFU は日比建設の専属なので、休ませた分は「待機料」として日比建設へ請求する。
 *   待機料 = 日数 × 1人工の単価 × 率（設定・既定 60%。円未満四捨五入）。現場ごと・鳶/土工ごとの別行
 *   個人の給与額（時給）は使わない（請求書は給与を見られない人も扱う帳票）。社内単価×60% は外国人の日額を上回るので、
 *   保証枠内で 100% 払った日（lib/compute.ts COMP_FULL_WITHIN_GUARANTEE_FROM_YM）も HFU の持ち出しにならない
 *   明細には「待」と印字し、人工の合計には入れない（待機の日数は別の列）
 */
import type { AttendanceEntry } from '@/types'
import type { MainData } from './compute'
import { parseDKey } from './compute'
import { isTobiGroup, isDokoGroup } from './jobs'
import { isWorkerOfOrg } from './orgs'
import { siteBillingName } from './site-hierarchy'
import {
  buildSiteDetail, billingPeriodOf, computeDueDate,
  type PeerInvoiceDraft, type PeerInvoiceLine, type PeerInvoiceSiteDetail,
} from './peer-invoice'

import { HFU_INVOICE_COMPANY_ID } from './constants'

export { HFU_INVOICE_COMPANY_ID }

/** 請求書番号の接頭辞の既定値（日比建設の 'HC' と分けて採番する） */
export const HFU_DEFAULT_INVOICE_PREFIX = 'HFU'

export const isHfuInvoiceCompanyId = (id: string) => id === HFU_INVOICE_COMPANY_ID

/** 待機料をこの月分から請求する（2026-10-21 代表決定）。それより前の月は現場都合休を請求に入れない（従来どおり） */
export const HFU_STANDBY_FROM_YM = '202610'
/** 待機料の率の既定（%）。設定（hfuInvoice.standbyRatePct）が未保存のときに使う */
export const HFU_STANDBY_DEFAULT_RATE_PCT = 60
/** 請求書に印字する待機料の行の名前（「鳶 待機料」のように職種の後ろに付く） */
export const HFU_STANDBY_LABEL = '待機料'

/** 待機料の単価 = 1人工の単価 × 率%（円未満四捨五入）。30,000 × 60% → 18,000 */
export function hfuStandbyRate(dayRate: number, ratePct: number): number {
  return Math.round(dayRate * ratePct / 100)
}

/** その月に待機料を請求するか（開始月以降で、率が 0 より大きい） */
export function hfuStandbyEnabled(ym: string, settings: { standbyRatePct?: number } | null | undefined): boolean {
  return ym >= HFU_STANDBY_FROM_YM && (settings?.standbyRatePct ?? HFU_STANDBY_DEFAULT_RATE_PCT) > 0
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** 残業単価 = 1人工の単価 ÷ 8h × 1.25（円未満四捨五入）。HFU の従来の請求書と同じ（30,000 → 4,688） */
export function hfuOtRate(dayRate: number): number {
  return Math.round(dayRate / 8 * 1.25)
}

/**
 * 下書きの単価が発行に足りているか（単価 0 の行がある請求書は出さない）。
 * 土工がいない月は土工の単価が未入力でもよい。
 */
export function checkHfuRates(draft: PeerInvoiceDraft): { ok: true } | { ok: false; error: string } {
  const missing = [...new Set(draft.lines.filter(l => !(l.rate > 0)).map(l => l.role))]
  if (missing.length > 0) {
    return { ok: false, error: `HFU → 日比建設 の単価（${missing.join('・')}）が未入力です。設定 → HFU → 日比建設 の請求書 から入力してください` }
  }
  return { ok: true }
}

/**
 * ym（YYYYMM）の HFU → 日比建設 請求書の下書き。HFU の人工が1つも無ければ null。
 * Firestore アクセスなし（main と当月 att を渡す純粋計算）。
 */
export function buildHfuInvoiceDraft(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  ym: string,
): PeerInvoiceDraft | null {
  const settings = main.hfuInvoice || null
  const tobiRate = settings?.tobiRate || 0
  const dokoRate = settings?.dokoRate || 0
  const standbyOn = hfuStandbyEnabled(ym, settings)
  const standbyPct = settings?.standbyRatePct ?? HFU_STANDBY_DEFAULT_RATE_PCT
  const isHfu = (w: { org?: string }) => isWorkerOfOrg(w, 'hfu')
  const workerById = new Map(main.workers.map(w => [w.id, w]))

  // HFU の人が出ている現場（工種サイトは工種ごとに別行・別明細）
  const siteIds = new Set<string>()
  for (const k of Object.keys(attD)) {
    const pk = parseDKey(k)
    if (pk.ym !== ym) continue
    const w = workerById.get(parseInt(pk.wid, 10))
    if (w && isHfu(w)) siteIds.add(pk.sid)
  }

  const sites = main.sites as Parameters<typeof siteBillingName>[0]
  const detail: PeerInvoiceSiteDetail[] = []
  const lines: PeerInvoiceLine[] = []
  for (const siteId of siteIds) {
    const siteName = siteBillingName(sites, siteId)
    const d = buildSiteDetail(main, attD, {}, ym, siteId, siteName, { workerFilter: isHfu, includeSubcons: false, includeStandby: standbyOn })
    if (d.rows.length === 0) continue
    detail.push(d)

    // 明細の行から鳶/土工の人工・残業時間・待機の日数を積み上げる
    const sum = { 鳶: { days: 0, ot: 0, standby: 0 }, 土工: { days: 0, ot: 0, standby: 0 } }
    for (const row of d.rows) {
      const w = workerById.get(parseInt(row.key.slice(1), 10))
      if (!w) continue
      const role = isDokoGroup(w.job) ? '土工' : isTobiGroup(w.job) ? '鳶' : null
      if (!role) continue
      sum[role].days += row.total
      sum[role].ot += Object.values(row.cells).reduce((s, c) => s + (c.ot || 0), 0)
      sum[role].standby += row.standbyDays || 0
    }
    for (const role of ['鳶', '土工'] as const) {
      const rate = role === '鳶' ? tobiRate : dokoRate
      const days = round2(sum[role].days), ot = round2(sum[role].ot), standby = sum[role].standby
      if (days > 0) lines.push({ siteId, siteName, role, days, rate, amount: Math.round(days * rate) })
      if (ot > 0) {
        const otRate = hfuOtRate(rate)
        lines.push({ siteId, siteName, role, unit: 'h', days: ot, rate: otRate, amount: Math.round(ot * otRate) })
      }
      if (standby > 0) {
        // 待機料: 日数 × (1人工の単価 × 率)。現場ごと・職種ごとの別行（人工 → 残業 → 待機料 の順）
        const standbyRate = hfuStandbyRate(rate, standbyPct)
        lines.push({ siteId, siteName, role, unit: 'standby', days: standby, rate: standbyRate, amount: Math.round(standby * standbyRate) })
      }
    }
  }
  if (detail.length === 0) return null

  const byName = (a: { siteName: string }, b: { siteName: string }) => a.siteName.localeCompare(b.siteName, 'ja')
  detail.sort(byName)
  // 現場ごとに まとめて、その中は 鳶 → 鳶 残業 → 鳶 待機料 → 土工 → … の順（lines は現場の順に push 済み）
  const siteOrder = new Map(detail.map((d, i) => [d.siteId, i]))
  lines.sort((a, b) => (siteOrder.get(a.siteId)! - siteOrder.get(b.siteId)!))

  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const taxRate = 0.10
  const tax = Math.floor(subtotal * taxRate)
  const hibi = main.companyProfile

  return {
    kind: 'hfu',
    companyId: HFU_INVOICE_COMPANY_ID,
    companyName: hibi?.name || '株式会社日比建設',
    company: { postal: hibi?.postal || '', address: hibi?.address || '', honorific: '御中' },
    ym,
    period: billingPeriodOf(ym),
    lines,
    subtotal,
    taxRate,
    tax,
    total: subtotal + tax,
    dueDate: computeDueDate(ym, settings?.paymentTerms),
    detail,
  }
}

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
    const d = buildSiteDetail(main, attD, {}, ym, siteId, siteName, { workerFilter: isHfu, includeSubcons: false })
    if (d.rows.length === 0) continue
    detail.push(d)

    // 明細の行から鳶/土工の人工と残業時間を積み上げる
    const sum = { 鳶: { days: 0, ot: 0 }, 土工: { days: 0, ot: 0 } }
    for (const row of d.rows) {
      const w = workerById.get(parseInt(row.key.slice(1), 10))
      if (!w) continue
      const role = isDokoGroup(w.job) ? '土工' : isTobiGroup(w.job) ? '鳶' : null
      if (!role) continue
      sum[role].days += row.total
      sum[role].ot += Object.values(row.cells).reduce((s, c) => s + (c.ot || 0), 0)
    }
    for (const role of ['鳶', '土工'] as const) {
      const rate = role === '鳶' ? tobiRate : dokoRate
      const days = round2(sum[role].days), ot = round2(sum[role].ot)
      if (days > 0) lines.push({ siteId, siteName, role, days, rate, amount: Math.round(days * rate) })
      if (ot > 0) {
        const otRate = hfuOtRate(rate)
        lines.push({ siteId, siteName, role, unit: 'h', days: ot, rate: otRate, amount: Math.round(ot * otRate) })
      }
    }
  }
  if (detail.length === 0) return null

  const byName = (a: { siteName: string }, b: { siteName: string }) => a.siteName.localeCompare(b.siteName, 'ja')
  detail.sort(byName)
  // 現場ごとに まとめて、その中は 鳶 → 鳶 残業 → 土工 → 土工 残業 の順（lines は現場の順に push 済み）
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

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
 *   - 残業は人工に換算して足す（外国人 7h・日本人 8h で 1 人工）
 * 請求額は出面明細（buildSiteDetail）の行から直接積み上げるので、明細と本体の人工は必ず一致する。
 */
import type { AttendanceEntry } from '@/types'
import type { MainData, HfuInvoiceSettings } from './compute'
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

const round1 = (v: number) => Math.round(v * 10) / 10

/** HFU 側の設定が発行に足りているか（単価 0 の請求書は出さない）。自社情報の必須項目は別途チェック */
export function checkHfuRates(s: HfuInvoiceSettings | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!s || !(s.tobiRate > 0) || !(s.dokoRate > 0)) {
    return { ok: false, error: 'HFU → 日比建設 の単価（鳶・土工）が未入力です。設定 → HFU → 日比建設 の請求書 から入力してください' }
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

    // 明細の行から鳶/土工の人工（残業換算込み）を積み上げる
    let tobi = 0, doko = 0
    for (const row of d.rows) {
      const w = workerById.get(parseInt(row.key.slice(1), 10))
      if (!w) continue
      const stdH = w.visa === 'none' ? 8 : 7
      const otEq = Object.values(row.cells).reduce((s, c) => s + (c.ot || 0), 0) / stdH
      if (isDokoGroup(w.job)) doko += row.total + otEq
      else if (isTobiGroup(w.job)) tobi += row.total + otEq
    }
    // 人工は 0.1 単位に丸めてから単価を掛ける（受け取った側が 人工×単価 で検算できるように）
    const tobiDays = round1(tobi), dokoDays = round1(doko)
    if (tobiDays > 0) lines.push({ siteId, siteName, role: '鳶', days: tobiDays, rate: tobiRate, amount: Math.round(tobiDays * tobiRate) })
    if (dokoDays > 0) lines.push({ siteId, siteName, role: '土工', days: dokoDays, rate: dokoRate, amount: Math.round(dokoDays * dokoRate) })
  }
  if (detail.length === 0) return null

  const byName = (a: { siteName: string }, b: { siteName: string }) => a.siteName.localeCompare(b.siteName, 'ja')
  detail.sort(byName)
  lines.sort((a, b) => byName(a, b) || (a.role === '鳶' ? -1 : 1))

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

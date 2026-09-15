/**
 * 同業者別の請求・支払一覧（2026-09-15・第4段階）。
 *
 * 二次業者同士は人を貸し借りし、**相殺せず互いに請求書を送り合う**（代表 2026-09-15）。
 * - 請求する側: 応援現場（担当の二次が同業者）での人工 × 現場（工種）の受取単価 → 担当の同業者へ
 *   自社の作業員に加え、その現場へ連れて行った外注の人工も含める（こちらのチームとして請求するため）
 * - 支払う側: 同業者・外注から応援をもらった人工 × 借りる単価（出面の外注原価と同じ額）→ その会社へ
 *
 * 金額は出面の実績から出す見込み額。請求書の作成は次の段階（代表 2026-09-15）。
 */
import { calcTobiEquiv, getSiteRates, type MainData, type ComputeResult } from './compute'
import { resolveSiteParties, type CompanyLike } from './companies'
import { siteDisplayName, calendarSiteIdOf } from './site-hierarchy'
import type { AttendanceEntry } from '@/types'

export interface PeerBillingLine {
  siteId: string
  siteName: string
  /** 鳶の人工（残業の換算分を含む） */
  tobiDays: number
  dokoDays: number
  tobiRate: number
  dokoRate: number
  amount: number
}

export interface PeerPaymentLine {
  siteId: string
  siteName: string
  days: number
  otHours: number
  amount: number
}

export interface PeerStatement {
  companyId: string
  companyName: string
  billing: PeerBillingLine[]
  billingTotal: number
  payments: PeerPaymentLine[]
  paymentTotal: number
}

type SiteWithParties = MainData['sites'][number] & {
  parentId?: string; workType?: string; ownerId?: string; primeId?: string; gcId?: string; siteType?: string; client?: string
}

export function buildPeerStatements(
  main: MainData,
  c: ComputeResult,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
): PeerStatement[] {
  const sites = main.sites as SiteWithParties[]
  const companies = main.subcons as unknown as CompanyLike[]
  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const map = new Map<string, PeerStatement>()
  const entry = (id: string): PeerStatement => {
    let e = map.get(id)
    if (!e) {
      e = { companyId: id, companyName: companies.find(x => x.id === id)?.name || id, billing: [], billingTotal: 0, payments: [], paymentTotal: 0 }
      map.set(id, e)
    }
    return e
  }
  const round1 = (v: number) => Math.round(v * 10) / 10

  // ── 請求する側（応援現場）──
  for (const s of sites) {
    // 請負体制は親現場のものを使う（工種サイトは親から引き継ぐ）
    const partySite = sites.find(x => x.id === calendarSiteIdOf(sites, s.id)) || s
    const parties = resolveSiteParties(partySite, companies)
    if (parties.siteType !== 'support' || !parties.billToId) continue
    const te = calcTobiEquiv(main, attD, attSD, [{ y, m }], s.id)
    const tobiDays = te.tobiWork + te.tobiOtEq
    const dokoDays = te.dokoWork + te.dokoOtEq
    if (tobiDays + dokoDays <= 0) continue
    const rates = getSiteRates(main, s.id, ym)
    const amount = Math.round(tobiDays * rates.tobiBase + dokoDays * rates.dokoBase)
    const e = entry(parties.billToId)
    e.billing.push({
      siteId: s.id, siteName: siteDisplayName(sites, s.id),
      tobiDays: round1(tobiDays), dokoDays: round1(dokoDays),
      tobiRate: rates.tobiBase, dokoRate: rates.dokoBase, amount,
    })
    e.billingTotal += amount
  }

  // ── 支払う側（応援をもらった分＝外注原価）──
  for (const [key, v] of Object.entries(c.siteSubcons)) {
    if (!v || v.work <= 0) continue
    // 現場 id・会社 id とも '_' を含み得るので、末尾一致の最長の会社 id を採る
    const sc = [...companies].sort((p, q) => q.id.length - p.id.length).find(x => key.endsWith(`_${x.id}`))
    if (!sc) continue
    const siteId = key.slice(0, key.length - sc.id.length - 1)
    const e = entry(sc.id)
    e.payments.push({
      siteId, siteName: siteDisplayName(sites, siteId),
      days: round1(v.work), otHours: round1(v.ot), amount: Math.round(v.cost),
    })
    e.paymentTotal += Math.round(v.cost)
  }

  return [...map.values()]
    .map(e => ({
      ...e,
      billing: e.billing.sort((a, b) => a.siteName.localeCompare(b.siteName, 'ja')),
      payments: e.payments.sort((a, b) => a.siteName.localeCompare(b.siteName, 'ja')),
    }))
    .sort((a, b) => (b.billingTotal + b.paymentTotal) - (a.billingTotal + a.paymentTotal))
}

/**
 * 経営コックピット（keiei_dashboard）との連携（2026-09-25）
 *
 * DEDURA＋ と経営コックピットを一体で使うための「読むだけ」の窓口。
 * 経営コックピットのサーバーが、共通の合言葉（環境変数 DEDURA_INTEGRATION_KEY・両方の Vercel に同じ値）を
 * ヘッダ x-integration-key に付けて呼ぶ。人のパスワード（ADMIN_PASSWORD など）とは別物で、書き込みは一切できない。
 *
 * 返すもの（1か月分・金額はすべて税抜の円）:
 *   - 現場ごとの請求額（入力済みの額だけ。未入力の月は billingEntered=false で見込みは入れない）と請求先
 *   - 現場ごとの自社人件費（実支給ベース）・外注費（出面 × 単価）
 *   - 外注・同業者ごとの支払見込み（出面 × 単価）
 *   - 応援現場で同業者へ請求する見込み
 * 詳細は docs/integration.md。
 */
import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { compute, getMainData, getAttData, getAttDataCached, isClosedMonthYm, getBillTotal, getSubconRate } from '@/lib/compute'
import { applyPayrollCosts } from '@/lib/payroll-cost'
import { resolveSiteParties, type CompanyLike } from '@/lib/companies'
import { calendarSiteIdOf } from '@/lib/site-hierarchy'
import { buildPeerStatements } from '@/lib/peer-statement'
import { summarizePeerInvoiceSites } from '@/lib/peer-invoice'
import { listPeerInvoicesForYm } from '@/lib/peer-invoice-store'

/** 合言葉の照合（長さの違い・未設定も安全に false） */
export function isValidIntegrationKey(given: string | null | undefined, expected: string | undefined = process.env.DEDURA_INTEGRATION_KEY): boolean {
  if (!given || !expected || expected.length < 16) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function checkIntegrationKey(request: NextRequest): boolean {
  return isValidIntegrationKey(request.headers.get('x-integration-key'))
}

export interface IntegrationSite {
  id: string
  name: string
  /** 工種サイトの親現場（なければ null） */
  parentId: string | null
  siteType: 'direct' | 'support'
  /** 請求先（直 = 一次、応援 = 担当の同業者） */
  billToId: string | null
  billToName: string
  /** 入力済みの請求額（税抜・円）。未入力なら 0 */
  billing: number
  billingEntered: boolean
  /** 自社人件費（実支給ベース・出向控除後） */
  ownLaborCost: number
  /** 外注費（出面 × 単価） */
  subconCost: number
  workDays: number
  subWorkDays: number
}

export interface IntegrationSubcon {
  id: string
  name: string
  workDays: number
  otCount: number
  /** 支払見込み（税抜・円）= 出面 × 単価 */
  cost: number
  /** 取引先マスタの単価（税抜・1人工あたり）と残業単価（1人あたり） */
  rate: number
  otRate: number
  /** 現場ごと。rate/otRate は現場・月の上書きを反映した、実際に使った単価 */
  sites: { siteId: string; siteName: string; workDays: number; otCount: number; cost: number; rate: number; otRate: number }[]
}

/** 発行済み・取り消し済みの「応援の請求書」（app/api/peer-invoice・2026-09-25）。peerBilling は見込み、こちらは実際に出した請求書 */
export interface IntegrationPeerInvoice {
  no: string
  companyId: string
  companyName: string
  ym: string
  issueDate: string
  dueDate: string
  /** 税抜 */
  subtotal: number
  tax: number
  /** 税込 */
  total: number
  status: 'issued' | 'void'
  sites: { siteId: string; siteName: string; amount: number }[]
}

export interface IntegrationMonth {
  ym: string
  generatedAt: string
  /** 月の出面が締まっているか（前月より前）。締まっていない月は数字が動く */
  closed: boolean
  sites: IntegrationSite[]
  subcons: IntegrationSubcon[]
  peerBilling: { companyId: string; companyName: string; amount: number }[]
  peerInvoices: IntegrationPeerInvoice[]
  /**
   * HFU → 日比建設 の請求書（lib/hfu-invoice.ts・2026-09-26）。グループ内の請求なので peerInvoices
   * （日比建設が同業者から受け取る入金）とは分ける。日比建設から見ると支払い、HFU から見ると入金。
   */
  hfuInvoices: IntegrationPeerInvoice[]
  totals: { billing: number; billingEnteredSites: number; ownLaborCost: number; subconCost: number }
}

const r1 = (v: number) => Math.round(v * 10) / 10

export async function buildIntegrationMonth(ym: string): Promise<IntegrationMonth> {
  const main = await getMainData()
  const closed = isClosedMonthYm(ym)
  // 読み取り回数を増やさない: 締まった月は5分キャッシュ、当月・前月は毎回読む（CLAUDE.md の Firestore ルール）
  const att = closed ? await getAttDataCached(ym) : await getAttData(ym)
  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const c = compute(main, att.d, att.sd, [{ y, m }])
  await applyPayrollCosts(c, main, [{ ym, d: att.d, sd: att.sd, drv: att.drv }])

  const companies = main.subcons as unknown as CompanyLike[]
  const allSites = main.sites as unknown as (Parameters<typeof resolveSiteParties>[0] & { id: string; name: string; parentId?: string })[]

  const sites: IntegrationSite[] = []
  for (const s of allSites) {
    const sd = c.sites[s.id]
    const billing = Math.round(getBillTotal(main, s.id, ym))
    const work = sd ? sd.work : 0
    const subWork = sd ? sd.subWork : 0
    if (billing <= 0 && work + subWork <= 0) continue
    const partySite = allSites.find(x => x.id === calendarSiteIdOf(main.sites as never, s.id)) || s
    const parties = resolveSiteParties(partySite, companies)
    sites.push({
      id: s.id,
      name: s.name,
      parentId: s.parentId ?? null,
      siteType: parties.siteType,
      billToId: parties.billToId,
      billToName: parties.billToName,
      billing,
      billingEntered: billing > 0,
      ownLaborCost: Math.round(Math.max(0, (sd?.cost || 0) - (sd?.dispatchDeduction || 0))),
      subconCost: Math.round(sd?.subCost || 0),
      workDays: r1(work),
      subWorkDays: r1(subWork),
    })
  }

  const subcons: IntegrationSubcon[] = []
  for (const sc of main.subcons) {
    const cd = c.subcons[sc.id]
    if (!cd || (cd.work <= 0 && cd.cost <= 0)) continue
    const breakdown: IntegrationSubcon['sites'] = []
    for (const s of main.sites) {
      const ss = c.siteSubcons[`${s.id}_${sc.id}`]
      if (ss && ss.work > 0) {
        const r = getSubconRate(main, sc.id, s.id, ym)
        breakdown.push({ siteId: s.id, siteName: s.name, workDays: r1(ss.work), otCount: r1(ss.ot), cost: Math.round(ss.cost), rate: r.rate, otRate: r.otRate })
      }
    }
    subcons.push({ id: sc.id, name: sc.name, workDays: r1(cd.work), otCount: r1(cd.ot), cost: Math.round(cd.cost), rate: sc.rate, otRate: sc.otRate, sites: breakdown })
  }

  const peerBilling = buildPeerStatements(main, c, att.d, att.sd, ym)
    .filter(p => p.billingTotal > 0)
    .map(p => ({ companyId: p.companyId, companyName: p.companyName, amount: Math.round(p.billingTotal) }))

  // 申請中・差し戻し・取り下げはまだ請求書として出ていないので渡さない（発行済み・取り消し済みだけ）
  const peerInvoiceRecords = (await listPeerInvoicesForYm(ym))
    .filter((inv): inv is typeof inv & { status: 'issued' | 'void' } => inv.status === 'issued' || inv.status === 'void')
  const toIntegration = (inv: (typeof peerInvoiceRecords)[number]): IntegrationPeerInvoice => ({
    no: inv.no, companyId: inv.companyId, companyName: inv.companyName, ym: inv.ym,
    issueDate: inv.issueDate, dueDate: inv.dueDate,
    subtotal: inv.subtotal, tax: inv.tax, total: inv.total,
    status: inv.status, sites: summarizePeerInvoiceSites(inv.lines),
  })
  const peerInvoices = peerInvoiceRecords.filter(inv => inv.kind !== 'hfu').map(toIntegration)
  const hfuInvoices = peerInvoiceRecords.filter(inv => inv.kind === 'hfu').map(toIntegration)

  return {
    ym,
    generatedAt: new Date().toISOString(),
    closed,
    sites,
    subcons,
    peerBilling,
    peerInvoices,
    hfuInvoices,
    totals: {
      billing: sites.reduce((t, s) => t + s.billing, 0),
      billingEnteredSites: sites.filter(s => s.billingEntered).length,
      ownLaborCost: sites.reduce((t, s) => t + s.ownLaborCost, 0),
      subconCost: sites.reduce((t, s) => t + s.subconCost, 0),
    },
  }
}

// ─────────────────────────────────────────────
// 書き込み（1つだけ）: 現場ごとの外注単価の上書き
// ─────────────────────────────────────────────

/**
 * 経営コックピットの「請求書の取り込み」で、請求書の単価が DEDURA＋ と違うと分かったときに、
 * 社長がボタンで押した単価をここに書く（現場マスタの「現場別単価」と同じ場所 assign[siteId].subconRates）。
 * 残業単価は書かない（getSubconRate 側で 日額 ÷ 8 × 1.25 を自動計算）。
 * 書いた記録は activity に「integration」として残す。
 */
export async function setSubconSiteRate(input: { subconId: string; siteId: string; rate: number; reason?: string }): Promise<{ ok: true; previous: number | null } | { ok: false; error: string }> {
  const { subconId, siteId, rate, reason } = input
  if (!subconId || !siteId) return { ok: false, error: 'subconId と siteId が必要です' }
  if (!Number.isInteger(rate) || rate < 5_000 || rate > 100_000) return { ok: false, error: '単価は 5,000〜100,000 円の整数で' }

  const { db } = await import('@/lib/firebase')
  const { doc, getDoc, updateDoc } = await import('@/lib/fsdb')
  const { logActivity } = await import('@/lib/activity')
  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) return { ok: false, error: 'main が見つかりません' }
  const data = snap.data() as { subcons?: { id: string; name: string; rate?: number }[]; sites?: { id: string; name: string }[]; assign?: Record<string, Record<string, unknown>> }
  const sc = (data.subcons || []).find(s => s.id === subconId)
  const site = (data.sites || []).find(s => s.id === siteId)
  if (!sc || !site) return { ok: false, error: '外注先か現場が見つかりません' }

  const assign = (data.assign || {}) as Record<string, { subconRates?: Record<string, { rate?: number; otRate?: number }> } & Record<string, unknown>>
  const siteAssign = assign[siteId] || { workers: [], subcons: [] }
  const current = siteAssign.subconRates || {}
  const previous = current[subconId]?.rate ?? null
  current[subconId] = { rate }
  siteAssign.subconRates = current
  assign[siteId] = siteAssign
  // assign だけを差し替える（他のフィールドは触らない）
  await updateDoc(ref, { assign })
  await logActivity('integration', 'subcon.updateSiteRates', `${sc.name} の ${site.name} の単価を ${previous ?? sc.rate ?? '未設定'} → ${rate} に（経営コックピットの請求書照合${reason ? `: ${reason}` : ''}）`)
  return { ok: true, previous }
}

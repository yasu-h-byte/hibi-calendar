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
 *   - HFU 所属の作業員の人数と稼働（人工・残業・社内単価での額。HFU の鳶の売上の見込みに使う・2026-09-27）
 * 詳細は docs/integration.md。
 */
import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'
import { compute, getMainData, getAttData, getAttDataCached, isClosedMonthYm, getBillTotal, getSubconRate } from '@/lib/compute'
import { applyPayrollCosts } from '@/lib/payroll-cost'
import { resolveSiteParties, type CompanyLike } from '@/lib/companies'
import { calendarSiteIdOf } from '@/lib/site-hierarchy'
import { buildPeerStatements } from '@/lib/peer-statement'
import { summarizePeerInvoiceSites } from '@/lib/peer-invoice'
import { listPeerInvoicesForYm } from '@/lib/peer-invoice-store'
import { reportSitesForPeriod } from '@/lib/report-sites'
import { buildHfuInvoiceDraft } from '@/lib/hfu-invoice'
import { isWorkerOfOrg } from '@/lib/orgs'
import { parseDKey } from '@/lib/compute'

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
  /**
   * HFU 所属の作業員の人数と稼働（2026-09-27・経営コックピットの HFU 黒字化シミュレーター用）。
   * 人工・残業・額は HFU → 日比建設 の請求書の下書き（buildHfuInvoiceDraft）と同じ数え方。締まっていない月は途中の数字
   */
  hfuWorkforce: IntegrationHfuWorkforce
  totals: { billing: number; billingEnteredSites: number; ownLaborCost: number; subconCost: number }
}

export interface IntegrationHfuWorkforce {
  /** その月の末に在籍している HFU 所属の作業員（退職日がその月の末より前の人は除く） */
  heads: number
  /** その月に人工がある HFU 所属の作業員 */
  workingHeads: number
  /** 人工（鳶・土工。夜勤1.5・休業補償などは請求書と同じ扱い） */
  workDays: number
  /** 残業（時間） */
  otHours: number
  /** 社内単価での額（税抜・円。単価が未設定なら 0） */
  amount: number
  /** 社内単価（鳶・土工。未設定は 0） */
  tobiRate: number
  dokoRate: number
  /** 出面が入っている最後の日（YYYY-MM-DD）。まだ無ければ null */
  lastDate: string | null
  /**
   * HFU 所属の作業員のその月の人件費（給与計算の支給額・残業や手当を含む・会社負担の社会保険は含まない・円）と、
   * その人工（夜勤1.5など給与計算の人工）。1人工あたりの人件費 = laborCost ÷ laborManDays（2026-09-27）
   */
  laborCost: number
  laborManDays: number
  /** 日額の平均（その月に人工がある人・円） */
  dailyRateAvg: number
}

function buildHfuWorkforce(
  main: Awaited<ReturnType<typeof getMainData>>,
  attD: Parameters<typeof buildHfuInvoiceDraft>[1],
  ym: string,
  payrollWorkers: { org: string; rate: number; totalCost: number; manDays?: number; workDays: number }[],
): IntegrationHfuWorkforce {
  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const monthEnd = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  const monthStart = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`
  const hfuWorkers = main.workers.filter(w => isWorkerOfOrg(w as { org?: string }, 'hfu'))
  const heads = hfuWorkers.filter(w => !w.retired || w.retired >= monthStart).filter(w => !w.hireDate || w.hireDate <= monthEnd).length  // retired-ok: 月初時点の在籍（isStillActiveForMonth と同じ判定）
  const draft = buildHfuInvoiceDraft(main, attD, ym)
  const working = new Set<string>()
  for (const d of draft?.detail || []) for (const row of d.rows) if (row.total > 0) working.add(row.key)
  const hfuIds = new Set(hfuWorkers.map(w => String(w.id)))
  let lastDay = 0
  for (const k of Object.keys(attD)) {
    const pk = parseDKey(k)
    if (pk.ym !== ym || !hfuIds.has(pk.wid)) continue
    lastDay = Math.max(lastDay, parseInt(pk.day, 10) || 0)
  }
  const lines = draft?.lines || []
  const paid = payrollWorkers.filter(w => isWorkerOfOrg(w, 'hfu') && (w.manDays ?? w.workDays) > 0)
  return {
    heads,
    workingHeads: working.size,
    workDays: r1(lines.filter(l => l.unit !== 'h').reduce((t, l) => t + l.days, 0)),
    otHours: r1(lines.filter(l => l.unit === 'h').reduce((t, l) => t + l.days, 0)),
    amount: draft?.subtotal || 0,
    tobiRate: main.hfuInvoice?.tobiRate || 0,
    dokoRate: main.hfuInvoice?.dokoRate || 0,
    lastDate: lastDay > 0 ? `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(lastDay).padStart(2, '0')}` : null,
    laborCost: Math.round(paid.reduce((t, w) => t + (w.totalCost || 0), 0)),
    laborManDays: r1(paid.reduce((t, w) => t + (w.manDays ?? w.workDays), 0)),
    dailyRateAvg: paid.length ? Math.round(paid.reduce((t, w) => t + (w.rate || 0), 0) / paid.length) : 0,
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10

export async function buildIntegrationMonth(ym: string): Promise<IntegrationMonth> {
  const main = await getMainData()
  const closed = isClosedMonthYm(ym)
  // 読み取り回数を増やさない: 締まった月は5分キャッシュ、当月・前月は毎回読む（CLAUDE.md の Firestore ルール）
  const att = closed ? await getAttDataCached(ym) : await getAttData(ym)
  const y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6))
  const c = compute(main, att.d, att.sd, [{ y, m }])
  const payroll = await applyPayrollCosts(c, main, [{ ym, d: att.d, sd: att.sd, drv: att.drv }])

  const companies = main.subcons as unknown as CompanyLike[]
  // 対象の現場は原価・収益画面と同じ決まり（lib/report-sites.ts・2026-10-02 総合点検）。
  //   そのうえで、この月に請求額も人工も無い現場は渡さない（従来どおり）
  const allSites = reportSitesForPeriod(main, [ym], id => c.sites[id]) as unknown as (Parameters<typeof resolveSiteParties>[0] & { id: string; name: string; parentId?: string })[]

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
    hfuWorkforce: buildHfuWorkforce(main, att.d, ym, payroll.workersByYm[ym] || []),
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

  // ドット記法のキーに使う id は英数字・'_'・'-' だけ（'.' や '/' が入ると別のフィールドを書いてしまう）
  if (!/^[A-Za-z0-9_-]+$/.test(subconId) || !/^[A-Za-z0-9_-]+$/.test(siteId)) return { ok: false, error: 'subconId か siteId の形式が不正です' }
  const { db } = await import('@/lib/firebase')
  const { doc, runTransaction } = await import('@/lib/fsdb')
  const { logActivity } = await import('@/lib/activity')
  const ref = doc(db, 'demmen', 'main')
  // 2026-10-02 総合点検: 旧は assign マップを丸ごと読んで丸ごと書き戻していた（職長の工種の切り替えなど、同時の書き込みが消える）
  //   うえに `{ rate }` で置き換えていたので、手で入れた残業単価（otRate）の上書きが黙って消えた。
  //   トランザクションの中で、この現場・この外注のキーだけをドット記法で書き、otRate はそのまま残す
  const out = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { ok: false as const, error: 'main が見つかりません' }
    const data = snap.data() as { subcons?: { id: string; name: string; rate?: number }[]; sites?: { id: string; name: string }[]; assign?: Record<string, { subconRates?: Record<string, { rate?: number; otRate?: number }> }> }
    const sc = (data.subcons || []).find(s => s.id === subconId)
    const site = (data.sites || []).find(s => s.id === siteId)
    if (!sc || !site) return { ok: false as const, error: '外注先か現場が見つかりません' }
    const cur = data.assign?.[siteId]?.subconRates?.[subconId] || {}
    const previous = cur.rate ?? null
    const next: { rate: number; otRate?: number } = { rate }
    if (typeof cur.otRate === 'number' && cur.otRate > 0) next.otRate = cur.otRate   // 手で入れた残業単価は消さない
    tx.update(ref, { [`assign.${siteId}.subconRates.${subconId}`]: next })
    return { ok: true as const, previous, scName: sc.name, siteName: site.name, scRate: sc.rate, keptOtRate: next.otRate }
  })
  if (!out.ok) return out
  await logActivity('integration', 'subcon.updateSiteRates',
    `${out.scName} の ${out.siteName} の単価を ${out.previous ?? out.scRate ?? '未設定'} → ${rate} に（経営コックピットの請求書照合${reason ? `: ${reason}` : ''}）${out.keptOtRate ? `。残業単価の上書き ${out.keptOtRate} はそのまま` : ''}`)
  return { ok: true, previous: out.previous }
}

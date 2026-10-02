/**
 * 現場・取引先を削除してよいか＝どこかから参照されていないか（2026-10-02 総合点検）。
 *
 * 根本原因: 削除に確認が無く、出面・請求額のある現場を消すと過去月の売上と現場の行が消えて原価の合計にだけ残り、
 *   取引先を消すと過去月の外注人工・外注費が全画面から消えた（compute() は `if (!sc) continue`）。
 *   担当がその会社の応援現場は、請求見込みから外れた。
 * 対処: 出面・請求額・請求書（システム・紙）・請負体制・配置から参照があれば削除を拒否し、
 *   「終了にする」「配置・請負体制から外す」へ誘導する。判定は純粋関数（テストできる）＋読み込みの薄い皮。
 */
import { db } from './firebase'
import { collection, getDocs } from '@/lib/fsdb'
import { parseDKey, parseSdKey } from './compute'

export interface AttMonth { ym: string; d: Record<string, unknown>; sd: Record<string, unknown> }

const jpYm = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月`

/** 現場がどこから参照されているか（理由の一覧。空なら削除してよい）。純粋 */
export function siteReferenceReasons(args: {
  siteId: string
  atts: AttMonth[]
  billing: Record<string, number[] | number>
  peerInvoices: { no?: string; status?: string; lines?: { siteId: string }[] }[]
  subconIds: string[]
}): string[] {
  const { siteId, atts, billing, peerInvoices, subconIds } = args
  const reasons: string[] = []
  const months: string[] = []
  for (const att of atts) {
    let n = 0
    for (const k of Object.keys(att.d || {})) if (parseDKey(k).sid === siteId) n++
    for (const k of Object.keys(att.sd || {})) if (parseSdKey(k, subconIds).sid === siteId) n++
    if (n > 0) months.push(`${jpYm(att.ym)}（${n}件）`)
  }
  if (months.length > 0) reasons.push(`出面が入っています: ${months.join('・')}`)
  const billed = Object.entries(billing)
    .filter(([k, v]) => k.startsWith(`${siteId}_`) && /^\d{6}$/.test(k.slice(siteId.length + 1))
      && (Array.isArray(v) ? v.some(x => (x || 0) !== 0) : (v || 0) !== 0))
    .map(([k]) => jpYm(k.slice(siteId.length + 1)))
  if (billed.length > 0) reasons.push(`請求額が入っています: ${billed.join('・')}`)
  const invs = peerInvoices.filter(inv => (inv.lines || []).some(l => l.siteId === siteId))
  if (invs.length > 0) reasons.push(`請求書に載っています: ${invs.map(i => i.no || '（承認待ち・差し戻し）').join('・')}`)
  return reasons
}

/** 取引先がどこから参照されているか（理由の一覧。空なら削除してよい）。純粋 */
export function subconReferenceReasons(args: {
  subconId: string
  atts: AttMonth[]
  sites: { id: string; name: string; gcId?: string; primeId?: string; ownerId?: string }[]
  assign: Record<string, { subcons?: string[]; subconRates?: Record<string, unknown> }>
  peerInvoices: { no?: string; companyId?: string }[]
  paperInvoices: { ym?: string; companyId?: string }[]
  subconIds: string[]
}): string[] {
  const { subconId, atts, sites, assign, peerInvoices, paperInvoices, subconIds } = args
  const reasons: string[] = []
  const months: string[] = []
  for (const att of atts) {
    let n = 0
    for (const k of Object.keys(att.sd || {})) if (parseSdKey(k, subconIds).wid === subconId) n++
    if (n > 0) months.push(`${jpYm(att.ym)}（${n}件）`)
  }
  if (months.length > 0) reasons.push(`外注の出面が入っています: ${months.join('・')}`)
  const parties = sites.filter(s => s.gcId === subconId || s.primeId === subconId || s.ownerId === subconId)
  if (parties.length > 0) reasons.push(`現場の請負体制（元請・一次・担当）に入っています: ${parties.map(s => s.name || s.id).join('・')}`)
  const placed = sites.filter(s => (assign[s.id]?.subcons || []).includes(subconId))
  if (placed.length > 0) reasons.push(`現場の配置に入っています: ${placed.map(s => s.name || s.id).join('・')}`)
  const invs = peerInvoices.filter(inv => inv.companyId === subconId)
  if (invs.length > 0) reasons.push(`請求書の宛先になっています: ${invs.map(i => i.no || '（承認待ち・差し戻し）').join('・')}`)
  const papers = paperInvoices.filter(p => p.companyId === subconId)
  if (papers.length > 0) reasons.push(`紙の請求書が入っています: ${[...new Set(papers.map(p => jpYm(p.ym || '')))].join('・')}`)
  return reasons
}

/** 全月の出面（削除の確認は年に数回のことなので、全部読んでよい） */
export async function loadAllAttMonths(): Promise<AttMonth[]> {
  const snap = await getDocs(collection(db, 'demmen'))
  const out: AttMonth[] = []
  snap.forEach(d => {
    const m = /^att_(\d{6})$/.exec(d.id)
    if (!m) return
    const data = d.data() as { d?: Record<string, unknown>; sd?: Record<string, unknown> }
    out.push({ ym: m[1], d: data.d || {}, sd: data.sd || {} })
  })
  return out
}

async function loadAll(coll: string): Promise<Record<string, unknown>[]> {
  const snap = await getDocs(collection(db, coll))
  const out: Record<string, unknown>[] = []
  snap.forEach(d => out.push(d.data() as Record<string, unknown>))
  return out
}

/** 現場を削除してよいか。拒否なら理由の文（画面にそのまま出す） */
export async function siteDeleteBlockReason(
  siteId: string, main: { billing?: Record<string, number[] | number>; subcons?: { id: string }[] },
): Promise<string | null> {
  const [atts, peerInvoices] = await Promise.all([loadAllAttMonths(), loadAll('peerInvoices')])
  const reasons = siteReferenceReasons({
    siteId, atts, billing: main.billing || {}, peerInvoices: peerInvoices as never,
    subconIds: (main.subcons || []).map(s => s.id),
  })
  if (reasons.length === 0) return null
  return `この現場は使われているため削除できません。\n${reasons.join('\n')}\n過去の集計を残すため、削除ではなく「終了」にしてください`
}

/** 取引先を削除してよいか。拒否なら理由の文 */
export async function subconDeleteBlockReason(
  subconId: string,
  main: { sites?: { id: string; name: string; gcId?: string; primeId?: string; ownerId?: string }[]; assign?: Record<string, { subcons?: string[] }>; subcons?: { id: string }[] },
): Promise<string | null> {
  const [atts, peerInvoices, paperInvoices] = await Promise.all([loadAllAttMonths(), loadAll('peerInvoices'), loadAll('paperInvoices')])
  const reasons = subconReferenceReasons({
    subconId, atts, sites: main.sites || [], assign: main.assign || {},
    peerInvoices: peerInvoices as never, paperInvoices: paperInvoices as never,
    subconIds: (main.subcons || []).map(s => s.id),
  })
  if (reasons.length === 0) return null
  return `この取引先は使われているため削除できません。\n${reasons.join('\n')}\n過去の集計を残すため、削除ではなく配置・請負体制から外すか、役割を見直してください`
}

/**
 * 請求書の採番・「同じ会社・同じ月は1件」の同時操作（lib/peer-invoice-store.ts・2026-10-02 総合点検）
 *   - 同じ月に別の会社へ同時に発行しても番号が重ならない
 *   - 同じ会社に同時に発行すると、1件だけ通る
 *   - 接頭辞に記号があっても連番が続く（旧: 正規表現に埋めていた）
 *   - 出向者（dispatchTo）は請求書の明細に入らない（lib/peer-invoice.ts を isDispatched に寄せた）
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

const store = new Map<string, Record<string, unknown>>()
type Where = { f: string; v: unknown }
let txQueue: Promise<void> = Promise.resolve()
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/activity', () => ({ logActivity: async () => {} }))
vi.mock('@/lib/fsdb', () => ({
  registerMainWriteHook: () => {},
  collection: (_db: unknown, name: string) => ({ name }),
  where: (f: string, _op: string, v: unknown): Where => ({ f, v }),
  query: (c: { name?: string }, ...ws: Where[]) => ({ name: c?.name, ws }),
  getDocs: async ({ name, ws }: { name?: string; ws: Where[] }) => {
    const docs = [...store.entries()]
      .filter(([id, d]) => (name === 'paperInvoices' ? id.startsWith('paper:') : !id.startsWith('paper:')) && ws.every(w => d[w.f] === w.v))
      .map(([id, d]) => ({ id, data: () => structuredClone(d) }))
    return { docs, size: docs.length }
  },
  doc: (_db: unknown, _c: string, id: string) => ({ id }),
  getDoc: async (ref: { id: string }) => ({ exists: () => store.has(ref.id), data: () => structuredClone(store.get(ref.id)) }),
  updateDoc: async (ref: { id: string }, data: Record<string, unknown>) => { store.set(ref.id, { ...store.get(ref.id), ...data }) },
  // 偽物のトランザクション: 前の処理が終わるまで待つ（Firestore のやり直しの代わりに直列化する）
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const prev = txQueue
    let release: () => void = () => {}
    txQueue = new Promise<void>(r => { release = r })
    await prev
    try {
      return await fn({
        get: async (ref: { id: string }) => ({ exists: () => store.has(ref.id), data: () => structuredClone(store.get(ref.id)) }),
        set: (ref: { id: string }, data: Record<string, unknown>, opt?: { merge?: boolean }) => { store.set(ref.id, opt?.merge ? { ...store.get(ref.id), ...data } : structuredClone(data)) },
        update: (ref: { id: string }, data: Record<string, unknown>) => { store.set(ref.id, { ...store.get(ref.id), ...data }) },
      })
    } finally { release() }
  },
}))

const ym = '202609'
const profile = (name: string, prefix: string) => ({
  name, nameEn: '', postal: '', address: '東京都清瀬市', tel: '', invoiceRegNo: 'T1',
  bank: { bankName: 'x', branch: 'x', accountType: '普通' as const, accountNo: '1', holder: 'x' }, invoicePrefix: prefix,
})
const main = {
  workers: [
    { id: 10, name: '山田', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2020-01-01', token: '' },
    { id: 11, name: '出向', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2020-01-01', token: '', dispatchTo: '出向先', dispatchFrom: '2026-01' },
  ],
  sites: [
    { id: 'siteA', name: '応援A', start: '', end: '', foreman: 0, archived: false, siteType: 'support', ownerId: 'peerA', rates: [{ from: '202501', tobiRate: 30000, dokoRate: 28000 }] },
    { id: 'siteB', name: '応援B', start: '', end: '', foreman: 0, archived: false, siteType: 'support', ownerId: 'peerB', rates: [{ from: '202501', tobiRate: 30000, dokoRate: 28000 }] },
  ],
  subcons: [
    { id: 'peerA', name: '同業A', type: '鳶業者', rate: 0, otRate: 0, roles: ['peer'] },
    { id: 'peerB', name: '同業B', type: '鳶業者', rate: 0, otRate: 0, roles: ['peer'] },
  ],
  assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
  defaultRates: {}, mforeman: {}, nightDays: {},
  companyProfile: profile('株式会社日比建設', 'H.C(1)'),
  hfuInvoice: null,
} as unknown as MainData
const attD: Record<string, AttendanceEntry> = {
  [`siteA_10_${ym}_1`]: { w: 1 }, [`siteA_11_${ym}_1`]: { w: 1 },
  [`siteB_10_${ym}_2`]: { w: 1 },
}
const c = { siteSubcons: {} } as never
const args = (companyId: string) => ({ main, c, attD, attSD: {}, ym, companyId, actor: '1' })

beforeEach(() => {
  store.clear()
  store.set(`siteA_${ym}_1`, { foreman: { by: 1 }, final: { by: 2 } })
  store.set(`siteB_${ym}_2`, { foreman: { by: 1 }, final: { by: 2 } })
})

describe('nextInvoiceNoFrom', () => {
  test('接頭辞に記号があっても連番が続き、他の接頭辞・欠番は混ざらない', async () => {
    const { nextInvoiceNoFrom } = await import('@/lib/peer-invoice-store')
    const ex = [{ no: 'H.C(1)-202609-02' }, { no: 'H.C(1)-202609-01' }, { no: 'HFU-202609-07' }, { no: '' }]
    expect(nextInvoiceNoFrom(ex, '202609', 'H.C(1)')).toBe('H.C(1)-202609-03')
    expect(nextInvoiceNoFrom(ex, '202609', 'HFU')).toBe('HFU-202609-08')
    expect(nextInvoiceNoFrom(ex, '202610', 'HFU')).toBe('HFU-202610-01')
  })
})

describe('同時の発行', () => {
  test('別の会社へ同時に発行しても番号が重ならない', async () => {
    const s = await import('@/lib/peer-invoice-store')
    const [a, b] = await Promise.all([s.issuePeerInvoice(args('peerA')), s.issuePeerInvoice(args('peerB'))])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(new Set([a.record.no, b.record.no]).size).toBe(2)
    expect([a.record.no, b.record.no].sort()).toEqual(['H.C(1)-202609-01', 'H.C(1)-202609-02'])
  })
  test('同じ会社へ同時に発行すると1件だけ通る', async () => {
    const s = await import('@/lib/peer-invoice-store')
    const rs = await Promise.all([s.issuePeerInvoice(args('peerA')), s.issuePeerInvoice(args('peerA')), s.requestPeerInvoice(args('peerA'))])
    expect(rs.filter(r => r.ok).length).toBe(1)
    const issued = [...store.values()].filter(d => d.companyId === 'peerA' && (d.status === 'issued' || d.status === 'pending'))
    expect(issued.length).toBe(1)
  })
  test('承認も同じ直列化を通る（同時に承認しても発行は1件・番号は一意）', async () => {
    const s = await import('@/lib/peer-invoice-store')
    const req = await s.requestPeerInvoice({ ...args('peerA'), actor: '50' })
    if (!req.ok) throw new Error(req.error)
    const other = await s.issuePeerInvoice(args('peerB'))
    if (!other.ok) throw new Error(other.error)
    const [x, y] = await Promise.all([s.approvePeerInvoice({ main, id: req.record.id, actor: '1' }), s.approvePeerInvoice({ main, id: req.record.id, actor: '1' })])
    expect([x.ok, y.ok].filter(Boolean).length).toBe(1)
    const ok = x.ok ? x : y
    expect(ok.ok && ok.record.no).toBe('H.C(1)-202609-02')
  })
})

describe('出向者は請求書の明細に入らない', () => {
  test('dispatchTo の人（現場の dispatch 一覧に無くても）は外れる', async () => {
    const { buildSiteDetail } = await import('@/lib/peer-invoice')
    const d = buildSiteDetail(main, attD, {}, ym, 'siteA', '応援A')
    expect(d.rows.map(r => r.label)).toEqual(['山田'])
    expect(d.siteTotal).toBe(1)
  })
})

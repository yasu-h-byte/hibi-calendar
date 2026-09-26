/**
 * 請求書の申請 → 承認フロー（2026-09-26・代表指示「森田が発行→政仁が承認」）
 *
 * 確認すること:
 *   - 事務の申請は「承認待ち」で番号なし。承認で番号が付いて発行済みになる
 *   - 申請中・発行済みがあれば二重に申請・発行できない
 *   - 差し戻し・取り下げは承認待ちだけ。取り消しは発行済みだけ
 *   - API: 事務は申請・取り下げだけでき、承認・差し戻し・直接発行はできない
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

// ── Firestore の代わり（peerInvoices をメモリに持つ） ──
const store = new Map<string, Record<string, unknown>>()
let seq = 0
type Where = { f: string; v: unknown }
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/activity', () => ({ logActivity: async () => {} }))
vi.mock('@/lib/fsdb', () => ({
  registerMainWriteHook: () => {},
  collection: () => ({}),
  where: (f: string, _op: string, v: unknown): Where => ({ f, v }),
  query: (_c: unknown, ...ws: Where[]) => ws,
  getDocs: async (ws: Where[]) => {
    const docs = [...store.entries()]
      .filter(([, d]) => ws.every(w => d[w.f] === w.v))
      .map(([id, d]) => ({ id, data: () => structuredClone(d) }))
    return { docs, size: docs.length }
  },
  addDoc: async (_c: unknown, data: Record<string, unknown>) => { const id = `inv${++seq}`; store.set(id, structuredClone(data)); return { id } },
  doc: (_db: unknown, _c: string, id: string) => ({ id }),
  getDoc: async (ref: { id: string }) => ({ exists: () => store.has(ref.id), data: () => structuredClone(store.get(ref.id)) }),
  updateDoc: async (ref: { id: string }, data: Record<string, unknown>) => { store.set(ref.id, { ...store.get(ref.id), ...data }) },
}))

const ym = '202609'
const profile = (name: string, prefix: string) => ({
  name, nameEn: '', postal: '', address: '東京都清瀬市', tel: '', invoiceRegNo: 'T1',
  bank: { bankName: 'x', branch: 'x', accountType: '普通' as const, accountNo: '1', holder: 'x' }, invoicePrefix: prefix,
})
const main = {
  workers: [
    { id: 201, name: 'グエン', org: 'hfu', visa: 'jisshu', job: 'tobi', rate: 0, otMul: 1.25, hireDate: '2020-01-01', token: '' },
    { id: 50, name: '森田', org: 'hibi', visa: 'none', job: 'jimu', rate: 0, otMul: 1.25, hireDate: '2020-01-01', token: '' },
  ],
  sites: [{ id: 'own', name: '自社現場', start: '', end: '', foreman: 0, archived: false }],
  subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
  defaultRates: {}, mforeman: {}, nightDays: {},
  companyProfile: profile('株式会社日比建設', 'HC'),
  hfuInvoice: { profile: profile('エイチエフユナイテッド株式会社', 'HFU'), tobiRate: 30000, dokoRate: 0 },
} as unknown as MainData
const attD: Record<string, AttendanceEntry> = { [`own_201_${ym}_1`]: { w: 1 }, [`own_201_${ym}_2`]: { w: 1 } }
const args = { main, c: {} as never, attD, attSD: {}, ym, companyId: '__hfu_to_hibi__' }

beforeEach(() => { store.clear(); seq = 0 })

describe('申請 → 承認（lib/peer-invoice-store.ts）', () => {
  test('申請は承認待ち・番号なし → 承認で HFU-202609-01・月末日付で発行', async () => {
    const s = await import('@/lib/peer-invoice-store')
    const req = await s.requestPeerInvoice({ ...args, actor: '50' })
    expect(req.ok).toBe(true)
    if (!req.ok) return
    expect(req.record.status).toBe('pending')
    expect(req.record.no).toBe('')
    expect(req.record.requestedByName).toBe('森田')
    expect(req.record.total).toBe(66000)

    // 申請中は二重に申請・直接発行できない
    expect((await s.requestPeerInvoice({ ...args, actor: '50' })).ok).toBe(false)
    expect((await s.issuePeerInvoice({ ...args, actor: '1' })).ok).toBe(false)
    // 申請中は取り消し（void）の対象ではない
    expect((await s.voidPeerInvoice({ id: req.record.id, actor: '1' })).ok).toBe(false)

    const ap = await s.approvePeerInvoice({ main, id: req.record.id, actor: '1' })
    expect(ap.ok).toBe(true)
    if (!ap.ok) return
    expect(ap.record.status).toBe('issued')
    expect(ap.record.no).toBe('HFU-202609-01')
    expect(ap.record.issueDate).toBe('2026-09-30')
    expect(ap.record.issuedBy).toBe('1')

    // 処理済みの申請は、もう承認・差し戻しできない
    expect((await s.approvePeerInvoice({ main, id: req.record.id, actor: '1' })).ok).toBe(false)
    expect((await s.rejectPeerInvoice({ id: req.record.id, actor: '1' })).ok).toBe(false)
    // 発行済みがあるので再申請できない
    expect((await s.requestPeerInvoice({ ...args, actor: '50' })).ok).toBe(false)
  })

  test('差し戻し・取り下げのあとは、もう一度申請できる（番号は承認まで付かない）', async () => {
    const s = await import('@/lib/peer-invoice-store')
    const r1 = await s.requestPeerInvoice({ ...args, actor: '50' })
    if (!r1.ok) throw new Error(r1.error)
    const rj = await s.rejectPeerInvoice({ id: r1.record.id, actor: '1', reason: '人工を確認して' })
    expect(rj.ok && rj.record.status).toBe('rejected')
    expect(rj.ok && rj.record.rejectReason).toBe('人工を確認して')

    const r2 = await s.requestPeerInvoice({ ...args, actor: '50' })
    if (!r2.ok) throw new Error(r2.error)
    const wd = await s.rejectPeerInvoice({ id: r2.record.id, actor: '50', withdraw: true })
    expect(wd.ok && wd.record.status).toBe('withdrawn')

    const r3 = await s.requestPeerInvoice({ ...args, actor: '50' })
    if (!r3.ok) throw new Error(r3.error)
    const ap = await s.approvePeerInvoice({ main, id: r3.record.id, actor: '1' })
    // 差し戻し・取り下げの分は番号を消費しない
    expect(ap.ok && ap.record.no).toBe('HFU-202609-01')
  })
})

describe('API の権限（app/api/peer-invoice）', () => {
  test('事務は申請・取り下げだけ。承認・差し戻し・直接発行・取り消しは 403', async () => {
    vi.doMock('@/lib/auth', () => ({
      checkApiAuth: async () => true,
      getApiAuthUser: async () => ({ authorized: true, actor: 50 }),
      requireExecutiveAuth: async () => new Response(JSON.stringify({ error: 'x' }), { status: 403 }),
      getApiRole: async () => ({ role: 'jimu', workerId: 50, foremanSites: [] }),
    }))
    vi.doMock('@/lib/compute', async orig => ({
      ...(await orig<typeof import('@/lib/compute')>()),
      getMainData: async () => main,
      getMultiMonthAttData: async () => ({ d: attD, sd: {} }),
      compute: () => ({}),
    }))
    vi.resetModules()
    const { POST } = await import('@/app/api/peer-invoice/route')
    const call = (body: unknown) => POST(new Request('http://x/api/peer-invoice', { method: 'POST', body: JSON.stringify(body) }) as never)

    for (const action of ['issue', 'approve', 'reject', 'void']) {
      expect((await call({ action, ym, companyId: '__hfu_to_hibi__', id: 'inv1' })).status).toBe(403)
    }
    const res = await call({ action: 'request', ym, companyId: '__hfu_to_hibi__' })
    expect(res.status).toBe(200)
    const { record } = await res.json()
    expect(record.status).toBe('pending')
    expect((await call({ action: 'withdraw', id: record.id })).status).toBe(200)
    vi.doUnmock('@/lib/auth')
    vi.doUnmock('@/lib/compute')
  })
})

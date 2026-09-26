import { describe, test, expect, vi } from 'vitest'

/**
 * 笹塚が保存できなかった件（2026-09-15）の再発防止。
 * 通勤データを持たない現場を、画面の空の通勤フォーム付きで保存すると commute: undefined を書こうとして
 * Firestore に拒否されていた。書き込み内容に undefined が含まれないことを確認する。
 */
const written: unknown[] = []
const mainData = {
  sites: [{ id: 'sasazuka', name: '笹塚', start: '2023-12', end: '2027-03', foreman: 3, ownerId: 'self', siteType: 'direct', client: '日比建設',
    rates: [{ from: '202510', tobiRate: 36000, dokoRate: 28000 }] }],
  subcons: [
    { id: 'obayashi', name: '株式会社 大林組', roles: ['gc'] },
    { id: 'yamaoka', name: '山岡建設工業 株式会社', roles: ['prime', 'peer'] },
  ],
  assign: {}, mforeman: {},
}
vi.mock('@/lib/auth', () => ({ checkApiAuth: async () => true, requireCap: async () => null }))
vi.mock('@/lib/activity', () => ({ logActivity: async () => {} }))
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => structuredClone(mainData) }),
  updateDoc: async (_ref: unknown, data: unknown) => { written.push(data) },
}))

function hasUndefined(v: unknown): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.some(hasUndefined)
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasUndefined)
  return false
}

describe('/api/sites update', () => {
  test('通勤データの無い現場を空の通勤フォーム付きで保存しても undefined を書かず、元請・一次が保存される', async () => {
    const { POST } = await import('@/app/api/sites/route')
    const body = {
      action: 'update', id: 'sasazuka', name: '笹塚', workType: '', gcId: 'obayashi', primeId: 'yamaoka', ownerId: 'self',
      start: '2023-12', end: '2027-03', foreman: '3', archived: false, tobiRate: 36000, dokoRate: 28000,
      rates: [{ from: '202510', tobiRate: 36000, dokoRate: 28000 }], subconRates: {},
      workSchedule: { startTime: '08:00', endTime: '17:00' }, commute: { address: '', samples: [] },
    }
    const req = new Request('http://x/api/sites', { method: 'POST', body: JSON.stringify(body) })
    const res = await POST(req as unknown as import('next/server').NextRequest)
    expect(res.status).toBe(200)
    const data = written[0] as { sites: Record<string, unknown>[] }
    expect(hasUndefined(data)).toBe(false)
    const s = data.sites.find(x => x.id === 'sasazuka')!
    expect(s.gcId).toBe('obayashi')
    expect(s.primeId).toBe('yamaoka')
    expect(s.client).toBe('山岡建設工業 株式会社')
    expect('commute' in s).toBe(false)
  })
})

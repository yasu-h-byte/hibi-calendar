/**
 * 操作ログの保ち方（lib/activity.ts・2026-10-02 総合点検）
 *   - 書くときは addDoc だけ（旧: 1件ごとに550件読んで消していた）
 *   - お金・マスタの記録は auditTrail にも残る。出面の記録は残らない
 *   - 間引きは cron: 出面の記録は新しい N 件、それ以外は別枠で M 件
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

const activity: { id: string; data: Record<string, unknown> }[] = []
const audit = new Map<string, Record<string, unknown>>()
let reads = 0
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  collection: (_db: unknown, name: string) => ({ name }),
  doc: (_db: unknown, coll: string, id: string) => ({ coll, id }),
  addDoc: async (_c: unknown, data: Record<string, unknown>) => { const id = `a${activity.length + 1}`; activity.push({ id, data }); return { id } },
  setDoc: async (ref: { coll: string; id: string }, data: Record<string, unknown>) => { if (ref.coll === 'auditTrail') audit.set(ref.id, data) },
  query: (c: unknown, ...rest: unknown[]) => ({ c, rest }),
  orderBy: () => ({}), limit: (n: number) => ({ limit: n }), where: () => ({}),
  getDocs: async (q: { rest: { limit?: number }[] }) => {
    reads++
    const lim = q.rest.find(r => typeof (r as { limit?: number }).limit === 'number')?.limit ?? Infinity
    const docs = [...activity].sort((a, b) => String(b.data.timestamp).localeCompare(String(a.data.timestamp))).slice(0, lim)
      .map(d => ({ id: d.id, data: () => d.data, ref: d.id }))
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb: (d: unknown) => void) => docs.forEach(cb) }
  },
  deleteDoc: async (id: string) => { const i = activity.findIndex(a => a.id === id); if (i >= 0) activity.splice(i, 1) },
}))

beforeEach(() => { activity.length = 0; audit.clear(); reads = 0 })

describe('logActivity', () => {
  test('書くだけで読まない。請求書・単価は auditTrail にも残り、出面の記録は残らない', async () => {
    const { logActivity, isDurableAction, isNoisyAction } = await import('@/lib/activity')
    await logActivity('1', 'attendance.gridEdit', 'x')
    await logActivity('1', 'peerInvoice.issue', 'HC-202609-01')
    await logActivity('1', 'billing.update', '請求額')
    await logActivity('1', 'rates.site', '単価')
    expect(reads).toBe(0)
    expect(activity.length).toBe(4)
    expect([...audit.values()].map(a => a.action).sort()).toEqual(['billing.update', 'peerInvoice.issue', 'rates.site'])
    expect(isDurableAction('subcon.delete')).toBe(true)
    expect(isDurableAction('attendance.gridEdit')).toBe(false)
    expect(isNoisyAction('attendance.backfill')).toBe(true)
    expect(isNoisyAction('leave.grant')).toBe(false)
  })
})

describe('pruneActivityLog', () => {
  test('出面の記録は新しい noisyKeep 件、それ以外は importantKeep 件を残す（出面に押し出されない）', async () => {
    const { pruneActivityLog } = await import('@/lib/activity')
    // 古い順に: 請求の記録 5件 → 出面の記録 20件 → 請求の記録 2件
    let t = 0
    const push = (action: string) => activity.push({ id: `a${activity.length + 1}`, data: { action, timestamp: `2026-10-01T00:00:${String(t++).padStart(2, '0')}Z` } })
    for (let i = 0; i < 5; i++) push('peerInvoice.issue')
    for (let i = 0; i < 20; i++) push('attendance.gridEdit')
    for (let i = 0; i < 2; i++) push('billing.update')
    const n = await pruneActivityLog({ noisyKeep: 10, importantKeep: 100, maxDelete: 100 })
    expect(n).toBe(10)
    expect(activity.filter(a => a.data.action === 'attendance.gridEdit').length).toBe(10)
    // 請求の記録は古いものも全部残る
    expect(activity.filter(a => a.data.action !== 'attendance.gridEdit').length).toBe(7)
  })
  test('重要な記録も上限を超えた古い分は消える・1回の削除は上限まで', async () => {
    const { pruneActivityLog } = await import('@/lib/activity')
    for (let i = 0; i < 30; i++) activity.push({ id: `a${i + 1}`, data: { action: 'site.update', timestamp: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` } })
    expect(await pruneActivityLog({ noisyKeep: 10, importantKeep: 20, maxDelete: 3 })).toBe(3)
    expect(activity.length).toBe(27)
  })
})

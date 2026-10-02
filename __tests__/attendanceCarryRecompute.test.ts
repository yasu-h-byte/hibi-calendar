import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * setAttendanceEntry → 次期繰越の追随再計算（recomputeNextCarryOver）の呼び出し。
 *
 * 2026-10-02 まで閉じ括弧のずれで再計算が「deleteFields なし」の経路にしか入っておらず、
 * deleteFields を渡す実際の呼び出し元（grid/staff/foreman/leave-request/leave）では走っていなかった。
 * 両方の経路で走ることを固定する。
 */
const writes: { kind: string; arg: unknown }[] = []
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: (_db: unknown, _c: string, id: string) => id,
  getDoc: async () => ({ exists: () => true, data: () => ({}) }),
  setDoc: async (_ref: unknown, data: unknown) => { writes.push({ kind: 'set', arg: data }) },
  updateDoc: async (_ref: unknown, data: unknown) => { writes.push({ kind: 'update', arg: data }) },
  deleteField: () => '__delete__',
  collection: () => null, getDocs: async () => ({ docs: [] }), query: () => null, where: () => null,
}))
vi.mock('@/lib/firestore-safe', () => ({ ensureDocExists: async () => {} }))
vi.mock('@/lib/compute', () => ({
  invalidateAttDataCache: () => {},
  getMainData: async () => ({ sites: [], workers: [], plData: {} }),
}))
const recompute = vi.fn(async () => ({ updated: false }))
vi.mock('@/lib/leave-carry', () => ({ recomputeNextCarryOver: recompute }))

import { setAttendanceEntry, computeAttendanceDeleteFields } from '@/lib/attendance'

beforeEach(() => { recompute.mockClear(); writes.length = 0 })

describe('setAttendanceEntry の繰越再計算', () => {
  test('有給を書く（deleteFields あり＝実際の呼び出し方）→ 再計算する', async () => {
    const entry = { w: 0, p: 1, s: 'staff' }
    await setAttendanceEntry('siteA', 101, '202609', 5, entry, { deleteFields: computeAttendanceDeleteFields(entry) })
    expect(writes[0].kind).toBe('update')
    expect(recompute).toHaveBeenCalledWith(101, '2026-09-05')
  })
  test('有給を出勤に変える（deleteFields に p）→ 再計算する', async () => {
    const entry = { w: 1, s: 'staff' }
    await setAttendanceEntry('siteA', 101, '202609', 12, entry, { deleteFields: computeAttendanceDeleteFields(entry) })
    expect(recompute).toHaveBeenCalledWith(101, '2026-09-12')
  })
  test('有給を書く（deleteFields なし）→ 再計算する', async () => {
    await setAttendanceEntry('siteA', 101, '202610', 1, { w: 0, p: 1 })
    expect(writes[0].kind).toBe('set')
    expect(recompute).toHaveBeenCalledWith(101, '2026-10-01')
  })
  test('p に触れない保存 → 再計算しない', async () => {
    await setAttendanceEntry('siteA', 101, '202610', 1, { w: 1 })
    await setAttendanceEntry('siteA', 101, '202610', 2, { w: 1 }, { deleteFields: ['r'] })
    expect(recompute).not.toHaveBeenCalled()
  })
})

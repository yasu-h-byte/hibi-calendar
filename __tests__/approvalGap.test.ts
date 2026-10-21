import { describe, test, expect, vi, beforeEach } from 'vitest'

/** attendanceApprovals のつもりのデータ（ID = `${siteId}_${ym}_${day}`） */
const DATA: Record<string, { foreman?: unknown; final?: unknown }> = {
  ihi_202609_1: { foreman: {}, final: {} },
  ihi_202609_2: { foreman: {} },
  ihi_tekkotsu_202609_3: { foreman: {}, final: {} },   // 子の画面で承認した古い記録
  ihi_202610_5: { foreman: {} },
}
const calls = { getDoc: 0, getDocs: 0 }
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: (_db: unknown, _c: string, id: string) => id,
  getDoc: async (id: string) => {
    calls.getDoc++
    return { exists: () => !!DATA[id], data: () => DATA[id] }
  },
  // ID の前方一致の範囲クエリ（where('__name__', '>=', prefix) / where('__name__', '<', prefix + '')）
  collection: () => ({}),
  where: (_f: string, op: string, v: string) => ({ op, v }),
  query: (_c: unknown, ...cs: { op: string; v: string }[]) => cs,
  getDocs: async (cs: { op: string; v: string }[]) => {
    calls.getDocs++
    const from = cs.find(c => c.op === '>=')!.v
    const to = cs.find(c => c.op === '<')!.v
    const docs = Object.keys(DATA).filter(id => id >= from && id < to).map(id => ({ id, data: () => DATA[id] }))
    return { forEach: (cb: (d: { id: string; data: () => unknown }) => void) => docs.forEach(cb) }
  },
}))
import { approvalGap, describeApprovalGap, invalidateApprovalCache } from '@/lib/approval-gap'

beforeEach(() => { calls.getDoc = 0; calls.getDocs = 0 })

describe('承認のそろい具合（請求書・本人確認で共通）', () => {
  const sites = [{ id: 'ihi' }, { id: 'ihi_tekkotsu', parentId: 'ihi' }]
  test('職長承認・最終承認の無い日を返す。工種サイトの子で承認した記録も数える', async () => {
    const gap = await approvalGap(sites, '202609', [1, 2, 3, 4].map(day => ({ familyId: 'ihi', day })), { fresh: true })
    expect(gap.foremanMissing).toEqual([{ familyId: 'ihi', day: 4 }])
    expect(gap.finalMissing).toEqual([{ familyId: 'ihi', day: 2 }, { familyId: 'ihi', day: 4 }])
    expect(describeApprovalGap(gap, () => 'IHI')).toBe('職長承認がない日: IHI 4日\n最終承認がない日: IHI 2・4日')
  })
  test('3 日以上ある現場は「現場×月」の範囲クエリ 1 回で読み、日ごとの getDoc はしない（2026-10-21）', async () => {
    for (const d of [1, 2, 3, 4, 5]) for (const id of ['ihi', 'ihi_tekkotsu']) invalidateApprovalCache(`${id}_202609_${d}`)
    await approvalGap(sites, '202609', [1, 2, 3, 4, 5].map(day => ({ familyId: 'ihi', day })), { fresh: true })
    expect(calls.getDocs).toBe(2)   // 親 ihi と子 ihi_tekkotsu で 1 回ずつ
    expect(calls.getDoc).toBe(0)
    // 温まったキャッシュは読み直さない（fresh でなければ）
    await approvalGap(sites, '202609', [1, 2, 3].map(day => ({ familyId: 'ihi', day })))
    expect(calls.getDocs).toBe(2)
    expect(calls.getDoc).toBe(0)
  })
  test('1〜2 日だけなら従来どおり日ごとに読む。別の月の記録は拾わない', async () => {
    invalidateApprovalCache('ihi_202610_5'); invalidateApprovalCache('ihi_tekkotsu_202610_5')
    const gap = await approvalGap(sites, '202610', [{ familyId: 'ihi', day: 5 }], { fresh: true })
    expect(calls.getDocs).toBe(0)
    expect(calls.getDoc).toBe(2)
    expect(gap.foremanMissing).toEqual([])
    expect(gap.finalMissing).toEqual([{ familyId: 'ihi', day: 5 }])
  })
})

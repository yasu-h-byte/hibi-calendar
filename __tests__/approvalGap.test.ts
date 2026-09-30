import { describe, test, expect, vi } from 'vitest'
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: (_db: unknown, _c: string, id: string) => id,
  getDoc: async (id: string) => {
    const data: Record<string, { foreman?: unknown; final?: unknown }> = {
      ihi_202609_1: { foreman: {}, final: {} },
      ihi_202609_2: { foreman: {} },
      ihi_tekkotsu_202609_3: { foreman: {}, final: {} },   // 子の画面で承認した古い記録
    }
    return { exists: () => !!data[id], data: () => data[id] }
  },
}))
import { approvalGap, describeApprovalGap } from '@/lib/approval-gap'

describe('承認のそろい具合（請求書・本人確認で共通）', () => {
  const sites = [{ id: 'ihi' }, { id: 'ihi_tekkotsu', parentId: 'ihi' }]
  test('職長承認・最終承認の無い日を返す。工種サイトの子で承認した記録も数える', async () => {
    const gap = await approvalGap(sites, '202609', [1, 2, 3, 4].map(day => ({ familyId: 'ihi', day })))
    expect(gap.foremanMissing).toEqual([{ familyId: 'ihi', day: 4 }])
    expect(gap.finalMissing).toEqual([{ familyId: 'ihi', day: 2 }, { familyId: 'ihi', day: 4 }])
    expect(describeApprovalGap(gap, () => 'IHI')).toBe('職長承認がない日: IHI 4日\n最終承認がない日: IHI 2・4日')
  })
})

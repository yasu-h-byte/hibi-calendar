import { describe, test, expect } from 'vitest'
import { isSupportSite } from '@/lib/companies'
import { roleCan } from '@/lib/permissions'

const sites = [
  { id: 'ihi', ownerId: 'self', siteType: 'direct' as const },
  { id: 'kawasaki', ownerId: 'hatakeyama', siteType: 'support' as const },
  { id: 'kawasaki_s', ownerId: 'hatakeyama', parentId: 'kawasaki' },
  { id: 'old', siteType: 'support' as const },
]
describe('応援現場の判定', () => {
  test('担当の二次が自社以外なら応援現場', () => {
    expect(isSupportSite(sites[0], sites)).toBe(false)
    expect(isSupportSite(sites[1], sites)).toBe(true)
  })
  test('工種サイト（鉄骨）は親の請負体制で判定', () => {
    expect(isSupportSite(sites[2], sites)).toBe(true)
  })
  test('ownerId の無い旧データは siteType どおり', () => {
    expect(isSupportSite(sites[3], sites)).toBe(true)
    expect(isSupportSite(undefined, sites)).toBe(false)
  })
})
describe('応援現場の出面入力の権限', () => {
  test('事業責任者は応援現場だけ入力できる（自社現場の入力権限は無い）', () => {
    expect(roleCan('approver', 'attendance.inputSupport')).toBe(true)
    expect(roleCan('approver', 'attendance.input')).toBe(false)
    expect(roleCan('foreman', 'attendance.inputSupport')).toBe(false)
  })
})

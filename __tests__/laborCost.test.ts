import { describe, test, expect } from 'vitest'
import { employerWelfare, laborCostDelta, DEFAULT_WELFARE_RATES as R, PENSION_MONTHLY_CAP } from '@/lib/labor-cost'

describe('法定福利費（会社負担）の年額', () => {
  test('39歳は介護保険なし・40歳はあり', () => {
    const a39 = employerWelfare(6_000_000, 39, R)
    const a40 = employerWelfare(6_000_000, 40, R)
    expect(a40 - a39).toBe(Math.round(6_000_000 * R.care / 100))
  })
  test('厚生年金は月65万円で頭打ち（年収900万と1000万の差は健康保険・雇用保険ぶんだけ）', () => {
    const lo = employerWelfare(9_000_000, 30, R)
    const hi = employerWelfare(10_000_000, 30, R)
    expect(9_000_000 / 12).toBeGreaterThan(PENSION_MONTHLY_CAP)
    expect(hi - lo).toBe(Math.round(1_000_000 * (R.health + R.childSupport + R.employment) / 100))
  })
  test('0円なら0', () => { expect(employerWelfare(0, 50, R)).toBe(0) })
})

describe('1人分の新旧比較', () => {
  test('日額 21,300 → 22,460・310日・50歳', () => {
    const d = laborCostDelta(21_300, 22_460, 310, 50, R)
    expect(d.payIncrease).toBe(1_160 * 310)
    expect(d.totalIncrease).toBe(d.payIncrease + d.welfareIncrease)
    expect(d.welfareIncrease).toBeGreaterThan(0)
  })
})

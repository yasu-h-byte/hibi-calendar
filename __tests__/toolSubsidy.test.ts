import { describe, test, expect } from 'vitest'
import {
  isToolSubsidyEligible, toolSubsidyCompanyAmount, purchaseBudgetUse, purchasesBudgetUse, purchasesCompanyAmount,
  toolSubsidyError, nextToolSubsidyDate,
} from '@/lib/tool-subsidy'
import { toolBudgetCarryIn } from '@/lib/tool-budget-period'

describe('会社半額負担の額', () => {
  test('半額（上限内）', () => {
    expect(toolSubsidyCompanyAmount('impact', 40000)).toBe(20000)
  })
  test('1円未満は会社負担を切り上げ（本人に有利）', () => {
    expect(toolSubsidyCompanyAmount('impact', 39999)).toBe(20000)
  })
  test('上限 25,000円', () => {
    expect(toolSubsidyCompanyAmount('impact', 60000)).toBe(25000)
    expect(toolSubsidyCompanyAmount('impact', 50000)).toBe(25000)
  })
})

describe('枠から引く額', () => {
  test('半額負担なしは購入額そのまま', () => {
    expect(purchaseBudgetUse({ amount: 3500 })).toBe(3500)
  })
  test('半額負担ありは本人負担だけ', () => {
    expect(purchaseBudgetUse({ amount: 60000, subsidy: { kind: 'impact', company: 25000 } })).toBe(35000)
  })
  test('合計', () => {
    const ps = [{ amount: 3500 }, { amount: 40000, subsidy: { kind: 'impact' as const, company: 20000 } }]
    expect(purchasesBudgetUse(ps)).toBe(23500)
    expect(purchasesCompanyAmount(ps)).toBe(20000)
  })
})

describe('対象者・対象日・2年に1回', () => {
  test('技能実習・特定技能は対象、日本人は対象外', () => {
    expect(isToolSubsidyEligible('jisshu2')).toBe(true)
    expect(isToolSubsidyEligible('tokutei1')).toBe(true)
    expect(isToolSubsidyEligible('none')).toBe(false)
    expect(toolSubsidyError({ kind: 'impact', visa: 'none', date: '2026-10-05', others: [] })).toMatch(/外国人/)
  })
  test('2026-10-01 より前の購入は対象外（10月の分はさかのぼって可）', () => {
    expect(toolSubsidyError({ kind: 'impact', visa: 'jisshu1', date: '2026-09-30', others: [] })).toMatch(/以降/)
    expect(toolSubsidyError({ kind: 'impact', visa: 'jisshu1', date: '2026-10-01', others: [] })).toBeNull()
  })
  test('前回から2年たつまでは使えない', () => {
    const others = [{ date: '2026-10-05', amount: 40000, subsidy: { kind: 'impact' as const, company: 20000 } }]
    expect(nextToolSubsidyDate('impact', '2026-10-05')).toBe('2028-10-05')
    expect(toolSubsidyError({ kind: 'impact', visa: 'tokutei1', date: '2028-10-04', others })).toMatch(/2年に1回/)
    expect(toolSubsidyError({ kind: 'impact', visa: 'tokutei1', date: '2028-10-05', others })).toBeNull()
  })
  test('さかのぼって前の日付で入れる場合も、あとの購入と2年あいていること', () => {
    const others = [{ date: '2027-03-01', amount: 40000, subsidy: { kind: 'impact' as const, company: 20000 } }]
    expect(toolSubsidyError({ kind: 'impact', visa: 'tokutei1', date: '2026-10-10', others })).toMatch(/2年に1回/)
  })
  test('半額負担なしの購入は回数に数えない', () => {
    const others = [{ date: '2026-10-05', amount: 40000 }]
    expect(toolSubsidyError({ kind: 'impact', visa: 'tokutei1', date: '2026-11-01', others })).toBeNull()
  })
})

describe('繰越にも本人負担だけが効く', () => {
  test('1期目に半額負担のインパクトを買っても、会社負担分は繰越を減らさない', () => {
    // 起点 2025-10-08 → 1期目 2025-10-08〜2026-10-07（2026-09-30 以降に終わるので繰り越す）
    const records = {
      '201_2025-10-08': { budget: 30000, purchases: [{ amount: 40000, subsidy: { kind: 'impact' as const, company: 20000 } }] },
    }
    // 本人負担 20,000 → 余り 10,000 を繰り越す
    expect(toolBudgetCarryIn('2025-10-08', 2, 201, records, 30000)).toBe(10000)
  })
})

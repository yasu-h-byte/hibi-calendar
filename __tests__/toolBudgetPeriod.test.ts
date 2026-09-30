import { describe, test, expect } from 'vitest'
import { getCurrentPeriod, getPeriodByIndex, toolBudgetAnchorOf } from '@/lib/tool-budget-period'

const d = (s: string) => new Date(s + 'T00:00:00')
describe('道具代の期間', () => {
  test('起点 2025-10-06 → 2026-09-30 は 2025-10-06〜2026-10-05（1年目）', () => {
    expect(getCurrentPeriod('2025-10-06', d('2026-09-30'))).toEqual({ start: '2025-10-06', end: '2026-10-05', index: 1 })
  })
  test('期間の最終日の翌日から次の期間', () => {
    expect(getCurrentPeriod('2025-10-01', d('2026-10-01'))).toEqual({ start: '2026-10-01', end: '2027-09-30', index: 2 })
  })
  test('起点が先なら「今の期間」は無い', () => {
    expect(getCurrentPeriod('2026-10-26', d('2026-09-30'))).toBeNull()
    expect(getPeriodByIndex('2026-10-26', 1)).toEqual({ start: '2026-10-26', end: '2027-10-25', index: 1 })
  })
  test('うるう日の起点は翌年 2/28', () => {
    expect(getCurrentPeriod('2024-02-29', d('2025-03-01'))?.start).toBe('2025-02-28')
  })
})
describe('起点日', () => {
  test('設定があればそれ', () => {
    expect(toolBudgetAnchorOf({ id: 101, visa: 'tokutei1', hireDate: '2016-10-01' }, { '101': '2026-01-13' })).toEqual({ anchor: '2026-01-13', fromHireDate: false })
  })
  test('ベトナム人で未設定なら入社日', () => {
    expect(toolBudgetAnchorOf({ id: 207, visa: 'jisshu1', hireDate: '2026-08-01' }, {})).toEqual({ anchor: '2026-08-01', fromHireDate: true })
  })
  test('日本人は入社日で補わない', () => {
    expect(toolBudgetAnchorOf({ id: 12, visa: 'none', hireDate: '2026-06-01' }, {})).toEqual({ anchor: null, fromHireDate: false })
  })
})

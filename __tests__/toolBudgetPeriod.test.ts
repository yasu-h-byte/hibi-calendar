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

import { carryOut, toolBudgetCarryIn } from '@/lib/tool-budget-period'
describe('道具代の繰り越し', () => {
  test('余りは翌期へ・繰越分から先に使う', () => {
    expect(carryOut(30000, 0, 20466)).toBe(9534)          // ラップ
    expect(carryOut(30000, 9534, 5000)).toBe(30000)       // 繰越だけで足りた → 予算は丸ごと翌期へ（繰越の残り4,534は消える）
    expect(carryOut(30000, 9534, 20000)).toBe(19534)      // 繰越9,534を使い切り、予算から10,466
  })
  test('使いすぎはマイナスで翌期へ', () => {
    expect(carryOut(30000, 0, 33666)).toBe(-3666)         // フウ
    expect(carryOut(30000, -3666, 26334)).toBe(0)
    expect(carryOut(30000, -3666, 20000)).toBe(6334)
  })
  test('運用開始（2026-09-30）より前に終わった期間は繰り越さない', () => {
    const recs = { '105_2025-09-07': { budget: 30000, purchases: [] } }
    // アイン: 2025-09-07〜2026-09-06 は 9/30 より前に終わる → 2期目（2026-09-07〜）への繰越は0
    expect(toolBudgetCarryIn('2025-09-07', 2, 105, recs, 30000)).toBe(0)
  })
  test('9/30 に終わる期間の余りは翌期へ・フウのマイナスは次の期間へ', () => {
    expect(toolBudgetCarryIn('2025-10-01', 2, 202, { '202_2025-10-01': { budget: 30000, purchases: [{ amount: 20466 }] } }, 30000)).toBe(9534)
    expect(toolBudgetCarryIn('2026-01-13', 2, 101, { '101_2026-01-13': { budget: 30000, purchases: [{ amount: 33666 }] } }, 30000)).toBe(-3666)
  })
  test('記録の無い期間は予算を丸ごと翌期へ（1回だけ）', () => {
    expect(toolBudgetCarryIn('2026-05-14', 2, 107, {}, 30000)).toBe(30000)
    expect(toolBudgetCarryIn('2026-05-14', 3, 107, {}, 30000)).toBe(30000)   // 2期目も使わなければ、繰越分は消えて予算3万だけ
  })
})

import { periodIndexOf } from '@/lib/tool-budget-period'
describe('期間の番号', () => {
  test('起点日から数える', () => {
    expect(periodIndexOf('2025-10-01', '2025-10-01')).toBe(1)
    expect(periodIndexOf('2025-10-01', '2026-10-01')).toBe(2)
    expect(periodIndexOf('2025-10-01', '2026-09-30')).toBeNull()
  })
})

describe('点検（2026-09-30）: 日本時間・2/29 起点', () => {
  test('文字列の基準日（日本時間の今日）で判定する', () => {
    expect(getCurrentPeriod('2025-10-01', '2026-10-01')).toEqual({ start: '2026-10-01', end: '2027-09-30', index: 2 })
    expect(getCurrentPeriod('2025-10-01', '2026-09-30')?.index).toBe(1)
    expect(getCurrentPeriod('2026-10-01', '2026-10-01')?.index).toBe(1)
  })
  test('2/29 起点でも getPeriodByIndex と同じ区切り（2028年に戻る）', () => {
    const p = getCurrentPeriod('2024-02-29', '2028-03-01')
    expect(p).toEqual(getPeriodByIndex('2024-02-29', p!.index))
    expect(p?.start).toBe('2028-02-29')
  })
})

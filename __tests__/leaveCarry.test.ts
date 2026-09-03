import { describe, test, expect } from 'vitest'
import { pickCarryTarget } from '@/lib/leave-carry'

/**
 * 次期繰越の追随再計算: 「どのレコードの繰越を書き換えるか」の選択（純関数）
 */
describe('pickCarryTarget', () => {
  const recs = [
    { fy: '2024', grantDate: '2024-04-01', grantDays: 11, _archived: true },
    { fy: '2025', grantDate: '2025-09-16', grantDays: 18 },
    { fy: '2026', grantDate: '2026-09-16', grantDays: 20, carryOver: 11 },
  ]
  test('前期の日付 → 前期＝2025、次期＝2026', () => {
    expect(pickCarryTarget(recs, '2026-09-01')).toEqual({ prevIdx: 1, nextIdx: 2 })
  })
  test('次期の日付（まだ次々期が無い）→ null', () => {
    expect(pickCarryTarget(recs, '2026-10-01')).toBeNull()
  })
  test('付与前の日付 → null', () => {
    expect(pickCarryTarget(recs, '2025-01-01')).toBeNull()
  })
  test('時効処理済みレコードは次期候補にしない', () => {
    const r2 = [
      { fy: '2025', grantDate: '2025-04-01', grantDays: 12 },
      { fy: '2026', grantDate: '2026-04-01', grantDays: 14, _archived: true },
    ]
    expect(pickCarryTarget(r2, '2025-06-01')).toBeNull()
  })
})

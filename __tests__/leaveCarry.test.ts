import { describe, test, expect } from 'vitest'
import { pickCarryTarget, resolveCarryTarget } from '@/lib/leave-carry'

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

/**
 * 事前チェックと本処理で共通の判定（2026-10-02）。
 * 「書き換える次期が無い」大半のケースをキャッシュの main だけで抜けるための判定。
 */
describe('resolveCarryTarget', () => {
  const workers = [{ id: 101, visa: 'tokutei' }, { id: 1, visa: 'none' }, { id: 2 }]
  const recs = [
    { fy: '2025', grantDate: '2025-09-16', grantDays: 18 },
    { fy: '2026', grantDate: '2026-09-16', grantDays: 20, carryOver: 11 },
  ]
  test('前期の日付・次期あり → 対象を返す', () => {
    const r = resolveCarryTarget(workers, { '101': recs }, 101, '2026-09-01')
    expect(r).toMatchObject({ prevIdx: 0, nextIdx: 1 })
  })
  test('次期が無い日付 → no next record', () => {
    expect(resolveCarryTarget(workers, { '101': recs }, 101, '2026-10-01')).toEqual({ reason: 'no next record' })
  })
  test('日本人（visa none / 未設定）→ japanese', () => {
    expect(resolveCarryTarget(workers, { '1': recs }, 1, '2026-09-01')).toEqual({ reason: 'japanese' })
    expect(resolveCarryTarget(workers, { '2': recs }, 2, '2026-09-01')).toEqual({ reason: 'japanese' })
  })
  test('居ない人 → worker not found', () => {
    expect(resolveCarryTarget(workers, {}, 999, '2026-09-01')).toEqual({ reason: 'worker not found' })
  })
  test('次期が legacy → 触らない', () => {
    const r2 = [recs[0], { ...recs[1], method: 'legacy' }]
    expect(resolveCarryTarget(workers, { '101': r2 }, 101, '2026-09-01')).toEqual({ reason: 'legacy record' })
  })
})

import { describe, it, expect } from 'vitest'
import { grantPeriodsOverlap } from '@/lib/leave-compute'

/**
 * 付与期間の重複判定（二重付与ガードの中核）
 *
 * 背景（2026-08-04 新規付与まわりの点検）:
 *   旧ガード isSameFiscalYear は「target が既存期間の中にあるか」の一方向のみで、
 *   既存の付与日より前へ遡る付与（期間が重なる）を止められなかった。
 *   年途中入社の日本人は初回付与が 10/1 統一起点とズレるため、初回付与の直後に
 *   付与判定が「10/1 未実施」と誤検知 → 実行ガードも素通り → 二重付与、が成立していた。
 */
describe('grantPeriodsOverlap', () => {
  it('同じ付与日は重なる', () => {
    expect(grantPeriodsOverlap('2026-10-01', '2026-10-01')).toBe(true)
  })

  it('ちょうど1年後（通常の年次サイクル）は重ならない', () => {
    expect(grantPeriodsOverlap('2025-09-16', '2026-09-16')).toBe(false)
    expect(grantPeriodsOverlap('2025-10-01', '2026-10-01')).toBe(false)
  })

  it('1年未満の間隔は重なる（前方向）', () => {
    expect(grantPeriodsOverlap('2026-10-01', '2027-09-30')).toBe(true)
  })

  it('遡り付与も重なる（後方向 — 旧 isSameFiscalYear が見逃していた向き）', () => {
    // 既存 2026-07-01 に対し、過去の 2025-10-01 を遡って付与しようとするケース。
    // [2025-10-01, 2026-10-01) と [2026-07-01, 2027-07-01) は 7〜10月が重なる
    expect(grantPeriodsOverlap('2025-10-01', '2026-07-01')).toBe(true)
  })

  it('濱上さんシナリオ: 初回12/1付与の直後の「10/1未実施」誤検知を防ぐ', () => {
    // 入社 2026-06-01 → 初回付与 2026-12-01。
    // 10/1 統一起点の判定が期待する 2026-10-01 とは期間が重なる → 付与済み扱いになる
    expect(grantPeriodsOverlap('2026-12-01', '2026-10-01')).toBe(true)
  })

  it('前期間の満了後は重ならない（統一起点への合流は満了後に可能）', () => {
    // 初回 2026-12-01 の期間は 2027-12-01 まで。2027-12-01 の付与は重ならない
    expect(grantPeriodsOverlap('2026-12-01', '2027-12-01')).toBe(false)
  })

  it('空文字は重ならない扱い', () => {
    expect(grantPeriodsOverlap('', '2026-10-01')).toBe(false)
    expect(grantPeriodsOverlap('2026-10-01', '')).toBe(false)
  })

  it('うるう年境界: 2/29 付与も文字列演算で安全（2/28 終端）', () => {
    // addMonthsSafe が 2024-02-29 + 12ヶ月 → 2025-02-28 を返す前提の確認
    expect(grantPeriodsOverlap('2024-02-29', '2025-02-28')).toBe(false)
    expect(grantPeriodsOverlap('2024-02-29', '2025-02-27')).toBe(true)
  })
})

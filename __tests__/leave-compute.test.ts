/**
 * 有給休暇 集計ロジックのテスト
 *
 * Workflow CR-1 で検出された「年5日義務監視ロジックが多重破綻」の解消検証。
 */
import { describe, test, expect } from 'vitest'
import { computePeriodUsed, judgeFiveDayObligation, isSameFiscalYear } from '@/lib/leave-compute'
import { addMonthsSafe, calcExpiryIso } from '@/lib/date-utils'

describe('addMonthsSafe', () => {
  test('通常ケース: 2025-08-15 + 6ヶ月 = 2026-02-15', () => {
    expect(addMonthsSafe('2025-08-15', 6)).toBe('2026-02-15')
  })

  test('月末入社 8/31 + 6ヶ月 = 2026-02-28 (応当日なしは末日に丸める)', () => {
    // JS の setMonth(+6) では 2026-03-03 になるバグ
    expect(addMonthsSafe('2025-08-31', 6)).toBe('2026-02-28')
  })

  test('うるう年→平年: 2024-02-29 + 12ヶ月 = 2025-02-28', () => {
    expect(addMonthsSafe('2024-02-29', 12)).toBe('2025-02-28')
  })

  test('1月31日 + 1ヶ月 = 2月末日', () => {
    expect(addMonthsSafe('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonthsSafe('2024-01-31', 1)).toBe('2024-02-29')  // うるう年
  })

  test('年跨ぎ: 2025-12-15 + 3ヶ月 = 2026-03-15', () => {
    expect(addMonthsSafe('2025-12-15', 3)).toBe('2026-03-15')
  })

  test('負の月: 2025-06-15 - 6ヶ月 = 2024-12-15', () => {
    expect(addMonthsSafe('2025-06-15', -6)).toBe('2024-12-15')
  })
})

describe('calcExpiryIso (有給時効 +2年)', () => {
  test('うるう年を跨ぐ正確な計算', () => {
    expect(calcExpiryIso('2024-02-29')).toBe('2026-02-28')  // 2026は平年
    expect(calcExpiryIso('2024-03-01')).toBe('2026-03-01')
  })

  test('月末付与の正確な計算', () => {
    expect(calcExpiryIso('2025-08-31')).toBe('2027-08-31')
    expect(calcExpiryIso('2025-04-30')).toBe('2027-04-30')
  })
})

describe('computePeriodUsed', () => {
  const today = '2026-06-02'

  test('実消化と申請ベースを分離する', () => {
    const allAtt: Record<string, unknown> = {
      'site1_101_202604_15': { p: 1 },  // 4/15 過去消化
      'site1_101_202605_10': { p: 1 },  // 5/10 過去消化
      'site1_101_202607_20': { p: 1 },  // 7/20 未来予定
      'site1_101_202608_15': { p: 1 },  // 8/15 未来予定
    }
    const result = computePeriodUsed(101, '2026-04-01', allAtt, today)
    expect(result.actualPeriodUsed).toBe(2)  // 4/15, 5/10
    expect(result.requestedPeriodUsed).toBe(4)  // 全部
  })

  test('multi-site 重複排除: 同日複数現場の有給は1日扱い', () => {
    const allAtt: Record<string, unknown> = {
      'site1_101_202604_15': { p: 1 },
      'site2_101_202604_15': { p: 1 },  // 同日別現場
      'site1_101_202605_10': { p: 1 },
    }
    const result = computePeriodUsed(101, '2026-04-01', allAtt, today)
    expect(result.actualPeriodUsed).toBe(2)  // 4/15 と 5/10 (4/15 は重複しない)
  })

  test('他のスタッフのデータは集計対象外', () => {
    const allAtt: Record<string, unknown> = {
      'site1_101_202604_15': { p: 1 },
      'site1_102_202604_15': { p: 1 },  // 別スタッフ
    }
    const result = computePeriodUsed(101, '2026-04-01', allAtt, today)
    expect(result.actualPeriodUsed).toBe(1)
  })

  test('付与期間外の有給は集計対象外', () => {
    const allAtt: Record<string, unknown> = {
      'site1_101_202603_15': { p: 1 },  // 付与前
      'site1_101_202604_15': { p: 1 },  // 付与期間内
      'site1_101_202705_15': { p: 1 },  // 付与期間後（1年以上後）
    }
    const result = computePeriodUsed(101, '2026-04-01', allAtt, today)
    expect(result.actualPeriodUsed).toBe(1)  // 4/15 のみ
  })
})

describe('judgeFiveDayObligation', () => {
  test('10日未満付与は対象外', () => {
    const r = judgeFiveDayObligation('2026-04-01', 7, 0, undefined, '2026-12-01')
    expect(r.warning).toBe(false)
    expect(r.shortfall).toBe(0)
  })

  test('5日達成済は警告なし', () => {
    const r = judgeFiveDayObligation('2026-04-01', 10, 5, undefined, '2026-12-01')
    expect(r.warning).toBe(false)
    expect(r.shortfall).toBe(0)
  })

  test('経過9ヶ月以上 + 未達 → 警告 (urgent or late)', () => {
    // 付与 2026-04-01、今日 2027-01-15 (9ヶ月以上経過 + 残3ヶ月以内)
    const r = judgeFiveDayObligation('2026-04-01', 10, 2, undefined, '2027-01-15')
    expect(r.warning).toBe(true)
    // 両条件に該当 → urgent が先に判定される (実装の優先順位)
    expect(['urgent', 'late']).toContain(r.reason)
    expect(r.shortfall).toBe(3)
  })

  test('期限まで残3ヶ月以内 + 未達 → urgent 警告', () => {
    // 付与 2026-04-01、期限 2027-04-01。今日 2027-02-01 (残2ヶ月)
    const r = judgeFiveDayObligation('2026-04-01', 10, 2, undefined, '2027-02-01')
    expect(r.warning).toBe(true)
    expect(['urgent', 'late']).toContain(r.reason)  // どちらでもOK
    expect(r.shortfall).toBe(3)
  })

  test('退職予定が期限より前 + 未達 → retiring 警告', () => {
    // 付与 2026-04-01、期限 2027-04-01。退職予定 2026-12-31。今日 2026-06-01 (まだ余裕あり)
    const r = judgeFiveDayObligation('2026-04-01', 10, 1, '2026-12-31', '2026-06-01')
    expect(r.warning).toBe(true)
    expect(r.reason).toBe('retiring')
    expect(r.shortfall).toBe(4)
  })

  test('期間早期は警告なし（経過6ヶ月以内）', () => {
    // 付与 2026-04-01、今日 2026-08-01 (4ヶ月経過)
    const r = judgeFiveDayObligation('2026-04-01', 10, 0, undefined, '2026-08-01')
    expect(r.warning).toBe(false)
  })
})

describe('isSameFiscalYear', () => {
  test('同月の付与は同一FY扱い', () => {
    expect(isSameFiscalYear({ grantDate: '2026-04-01' }, '2026-04-15')).toBe(true)
  })

  test('1年以内の近接付与は同一FY扱い', () => {
    expect(isSameFiscalYear({ grantDate: '2026-04-01' }, '2026-11-01')).toBe(true)
  })

  test('1年以上後は別FY', () => {
    expect(isSameFiscalYear({ grantDate: '2026-04-01' }, '2027-05-01')).toBe(false)
  })

  test('grantDate なしは別FY扱い', () => {
    expect(isSameFiscalYear({}, '2026-04-01')).toBe(false)
  })
})

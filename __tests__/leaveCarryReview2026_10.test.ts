/**
 * 2026-10-02 レビュー指摘（#49 / #53）の再発防止テスト
 *
 * A. 出面保存のたびに次期繰越の再計算が走っていた → 有給の有無が変わったときだけ（paidLeaveChanged）
 * B. 付与記録の無い古い入社の日本人に「初回付与 2015-10-01」と何年も前の日付が出ていた
 * C. 付与日を前に寄せた日本人（2025-12-01 → 2026-10-01）で 10/1〜11/30 に古い期が選ばれていた
 * D. 前の期の消化を丸1年で数え、10〜11月を前の期と今の期の両方で数えていた
 */
import { describe, test, expect } from 'vitest'
import { paidLeaveChanged } from '@/lib/attendance'
import {
  jpExpectedGrantWithoutRecords,
  selectCurrentPeriodRecord,
  computePeriodUsed,
} from '@/lib/leave-compute'

describe('A. paidLeaveChanged', () => {
  test('有給なし → 出勤は変化なし（再計算しない）', () => {
    expect(paidLeaveChanged(null, { w: 1 } as never)).toBe(false)
    expect(paidLeaveChanged({ w: 1 } as never, { w: 1, o: 2 } as never)).toBe(false)
    expect(paidLeaveChanged(undefined, { w: 0, r: 1 } as never)).toBe(false)
  })
  test('有給を付けた・外したときは変化あり', () => {
    expect(paidLeaveChanged(null, { w: 0, p: 1 } as never)).toBe(true)
    expect(paidLeaveChanged({ w: 0, p: 1 } as never, { w: 1 } as never)).toBe(true)
  })
  test('有給 → 有給（工種の移動など）は変化なし', () => {
    expect(paidLeaveChanged({ w: 0, p: 1 } as never, { w: 0, p: 1, s: 'admin' } as never)).toBe(false)
  })
})

describe('B. jpExpectedGrantWithoutRecords', () => {
  test('入社が古い人は、入社6ヶ月後から1年ごとの直近の付与日（今続いている期）', () => {
    expect(jpExpectedGrantWithoutRecords('2015-04-01', '2026-10-02'))
      .toEqual({ grantDate: '2026-10-01', catchUp: true })
    expect(jpExpectedGrantWithoutRecords('2015-04-01', '2026-09-30'))
      .toEqual({ grantDate: '2025-10-01', catchUp: true })
  })
  test('入社6ヶ月後が未来ならそのまま（初回付与）', () => {
    expect(jpExpectedGrantWithoutRecords('2026-06-01', '2026-10-02'))
      .toEqual({ grantDate: '2026-12-01', catchUp: false })
  })
  test('入社6ヶ月後が1年以内の過去ならそのまま（付け忘れの初回）', () => {
    expect(jpExpectedGrantWithoutRecords('2025-09-01', '2026-10-02'))
      .toEqual({ grantDate: '2026-03-01', catchUp: false })
  })
  test('月末入社でも応当日がずれない（入社日から 6+12k ヶ月）', () => {
    // 2020-08-31 + 6 = 2021-02-28、+18 = 2022-02-28 … +66 = 2026-02-28
    expect(jpExpectedGrantWithoutRecords('2020-08-31', '2026-10-02'))
      .toEqual({ grantDate: '2026-02-28', catchUp: true })
  })
  test('入社日が無い・不正なら null', () => {
    expect(jpExpectedGrantWithoutRecords('', '2026-10-02')).toBeNull()
  })
})

describe('C. selectCurrentPeriodRecord', () => {
  const moved = [
    { fy: 2025, grantDate: '2025-12-01', grantDays: 12 },
    { fy: 2026, grantDate: '2026-10-01', grantDays: 14 },
  ]
  test('付与日を前に寄せた人は、新しい付与日以降は新しい期（10/1〜11/30 も）', () => {
    expect(selectCurrentPeriodRecord(moved, '2026-10-02')?.grantDate).toBe('2026-10-01')
    expect(selectCurrentPeriodRecord(moved, '2026-11-30')?.grantDate).toBe('2026-10-01')
  })
  test('新しい付与日の前日までは前の期', () => {
    expect(selectCurrentPeriodRecord(moved, '2026-09-30')?.grantDate).toBe('2025-12-01')
  })
  test('配列の順番に左右されない', () => {
    expect(selectCurrentPeriodRecord([...moved].reverse(), '2026-10-15')?.grantDate).toBe('2026-10-01')
  })
  test('未来の付与だけなら null、最後の付与から1年過ぎても null', () => {
    expect(selectCurrentPeriodRecord([{ grantDate: '2026-12-01', grantDays: 10 }], '2026-10-02')).toBeNull()
    expect(selectCurrentPeriodRecord([{ grantDate: '2024-10-01', grantDays: 10 }], '2026-10-02')).toBeNull()
  })
})

describe('D. computePeriodUsed periodEndExclusive', () => {
  // 前の期 2025-12-01 付与、次の付与 2026-10-01（前倒し）。10/15 の有給は今の期だけで数える
  const att = {
    site_7_202601_10: { p: 1 },
    site_7_202609_30: { p: 1 },
    site_7_202610_15: { p: 1 },
    site_7_202611_20: { p: 1 },
  }
  test('前の期の終わりを次の付与日の前日にすると、10〜11月を数えない', () => {
    const r = computePeriodUsed(7, '2025-12-01', att, '2026-12-31', { periodEndExclusive: '2026-10-01' })
    expect(r.requestedPeriodUsed).toBe(2)
  })
  test('省略時は従来どおり丸1年', () => {
    const r = computePeriodUsed(7, '2025-12-01', att, '2026-12-31')
    expect(r.requestedPeriodUsed).toBe(4)
  })
  test('1年より後の日を渡しても1年で切る', () => {
    const r = computePeriodUsed(7, '2025-12-01', { ...att, site_7_202612_05: { p: 1 } }, '2026-12-31', { periodEndExclusive: '2027-03-01' })
    expect(r.requestedPeriodUsed).toBe(4)
  })
})

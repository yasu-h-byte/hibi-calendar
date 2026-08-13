import { describe, it, expect } from 'vitest'
import { calcLegalHolidayAllowance } from '@/lib/compute'

// 日本人の法定休日（日曜）割増（2026-08-13 実装）。
// 従来は「日額×1日 ＋ 残業h×1.25」で処理しており、労基法37条の35%増が未計上だった。
// 法定休日は所定労働日ではないので日額・残業から除外し、全時間に1.35倍（8h超は1.60倍）。
// 8時間の線は「日ごと」に引く（ベトナム人の calculateVietnameseSalary と同一の建て方）。

const R = 15000                 // 日額
const hourly = R / 8            // 割増算定基礎の時給 = 1,875円

describe('calcLegalHolidayAllowance', () => {
  it('日曜8h = 時給 × 1.35 × 8h', () => {
    expect(calcLegalHolidayAllowance(hourly, [8])).toBe(20250)  // 1875 × 10.8
  })

  it('日曜10h = 8h×1.35 + 2h×1.60', () => {
    // 1875 × (10.8 + 3.2) = 1875 × 14
    expect(calcLegalHolidayAllowance(hourly, [10])).toBe(26250)
  })

  it('半日(4h)の日曜出勤も時間比例', () => {
    expect(calcLegalHolidayAllowance(hourly, [4])).toBe(10125)  // 1875 × 5.4
  })

  it('8時間の線は日ごとに引く（月合計に対して引くと1.60倍が過大になる）', () => {
    // 日ごと: 1875 × (1.35×16 + 1.60×4) = 1875 × 28 = 52,500
    expect(calcLegalHolidayAllowance(hourly, [10, 10])).toBe(52500)
    // 月合計20hに対して引いてしまうと 1875 × (1.35×8 + 1.60×12) = 56,250 になり過大
    expect(calcLegalHolidayAllowance(hourly, [20])).toBe(56250)
    expect(calcLegalHolidayAllowance(hourly, [10, 10]))
      .toBeLessThan(calcLegalHolidayAllowance(hourly, [20]))
  })

  it('日曜が複数日あれば合算される', () => {
    expect(calcLegalHolidayAllowance(hourly, [8, 8])).toBe(40500)
  })

  it('該当日なし・0h・時給0 は 0', () => {
    expect(calcLegalHolidayAllowance(hourly, [])).toBe(0)
    expect(calcLegalHolidayAllowance(hourly, [0])).toBe(0)
    expect(calcLegalHolidayAllowance(0, [8])).toBe(0)
  })
})

describe('従来との差額（未払いだった分）', () => {
  it('日曜に8h出勤 → 日額1日分から 1.35倍へ。差は日額の0.35倍', () => {
    const before = R                                       // 旧: 日額 × 1日
    const after = calcLegalHolidayAllowance(hourly, [8])    // 新: 1.35倍（日額は除外）
    expect(after - before).toBe(5250)
    expect((after - before) / R).toBeCloseTo(0.35, 5)
  })

  it('日曜に残業込み10h（旧は日額 + 残業2h×1.25）', () => {
    const otUnit = Math.ceil(hourly * 1.25)                // 2,344円
    const before = R + otUnit * 2                          // 19,688
    const after = calcLegalHolidayAllowance(hourly, [10])   // 26,250
    expect(before).toBe(19688)
    expect(after - before).toBe(6562)
  })
})

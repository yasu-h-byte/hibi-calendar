import { describe, it, expect } from 'vitest'
import { JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM } from '@/lib/constants'

/**
 * 日本人・月給制の欠勤控除（2026-10 分から・代表決定 2026-08-31）
 *
 * 従来は「出勤日数に関わらず月給は固定」で、欠勤しても控除されなかった。
 * 対象は 濱上さん（新卒・入社1年目は月給制）のような salary > 0 の日本人。
 *
 * 控除額 = 月給 ÷ その月の所定労働日数 × 欠勤日数（基本給が上限）
 * 有給・試験・補償日は欠勤に数えない。
 */

/** compute.ts の月給制ブランチと同じ式（仕様の固定用） */
function absenceDeduction(args: {
  salary: number
  prescribedDays: number
  actualWorkDays: number
  paidLeaveDays?: number
  examDays?: number
  compDays?: number
}): { absentDays: number; deduction: number } {
  const { salary, prescribedDays, actualWorkDays } = args
  const absentDays = Math.max(0,
    prescribedDays - actualWorkDays - (args.paidLeaveDays || 0) - (args.examDays || 0) - (args.compDays || 0))
  const deduction = Math.min(salary, Math.floor(Math.round((salary / prescribedDays) * absentDays * 100) / 100))
  return { absentDays, deduction }
}

describe('月給制の欠勤控除', () => {
  it('適用開始月は 2026-10（過去の支給額を動かさないため）', () => {
    expect(JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe('202610')
    expect('202609' >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe(false)
    expect('202610' >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe(true)
  })

  it('所定23日で20日出勤 → 3日欠勤・月給235,000円なら30,652円の控除', () => {
    const r = absenceDeduction({ salary: 235000, prescribedDays: 23, actualWorkDays: 20 })
    expect(r.absentDays).toBe(3)
    expect(r.deduction).toBe(30652)   // 235000 / 23 × 3 = 30,652.17 → 切り捨て
  })

  it('有給・試験・補償日は欠勤に数えない', () => {
    const r = absenceDeduction({
      salary: 235000, prescribedDays: 23, actualWorkDays: 18,
      paidLeaveDays: 2, examDays: 1, compDays: 2,
    })
    expect(r.absentDays).toBe(0)
    expect(r.deduction).toBe(0)
  })

  it('全部欠勤しても控除は月給まで（マイナス支給にしない）', () => {
    const r = absenceDeduction({ salary: 235000, prescribedDays: 23, actualWorkDays: 0 })
    expect(r.absentDays).toBe(23)
    expect(r.deduction).toBe(235000)
  })

  it('欠勤ゼロなら控除ゼロ（従来どおり月給満額）', () => {
    const r = absenceDeduction({ salary: 235000, prescribedDays: 23, actualWorkDays: 23 })
    expect(r.deduction).toBe(0)
  })

  it('控除の分母は当月の所定日数（残業単価の145h基準は使わない）', () => {
    // 145h基準だと 235000/145×8 = 12,965円/日 と過大になる
    const perDay145 = (235000 / 145) * 8
    const perDayActual = 235000 / 23
    expect(Math.round(perDay145)).toBe(12966)
    expect(Math.round(perDayActual)).toBe(10217)
    expect(perDayActual).toBeLessThan(perDay145)
  })
})

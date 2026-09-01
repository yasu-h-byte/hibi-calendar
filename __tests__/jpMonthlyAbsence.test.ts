import { describe, it, expect } from 'vitest'
import {
  JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM,
  JP_ANNUAL_WORK_DAYS,
  JP_AVG_MONTHLY_WORK_DAYS,
  JP_SALARY_AVG_MONTHLY_HOURS,
} from '@/lib/constants'

/**
 * 日本人・月給制の欠勤控除（2026年8月分から・代表決定 2026-08-31）
 *
 * 対象は 濱上さん（新卒・入社1年目は月給制）のような salary > 0 の日本人。役員は対象外。
 *
 * **欠勤は「出面に記録された欠勤」だけを数える**（現場カレンダーの稼働日から引かない）。
 *   欠勤日数 = 欠(r)の日数 ＋ 出勤日の不足分（1 − 人工）
 *   控除額   = 基本給 ÷ 月平均所定労働日数(20.83日) × 欠勤日数（基本給が上限）
 *
 * 分母を月平均で固定する理由: 当月の所定日数で割ると、同じ1日の欠勤でも
 * 7月(22日)は10,681円・8月(16日)は14,687円と変わり、稼働日の少ない月に休むほど損をする。
 */

/** compute.ts の月給制ブランチと同じ式（仕様の固定用） */
function absenceDeduction(args: {
  salary: number
  actualWorkDays: number   // 出勤した「日数」（0.5日でも1日と数える）
  workDays: number         // 出勤した「人工」（0.5なら0.5）
  restDays?: number        // 出面に「欠」と記録された日数
}): { absentDays: number; deduction: number } {
  const rest = args.restDays || 0
  const partial = Math.max(0, args.actualWorkDays - args.workDays)
  const absentDays = Math.round((rest + partial) * 100) / 100
  const deduction = absentDays > 0
    ? Math.min(args.salary,
        Math.floor(Math.round((args.salary / JP_AVG_MONTHLY_WORK_DAYS) * absentDays * 100) / 100))
    : 0
  return { absentDays, deduction }
}

describe('月給制の欠勤控除', () => {
  it('適用開始月は 2026-08（9/25支給分から）', () => {
    expect(JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe('202608')
  })

  it('分母は年間所定250日 ÷ 12 = 20.83日（月ごとに変動させない）', () => {
    expect(JP_ANNUAL_WORK_DAYS).toBe(250)
    expect(JP_AVG_MONTHLY_WORK_DAYS).toBeCloseTo(20.8333, 4)
  })

  it('残業単価の145hは 250日×7h÷12=145.83h を安全側に切り下げた値', () => {
    // 同じ年間250日から出ているが、割増単価は「分母を小さく＝単価を高く」丸めてある。
    // 控除にこの丸めを流用すると「控除を増やす」方向に反転するので使わない。
    expect(JP_ANNUAL_WORK_DAYS * 7 / 12).toBeCloseTo(145.83, 2)
    expect(JP_SALARY_AVG_MONTHLY_HOURS).toBe(145)
    expect(JP_SALARY_AVG_MONTHLY_HOURS).toBeLessThan(JP_ANNUAL_WORK_DAYS * 7 / 12)
  })

  it('濱上さんの2026年8月（実績）: 欠勤2.5日 → 28,200円', () => {
    // 14日出勤（8/17は0.5人工）、8/18・8/31 を「欠」で記録
    const r = absenceDeduction({
      salary: 235000, actualWorkDays: 14, workDays: 13.5, restDays: 2,
    })
    expect(r.absentDays).toBe(2.5)
    expect(r.deduction).toBe(28200)   // 235000 / 20.8333 × 2.5 = 28,200.0
  })

  it('濱上さんの2026年7月（実績）: 欠勤1日 → 11,280円', () => {
    const r = absenceDeduction({
      salary: 235000, actualWorkDays: 21, workDays: 21, restDays: 1,
    })
    expect(r.absentDays).toBe(1)
    expect(r.deduction).toBe(11280)   // 235000 / 20.8333 = 11,280.0
  })

  it('同じ1日の欠勤なら、何月でも控除額は同じ', () => {
    const july = absenceDeduction({ salary: 235000, actualWorkDays: 21, workDays: 21, restDays: 1 })
    const aug = absenceDeduction({ salary: 235000, actualWorkDays: 15, workDays: 15, restDays: 1 })
    expect(july.deduction).toBe(aug.deduction)
  })

  it('ブランクの日は控除されない（入力漏れが減給にならない）', () => {
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 16, workDays: 16 })
    expect(r.absentDays).toBe(0)
    expect(r.deduction).toBe(0)
  })

  it('午後から出勤（0.5人工）は0.5日の欠勤として控除', () => {
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 20, workDays: 19.5 })
    expect(r.absentDays).toBe(0.5)
    expect(r.deduction).toBe(5640)    // 235000 / 20.8333 × 0.5
  })

  it('全部欠勤しても控除は基本給まで（マイナス支給にしない）', () => {
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 0, workDays: 0, restDays: 25 })
    expect(r.deduction).toBe(235000)
  })
})

import { describe, it, expect } from 'vitest'
import { JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM } from '@/lib/constants'

/**
 * 日本人・月給制の欠勤控除（2026年8月分から・代表決定 2026-08-31）
 *
 * 対象は 濱上さん（新卒・入社1年目は月給制）のような salary > 0 の日本人。役員は対象外。
 *
 * **欠勤は「出面に記録された欠勤」だけを数える**（現場カレンダーの稼働日から引かない）。
 *   欠勤日数 = 休み(r)の日数 ＋ 出勤日の不足分（1 − 人工）
 *   所定日数 = 実出勤日 ＋ 有給 ＋ 試験 ＋ 休み  ← 記録のある日がその人の所定日
 *   控除額   = 基本給 ÷ 所定日数 × 欠勤日数（基本給が上限）
 *
 * カレンダー基準にしない理由: 笹塚は土曜もお盆初日も稼働日だが、濱上さん（年少者・
 * 週休2日）は出ない。カレンダー基準だと休むはずの土曜まで欠勤になり過大に引く。
 */

/** compute.ts の月給制ブランチと同じ式（仕様の固定用） */
function absenceDeduction(args: {
  salary: number
  actualWorkDays: number   // 出勤した「日数」（0.5日でも1日と数える）
  workDays: number         // 出勤した「人工」（0.5なら0.5）
  restDays?: number        // 出面に「休み」と記録された日数
  paidLeaveDays?: number
  examDays?: number
}): { absentDays: number; scheduledDays: number; deduction: number } {
  const rest = args.restDays || 0
  const partial = Math.max(0, args.actualWorkDays - args.workDays)
  const absentDays = Math.round((rest + partial) * 100) / 100
  const scheduledDays = args.actualWorkDays + (args.paidLeaveDays || 0) + (args.examDays || 0) + rest
  const deduction = (scheduledDays > 0 && absentDays > 0)
    ? Math.min(args.salary, Math.floor(Math.round((args.salary / scheduledDays) * absentDays * 100) / 100))
    : 0
  return { absentDays, scheduledDays, deduction }
}

describe('月給制の欠勤控除', () => {
  it('適用開始月は 2026-08（9/25支給分から）', () => {
    expect(JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe('202608')
    expect('202607' >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe(false)
    expect('202608' >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM).toBe(true)
  })

  it('濱上さんの2026年8月（実績）: 13.5人工・欠勤2日・午後出勤0.5 → 36,718円', () => {
    // 14日出勤（うち17日は0.5）、18日と31日を「休み」で記録
    const r = absenceDeduction({
      salary: 235000, actualWorkDays: 14, workDays: 13.5, restDays: 2,
    })
    expect(r.absentDays).toBe(2.5)
    expect(r.scheduledDays).toBe(16)   // 土曜・お盆はブランク＝所定外なので入らない
    expect(r.deduction).toBe(36718)    // 235000 / 16 × 2.5 = 36,718.75 → 切り捨て
  })

  it('ブランクの日は控除されない（入力漏れが減給にならない）', () => {
    // 現場は21日稼働だが、本人の記録は16日ぶんしかない
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 16, workDays: 16 })
    expect(r.absentDays).toBe(0)
    expect(r.deduction).toBe(0)
  })

  it('午後から出勤（0.5人工）は0.5日の欠勤として控除', () => {
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 20, workDays: 19.5 })
    expect(r.absentDays).toBe(0.5)
    expect(r.deduction).toBe(5875)     // 235000 / 20 × 0.5
  })

  it('有給・試験は欠勤に数えないが、所定日数には入る', () => {
    const r = absenceDeduction({
      salary: 235000, actualWorkDays: 18, workDays: 18, paidLeaveDays: 2, examDays: 1,
    })
    expect(r.absentDays).toBe(0)
    expect(r.scheduledDays).toBe(21)
    expect(r.deduction).toBe(0)
  })

  it('全部欠勤しても控除は基本給まで（マイナス支給にしない）', () => {
    const r = absenceDeduction({ salary: 235000, actualWorkDays: 0, workDays: 0, restDays: 20 })
    expect(r.absentDays).toBe(20)
    expect(r.deduction).toBe(235000)
  })
})

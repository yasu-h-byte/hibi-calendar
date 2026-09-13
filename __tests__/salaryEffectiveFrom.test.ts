import { describe, test, expect } from 'vitest'
import { effectiveSalaryForYm } from '@/lib/workers'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * 固定月給の適用開始日（2026-09-14）
 * フォン(207)・タン(208): 10/1 から 時給1,270→1,280 / 日給8,890→8,960 / 月給213,784→215,467。
 * 9月中に人員マスタへ仕込んでも、9月分は旧額で計算されること。
 */
describe('effectiveSalaryForYm', () => {
  const w = { salary: 215467, salaryFrom: '2026-10-01', prevSalary: 213784 }
  test('開始月より前は旧月給、開始月以降は新月給', () => {
    expect(effectiveSalaryForYm(w, '202609')).toBe(213784)
    expect(effectiveSalaryForYm(w, '202610')).toBe(215467)
    expect(effectiveSalaryForYm(w, '202611')).toBe(215467)
  })
  test('月途中は暦日按分（切上）', () => {
    expect(effectiveSalaryForYm({ salary: 300000, salaryFrom: '2026-09-16', prevSalary: 270000 }, '202609')).toBe(285000)
  })
  test('開始日の無い人は従来どおり', () => {
    expect(effectiveSalaryForYm({ salary: 396105 }, '202610')).toBe(396105)
  })
})

describe('computeMonthly: フォンの 10/1 最賃対応', () => {
  const main = {
    workers: [{
      id: 207, name: 'フォン', org: 'hfu', visa: 'jisshu1', job: 'tobi', otMul: 1.25, hireDate: '2026-08-01', token: '', useOldRules: true,
      rate: 8960, rateFrom: '2026-10-01', prevRate: 8890,
      hourlyRate: 1280, hourlyRateFrom: '2026-10-01', prevHourlyRate: 1270,
      salary: 215467, salaryFrom: '2026-10-01', prevSalary: 213784,
    }],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { s: { workers: [207], subcons: [] } }, massign: {}, billing: {}, workDays: { '202609': 23, '202610': 23 }, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
  const att = (ym: string) => {
    const a: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 22; d++) a[`s_207_${ym}_${d}`] = { w: 1, o: d === 1 ? 2 : 0 } as unknown as AttendanceEntry
    return a
  }
  const run = (ym: string) => computeMonthly(main, att(ym), {}, ym, 23, undefined, 20).workers.find(x => x.id === 207)!
  test('9月分: 月給213,784・残業単価1,588・欠勤1日8,890', () => {
    const w = run('202609')
    expect(w.basePay).toBe(213784)
    expect(w.otAllowance).toBe(1588 * 2)
    expect(w.absentDeduction).toBe(8890)
  })
  test('10月分: 月給215,467・残業単価1,600・欠勤1日8,960', () => {
    const w = run('202610')
    expect(w.basePay).toBe(215467)
    expect(w.otAllowance).toBe(1600 * 2)
    expect(w.absentDeduction).toBe(8960)
  })
})

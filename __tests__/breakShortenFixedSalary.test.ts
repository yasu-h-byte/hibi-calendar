import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * 休憩短縮手当（20分/日）を新ルール期の固定月給スタッフ（フォン 207・タン 208）にも付ける（2026-09-13）。
 * 旧ルール固定月給（フン 104）のブランチにしか無く、設定してもエラーログだけ出て加算されなかった。
 */
function main(bs: boolean): MainData {
  return {
    workers: [{ id: 207, name: 'フォン', org: 'hibi', visa: 'jisshu1', job: 'tobi', rate: 1270 * 7, hourlyRate: 1270, salary: 213784, otMul: 1.25, hireDate: '2026-08-01', token: '',
      ...(bs ? { breakShortenMin: 20, breakShortenFrom: '202609' } : {}) }],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { s: { workers: [207], subcons: [] } }, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}
function att(ym: string, days: number[]) {
  const a: Record<string, AttendanceEntry> = {}
  for (const d of days) a[`s_207_${ym}_${d}`] = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry
  a[`s_207_${ym}_15`] = { p: 1 } as unknown as AttendanceEntry  // 有給日は対象外
  return a
}
const WORK = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]  // 11日

describe('休憩短縮手当（固定月給・新ルール期）', () => {
  test('9月分: 出勤11日 × 20分 = 3.667h × (月給÷140h) が加算され、エラーは出ない', () => {
    const errs: string[] = []
    const orig = console.error; console.error = (...a: unknown[]) => { errs.push(String(a[0])) }
    const w = computeMonthly(main(true), att('202609', WORK), {}, '202609', 0, { s: 11 }, 20).workers.find(x => x.id === 207)!
    console.error = orig
    const derived = 213784 / 140
    expect(w.breakShortenHours).toBeCloseTo(11 * 20 / 60, 5)
    expect(w.breakShortenAllowance).toBe(Math.ceil(derived * 11 * 20 / 60))
    expect(errs).toEqual([])
    const base = computeMonthly(main(false), att('202609', WORK), {}, '202609', 0, { s: 11 }, 20).workers.find(x => x.id === 207)!
    expect((w.salaryNetPay ?? w.netPay) - (base.salaryNetPay ?? base.netPay)).toBe(w.breakShortenAllowance)
  })
  test('適用開始月より前（8月分）は付かない', () => {
    const w = computeMonthly(main(true), att('202608', WORK), {}, '202608', 0, { s: 11 }, 20).workers.find(x => x.id === 207)!
    expect(w.breakShortenAllowance).toBeUndefined()
  })
})

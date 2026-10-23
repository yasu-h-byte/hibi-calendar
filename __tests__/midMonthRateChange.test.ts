import { describe, test, expect } from 'vitest'
import { computeMonthly } from '@/lib/compute-monthly'
import { type MainData } from '@/lib/compute'
import { effectiveHourlyRateForYm, midMonthRateChangeOf } from '@/lib/workers'
import { buildAuditChecks } from '@/lib/payroll-validator'
import type { AttendanceEntry } from '@/types'

/**
 * 月の途中の時給改定（2026-10 分〜・2026-10-23 代表決定・エムテックの従来の方式）:
 *   その月は旧時給で1か月を計算し、時給の差 ×（適用開始日以降に働いた時間 ＋ 0.6補の日 × 7h × 0.6）を足す。
 * 9月分（ゴック 205・サン 206 の 9/21 改定）は暦日按分のまま（支払い済み）。
 */
const e = (x: object) => x as unknown as AttendanceEntry
const W7 = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 }   // 7h

function main(from: string): MainData {
  return {
    workers: [
      { id: 205, name: 'A', org: 'hfu', visa: 'jisshu3', job: 'tobi', rate: 11095, hourlyRate: 1585, hourlyRateFrom: from, prevHourlyRate: 1425, otMul: 1.25, hireDate: '2023-10-23', token: '' },
    ],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false,
      workSchedule: { startTime: '08:00', endTime: '17:00', morningBreak: { enabled: true, minutes: 30 }, lunchBreak: { enabled: true, minutes: 60 }, afternoonBreak: { enabled: true, minutes: 30 } } }],
    subcons: [], assign: { s: { workers: [205], subcons: [] } }, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}

describe('時給の解決', () => {
  const w = { hourlyRate: 1585, hourlyRateFrom: '2026-10-21', prevHourlyRate: 1425 }
  test('2026-10 分からは改定の月は旧時給', () => {
    expect(effectiveHourlyRateForYm(w, '202610')).toBe(1425)
    expect(midMonthRateChangeOf(w, '202610')).toEqual({ fromDay: 21, prev: 1425, cur: 1585 })
    expect(effectiveHourlyRateForYm(w, '202611')).toBe(1585)
  })
  test('9月分までは暦日按分のまま（ゴック・サンの 9/21 改定）', () => {
    const sep = { hourlyRate: 1585, hourlyRateFrom: '2026-09-21', prevHourlyRate: 1425 }
    expect(effectiveHourlyRateForYm(sep, '202609')).toBe(1478.33)
    expect(midMonthRateChangeOf(sep, '202609')).toBeNull()
  })
  test('1日からの改定は差額にしない（その月から新時給）', () => {
    const oct1 = { hourlyRate: 1585, hourlyRateFrom: '2026-10-01', prevHourlyRate: 1425 }
    expect(midMonthRateChangeOf(oct1, '202610')).toBeNull()
    expect(effectiveHourlyRateForYm(oct1, '202610')).toBe(1585)
  })
})

describe('時給改定差額', () => {
  const YM = '202610'
  // 改定 10/21。改定前に4日・改定後に 21・23 出勤、22 は 0.6補、24 は 7.5h（残業0.5h）
  function att(): Record<string, AttendanceEntry> {
    const a: Record<string, AttendanceEntry> = {}
    for (const d of [5, 6, 7, 8]) a[`s_205_${YM}_${d}`] = e(W7)
    a[`s_205_${YM}_21`] = e(W7)
    a[`s_205_${YM}_22`] = e({ w: 0.6, s: 'admin' })
    a[`s_205_${YM}_23`] = e(W7)
    a[`s_205_${YM}_24`] = e({ ...W7, et: '17:30', o: 0.5 })
    a[`s_205_${YM}_26`] = e({ w: 0, r: 1 })     // 改定後の欠は足さない
    return a
  }
  const run = () => computeMonthly(main('2026-10-21'), att(), {}, YM, 27, undefined, 20).workers.find(x => x.id === 205)!

  test('旧時給で計算し、差 ×（働いた時間 ＋ 0.6補 × 7h × 0.6）を足す', () => {
    const w = run()
    expect(w.hourlyRate).toBe(1425)
    expect(w.rateChangeHours).toBe(21.5)          // 7 + 7 + 7.5
    expect(w.rateChangeCompDays).toBe(1)
    expect(w.rateChangeAllowance).toBe(Math.ceil(160 * (21.5 + 7 * 0.6)))   // 4,112
  })

  test('支給額に入っていて、検算（内訳合計 ＝ 支給額）が通る', () => {
    const w = run()
    const without = computeMonthly({ ...main('2026-10-21'), workers: [{ ...main('2026-10-21').workers[0], hourlyRate: 1425, hourlyRateFrom: undefined, prevHourlyRate: undefined }] } as unknown as MainData,
      att(), {}, YM, 27, undefined, 20).workers.find(x => x.id === 205)!
    expect((w.salaryNetPay || 0) - (without.salaryNetPay || 0)).toBe(w.rateChangeAllowance)
    const checks = buildAuditChecks(w as never, YM, 27)
    expect(checks.find(c => c.label === '支給額の内訳合計が一致')?.pass).toBe(true)
  })
})

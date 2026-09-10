import { describe, test, expect } from 'vitest'
import { effectiveHourlyRateForYm } from '@/lib/workers'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * 時給の適用開始日（2026-09-10 追加）
 *
 * 9/21 の実習3号移行（ゴック・サン 1,425→1,585）や 10/1 の一律改定を、実施日より前に
 * /wage-analysis から反映しても、前月分・実施日前の日数が新時給で計算されないようにする。
 * 月途中の変更は中途入退社と同じ暦日按分。
 */
describe('effectiveHourlyRateForYm', () => {
  const w = { hourlyRate: 1585, hourlyRateFrom: '2026-09-21', prevHourlyRate: 1425 }
  test('適用開始日より前の月は改定前の時給', () => {
    expect(effectiveHourlyRateForYm(w, '202608')).toBe(1425)
    expect(effectiveHourlyRateForYm(w, '2026-08')).toBe(1425)
  })
  test('適用開始月は暦日按分（9/21 → 20日:10日）', () => {
    // (1425×20 + 1585×10) / 30 = 1478.33
    expect(effectiveHourlyRateForYm(w, '202609')).toBe(1478.33)
  })
  test('翌月以降は新しい時給', () => {
    expect(effectiveHourlyRateForYm(w, '202610')).toBe(1585)
  })
  test('月初が開始日なら按分なしで新時給', () => {
    const u = { hourlyRate: 1729, hourlyRateFrom: '2026-10-01', prevHourlyRate: 1581 }
    expect(effectiveHourlyRateForYm(u, '202609')).toBe(1581)
    expect(effectiveHourlyRateForYm(u, '202610')).toBe(1729)
  })
  test('開始日の無い人は従来どおり hourlyRate', () => {
    expect(effectiveHourlyRateForYm({ hourlyRate: 2000 }, '202609')).toBe(2000)
    expect(effectiveHourlyRateForYm({ hourlyRate: 2000, hourlyRateFrom: '2026-10-01' }, '202609')).toBe(2000)
  })
})

describe('computeMonthly: 時給制の時給は月ごとに解決', () => {
  const base: MainData = {
    workers: [{
      id: 205, name: 'ゴック', org: 'hibi', visa: 'jisshu2', job: 'tobi',
      rate: 1585 * 7, hourlyRate: 1585, hourlyRateFrom: '2026-09-21', prevHourlyRate: 1425,
      otMul: 1.25, hireDate: '2024-09-20', token: '',
    }],
    sites: [{ id: 'site1', name: '現場1', start: '', end: '', foreman: 0, archived: false }],
    subcons: [],
    assign: { site1: { workers: [205], subcons: [] } },
    massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
  const attFor = (ym: string) => {
    const d: Record<string, AttendanceEntry> = {}
    for (const day of [1, 2, 3]) d[`site1_205_${ym}_${day}`] = { w: 1 } as AttendanceEntry
    return d
  }
  test('8月分は改定前 1,425円', () => {
    const w = computeMonthly(base, attFor('202608'), {}, '202608', 22, { site1: 22 }, 20).workers.find(x => x.id === 205)!
    expect(w.hourlyRate).toBe(1425)
  })
  test('9月分は按分 1,478.33円、10月分は 1,585円', () => {
    expect(computeMonthly(base, attFor('202609'), {}, '202609', 22, { site1: 22 }, 20).workers.find(x => x.id === 205)!.hourlyRate).toBe(1478.33)
    expect(computeMonthly(base, attFor('202610'), {}, '202610', 22, { site1: 22 }, 20).workers.find(x => x.id === 205)!.hourlyRate).toBe(1585)
  })
})

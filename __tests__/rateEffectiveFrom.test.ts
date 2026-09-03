import { describe, test, expect } from 'vitest'
import { effectiveRateForYm } from '@/lib/workers'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * 年次改定の適用開始日（2026-09-03 追加）
 *
 * 改定（基準日 10/1）を 9 月中に確定すると人員マスタの rate は新額になるが、
 * 9 月分の給与は改定前の日額で計算しなければならない（大介さん事案: 7号→13号を
 * 9/3 に確定 → 9 月分まで 19,080円/日 で計算されるところだった）。
 */
describe('effectiveRateForYm', () => {
  const w = { rate: 19080, rateFrom: '2026-10-01', prevRate: 17790 }
  test('適用開始日より前の月は改定前の日額', () => {
    expect(effectiveRateForYm(w, '202609')).toBe(17790)
    expect(effectiveRateForYm(w, '2026-09')).toBe(17790)
  })
  test('適用開始月以降は新しい日額', () => {
    expect(effectiveRateForYm(w, '202610')).toBe(19080)
    expect(effectiveRateForYm(w, '202611')).toBe(19080)
  })
  test('改定履歴の無い人は従来どおり rate', () => {
    expect(effectiveRateForYm({ rate: 20000 }, '202609')).toBe(20000)
    expect(effectiveRateForYm({ rate: 20000, rateFrom: '2026-10-01' }, '202609')).toBe(20000)  // prevRate 無し
  })
})

describe('computeMonthly: 日本人日給月給の日額は月ごとに解決', () => {
  const base: MainData = {
    workers: [{
      id: 6, name: '大介', org: 'hibi', visa: 'none', job: 'shokucho',
      rate: 19080, rateFrom: '2026-10-01', prevRate: 17790, prevJpStep: 7,
      otMul: 1.25, hireDate: '2015-04-01', token: '',
    }],
    sites: [{ id: 'site1', name: '現場1', start: '', end: '', foreman: 0, archived: false }],
    subcons: [],
    assign: { site1: { workers: [6], subcons: [] } },
    massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
  const attFor = (ym: string) => {
    const d: Record<string, AttendanceEntry> = {}
    for (const day of [1, 2, 3]) d[`site1_6_${ym}_${day}`] = { w: 1 } as AttendanceEntry
    return d
  }
  test('9月分は改定前 17,790円 × 3日', () => {
    const w = computeMonthly(base, attFor('202609'), {}, '202609', 22, { site1: 22 }, 20).workers.find(x => x.id === 6)!
    expect(w.rate).toBe(17790)
    expect(w.basePay).toBe(17790 * 3)
  })
  test('10月分は改定後 19,080円 × 3日', () => {
    const w = computeMonthly(base, attFor('202610'), {}, '202610', 22, { site1: 22 }, 20).workers.find(x => x.id === 6)!
    expect(w.rate).toBe(19080)
    expect(w.basePay).toBe(19080 * 3)
  })
})

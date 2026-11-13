import { describe, test, expect } from 'vitest'
import {
  personOnDate, buildPeople, inScope, statOf, decomposeAverage, requiredHires,
  shiftYm, ymRange, buildAvgWageView, DEFAULT_AVG_FILTER, type WageRatePerson,
} from '@/lib/avg-wage'

// 数字はすべて架空（実在の人の単価は書かない）
const P = (id: number, daily: number, group: 'jp' | 'foreign' = 'jp', extra: Partial<WageRatePerson> = {}): WageRatePerson =>
  ({ id, group, org: 'hibi', job: 'tobi', daily, basis: 'daily', ...extra })

describe('平均日給: 日給へのそろえ方', () => {
  test('日本人の日額はそのまま、改定日より前は prevRate', () => {
    const w = { id: 1, visa: 'none', rate: 20000, prevRate: 19500, rateFrom: '2026-10-01' }
    expect(personOnDate(w, '2026-10-01')?.daily).toBe(20000)
    expect(personOnDate(w, '2026-09-01')?.daily).toBe(19500)
  })
  test('外国人の時給は ×7時間、適用日より前は prevHourlyRate', () => {
    const w = { id: 2, visa: 'tokutei1', hourlyRate: 1500, prevHourlyRate: 1400, hourlyRateFrom: '2026-09-21' }
    expect(personOnDate(w, '2026-10-01')).toMatchObject({ daily: 10500, basis: 'hourly', group: 'foreign' })
    expect(personOnDate(w, '2026-09-01')?.daily).toBe(9800)
  })
  test('外国人の固定月給は ÷20日（時給より月給を正とする）', () => {
    expect(personOnDate({ id: 3, visa: 'ginou', salary: 300000, hourlyRate: 1500 }, '2026-10-01'))
      .toMatchObject({ daily: 15000, basis: 'monthly' })
  })
  test('日本人の月給だけの人は 月給×12÷310', () => {
    expect(personOnDate({ id: 4, visa: 'none', salary: 310000 }, '2026-10-01')).toMatchObject({ daily: 12000, basis: 'monthly' })
  })
  test('改定前の単価が分からない（prev が無い）人は数えない', () => {
    expect(personOnDate({ id: 5, visa: 'none', rate: 20000, rateFrom: '2026-10-01' }, '2026-09-01')).toBeNull()
  })
  test('入社前・退職後は数えない（退職日の当日は在籍）', () => {
    const w = { id: 6, visa: 'none', rate: 15000, hireDate: '2026-04-01', retired: '2026-09-30' }
    expect(personOnDate(w, '2026-03-01')).toBeNull()
    expect(personOnDate(w, '2026-09-01')?.daily).toBe(15000)
    expect(personOnDate({ ...w, retired: '2026-10-01' }, '2026-10-01')?.daily).toBe(15000)
    expect(personOnDate(w, '2026-10-01')).toBeNull()
    expect(personOnDate({ ...w, retired: 'true' }, '2026-09-01')).toBeNull()
  })
  test('会社は HFU の表記ゆれをそろえる', () => {
    expect(personOnDate({ id: 7, visa: 'none', rate: 1, org: 'HFU' }, '2026-10-01')?.org).toBe('hfu')
  })
  test('buildPeople は単価の無い人を外して番号順に並べる', () => {
    const ps = buildPeople([{ id: 9, visa: 'none', rate: 1 }, { id: 8, visa: 'none' }, { id: 7, visa: 'none', rate: 2 }], '2026-10-01')
    expect(ps.map(p => p.id)).toEqual([7, 9])
  })
})

describe('平均日給: 数える人', () => {
  test('役員・事務は入れない／会社・月給の人で絞れる', () => {
    const ps = [P(1, 30000, 'jp', { job: 'yakuin' }), P(2, 20000), P(3, 10000, 'foreign', { org: 'hfu' }), P(4, 12000, 'jp', { basis: 'monthly' })]
    expect(ps.filter(p => inScope(p, DEFAULT_AVG_FILTER, 'all')).map(p => p.id)).toEqual([2, 3, 4])
    expect(ps.filter(p => inScope(p, DEFAULT_AVG_FILTER, 'jp')).map(p => p.id)).toEqual([2, 4])
    expect(ps.filter(p => inScope(p, { org: 'hfu', includeMonthly: true }, 'all')).map(p => p.id)).toEqual([3])
    expect(ps.filter(p => inScope(p, { org: 'all', includeMonthly: false }, 'all')).map(p => p.id)).toEqual([2, 3])
  })
  test('statOf', () => {
    expect(statOf([])).toEqual({ n: 0, avg: null, min: null, max: null })
    expect(statOf([P(1, 10000), P(2, 20000)])).toEqual({ n: 2, avg: 15000, min: 10000, max: 20000 })
  })
})

describe('平均日給: 動いた理由の内訳', () => {
  test('辞めた人・昇給・入った人の3つを足すと前後の差に一致する', () => {
    const from = [P(1, 20000), P(2, 18000), P(3, 10000, 'foreign'), P(4, 25000)]
    const to = [P(1, 20600), P(2, 18500), P(3, 10500, 'foreign'), P(5, 9000, 'foreign'), P(6, 9500, 'foreign')]
    const d = decomposeAverage(from, to)
    expect(d.stayers).toBe(3)
    expect(d.leavers).toBe(1)
    expect(d.joiners).toBe(2)
    expect(d.leaverEffect + d.raiseEffect + d.joinerEffect).toBeCloseTo(d.avgTo! - d.avgFrom!, 9)
    expect(d.leaverEffect).toBeLessThan(0)   // 平均より高い人が辞めた
    expect(d.raiseEffect).toBeGreaterThan(0)
    expect(d.joinerEffect).toBeLessThan(0)   // 平均より安く入った
    expect(d.raisePerStayer).toBeCloseTo(1600 / 3, 9)
    expect(d.leaverAvg).toBe(25000)
    expect(d.joinerAvg).toBe(9250)
  })
  test('全員入れ替わり・片方が空でも落ちない', () => {
    const d = decomposeAverage([P(1, 10000)], [P(2, 12000)])
    expect(d.joinerEffect).toBe(2000)
    expect(d.raisePerStayer).toBeNull()
    const e = decomposeAverage([], [P(2, 12000)])
    expect(e.avgFrom).toBeNull()
    expect(e.leaverEffect + e.raiseEffect + e.joinerEffect).toBe(0)
  })
})

describe('平均日給: 平均を保つのに必要な採用', () => {
  test('昇給後の平均が目標以下なら0人', () => {
    expect(requiredHires({ n: 40, avgNow: 14000, raisePerPerson: 200, target: 14250, entryDaily: 11000 }).needed).toBe(0)
  })
  test('式どおりに切り上げ、採用後の平均は目標以下になる', () => {
    const r = requiredHires({ n: 40, avgNow: 14250, raisePerPerson: 550, target: 14250, entryDaily: 11000 })
    expect(r.avgAfterRaise).toBe(14800)
    expect(r.needed).toBe(7)   // 40×550÷3250 = 6.77…
    expect(r.avgAfterHire!).toBeLessThanOrEqual(14250)
    expect(requiredHires({ n: 40, avgNow: 14250, raisePerPerson: 550, target: 14250, entryDaily: 11000 + 0 }).needed).toBe(7)
  })
  test('ちょうど割り切れるときに1人多くならない', () => {
    // 10×(15000−14000)÷(14000−9000) = 2
    expect(requiredHires({ n: 10, avgNow: 15000, raisePerPerson: 0, target: 14000, entryDaily: 9000 }).needed).toBe(2)
  })
  test('入社日給が目標以上なら保てない', () => {
    expect(requiredHires({ n: 40, avgNow: 14250, raisePerPerson: 550, target: 14250, entryDaily: 14250 }).needed).toBeNull()
  })
})

describe('平均日給: 月の並び', () => {
  test('shiftYm / ymRange は年をまたぐ', () => {
    expect(shiftYm('202512', 1)).toBe('202601')
    expect(shiftYm('202601', -1)).toBe('202512')
    expect(shiftYm('202610', -12)).toBe('202510')
    expect(ymRange('202511', '202602')).toEqual(['202511', '202512', '202601', '202602'])
  })
})

describe('平均日給: 画面へ渡す形', () => {
  const snap = (ym: string, people: WageRatePerson[]) => ({ ym, asOf: '', source: 'cron' as const, takenAt: '', people })
  test('1年前の点がある月を比べる・無ければ最初と最新', () => {
    const a = snap('202510', [P(1, 20000), P(2, 10000, 'foreign')])
    const b = snap('202610', [P(1, 20500), P(2, 10300, 'foreign'), P(3, 9000, 'foreign')])
    const v = buildAvgWageView([b, a], DEFAULT_AVG_FILTER)
    expect(v.points.map(p => p.ym)).toEqual(['202510', '202610'])
    expect(v.points[1].foreignShare).toBeCloseTo(2 / 3, 9)
    expect(v.comparisons).toHaveLength(1)
    expect(v.comparisons[0]).toMatchObject({ from: '202510', to: '202610' })
    expect(v.comparisons[0].jp.raisePerStayer).toBe(500)
    const w = buildAvgWageView([snap('202510', [P(1, 1)]), snap('202511', [P(1, 2)])], DEFAULT_AVG_FILTER)
    expect(w.comparisons[0]).toMatchObject({ from: '202510', to: '202511' })
  })
  test('1人ずつの単価は渡さない', () => {
    const v = buildAvgWageView([snap('202610', [P(1, 12345)])], DEFAULT_AVG_FILTER)
    expect(JSON.stringify(v)).not.toContain('"people"')
  })
})

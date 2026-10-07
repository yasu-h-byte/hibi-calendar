/**
 * 経営コックピットへ渡す在籍スタッフの給料の見込み（lib/integration-workers.ts）
 */
import { describe, test, expect } from 'vitest'
import { projectWorker, buildWorkersResult, sumByFiscalYear } from '@/lib/integration-workers'
import { dailyForStep, ageAdjustment } from '@/lib/jp-wage'
import { curveRaiseAt } from '@/lib/wage-curve'
import type { Worker } from '@/types'

const base = (o: Partial<Worker>): Worker => ({ id: 1, name: 't', company: '日比', visaType: 'none', token: '', ...o }) as Worker

describe('日本人（号俸）', () => {
  test('10月に評語A + 年齢調整だけ号が上がり、月の給料は 日額 × 310日 ÷ 12', () => {
    const w = base({ jpGrade: '3G', jpStep: 10, rate: dailyForStep('3G', 10), birthDate: '1990-05-01', hireDate: '2020-04-01' })
    const m = projectWorker(w, '2026-09', 3)
    expect(m[0].jpStep).toBe(10)
    expect(m[0].pay).toBe(Math.round((dailyForStep('3G', 10) * 310) / 12))
    const pitch = 4 + ageAdjustment(36, '3G')
    expect(m[1].ym).toBe('2026-10')
    expect(m[1].jpStep).toBe(10 + pitch)
    expect(m[2].jpStep).toBe(10 + pitch)
  })
  test('入社6か月未満の10月は上げない', () => {
    const w = base({ jpGrade: '1G', jpStep: 5, rate: dailyForStep('1G', 5), birthDate: '2000-01-01', hireDate: '2026-06-01' })
    const m = projectWorker(w, '2026-09', 2)
    expect(m[1].jpStep).toBe(5)
  })
  test('60号で止まる', () => {
    const w = base({ jpGrade: '5G', jpStep: 59, rate: dailyForStep('5G', 59), birthDate: '1980-01-01', hireDate: '2010-01-01' })
    expect(projectWorker(w, '2026-09', 14).every((x) => (x.jpStep ?? 0) <= 60)).toBe(true)
  })
})

describe('ベトナム人（時給）', () => {
  test('入社した月に、逓減カーブの昇給', () => {
    const w = base({ visaType: 'tokutei1', hourlyRate: 1500, hireDate: '2022-03-15' })
    const m = projectWorker(w, '2027-02', 2)
    expect(m[0].hourly).toBe(1500)
    // 2027-03 は入社5年目の終わり（4年在籍した後の昇給）
    expect(m[1].hourly).toBe(1500 + curveRaiseAt(4))
    expect(m[1].pay).toBe((1500 + curveRaiseAt(4)) * 140)
  })
})

describe('在籍・帰国', () => {
  test('入社前と退職後は 0', () => {
    const w = base({ visaType: 'jisshu1', hourlyRate: 1300, hireDate: '2026-12-01', retired: '2027-01-31' })
    const m = projectWorker(w, '2026-11', 4)
    expect(m.map((x) => x.active)).toEqual([false, true, true, false])
    expect(m[0].pay).toBe(0)
  })
  test('まるごと帰国の月は 0', () => {
    const w = base({ visaType: 'tokutei1', hourlyRate: 1400, hireDate: '2020-04-01' })
    const m = projectWorker(w, '2026-11', 3, [{ startDate: '2026-12-01', endDate: '2026-12-31' }])
    expect(m[1].homeLeave).toBe(true)
    expect(m[1].pay).toBe(0)
    expect(m[2].pay).toBeGreaterThan(0)
  })
})

describe('期ごとの合計と返す形', () => {
  test('10月〜9月で足し、会社負担の社会保険を足す', () => {
    const w = base({ visaType: 'tokutei1', hourlyRate: 1400, hireDate: '2020-04-01' })
    const y = sumByFiscalYear(projectWorker(w, '2026-10', 12), 30)
    expect(y).toHaveLength(1)
    expect(y[0].fyStart).toBe(2026)
    expect(y[0].activeMonths).toBe(12)
    expect(y[0].welfare).toBeGreaterThan(0)
    expect(y[0].total).toBe(y[0].pay + y[0].welfare)
  })
  test('役員と、前に辞めた人は返さない。所属と国籍を付ける', () => {
    const r = buildWorkersResult({
      workers: [
        base({ id: 1, jobType: 'yakuin' }),
        base({ id: 2, retired: '2025-01-31', hourlyRate: 1300, visaType: 'jisshu2' }),
        base({ id: 3, company: 'HFU', visaType: 'jisshu2', hourlyRate: 1300, jobType: 'tobi' }),
      ],
      homeLeaves: [],
      lastClosed: new Map([[3, { ym: '2026-09', totalCost: 250000 }]]),
      fromYm: '2026-10',
      months: 12,
      todayIso: '2026-10-07',
    })
    expect(r.workers.map((w) => w.id)).toEqual([3])
    expect(r.workers[0]).toMatchObject({ company: 'hfu', nationality: 'vn', field: true, lastClosed: { totalCost: 250000 } })
    expect(r.starting.vnHourly).toBe(1280)
  })
})

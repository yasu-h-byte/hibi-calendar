/**
 * 旧ルール継続者の所定日数（workerPrescribedDays）テスト
 *
 * 背景:
 *   2026-06-XX 修正前、旧ルール継続者 (useOldRules=true) でも
 *   現場 calendar (siteWorkDaysMap) の値が site-specific に上書き採用されていた。
 *   例: フン(104) を IH 現場(20日設定) のみに配置 → workerPrescribedDays=20
 *       本来、旧ルールは「日曜のみ休み+祝日 = 月23日」が原則
 *
 * 修正後:
 *   useOldRules=true なら、site calendar の上書きを skip し、
 *   全社所定 (prescribedDays = main.workDays[ym]) をそのまま採用。
 */
import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'

function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${day}`
}

function buildMain(overrides: Partial<MainData>): MainData {
  return {
    workers: [],
    sites: [
      { id: 'ih', name: 'IH現場', start: '', end: '', foreman: 0, archived: false },
      { id: 'sasazuka', name: '笹塚', start: '', end: '', foreman: 0, archived: false },
    ],
    subcons: [],
    assign: {
      ih: { workers: [], subcons: [] },
      sasazuka: { workers: [], subcons: [] },
    },
    massign: {},
    billing: {},
    workDays: { '202605': 23 },  // 全社所定: 23日 (旧ルール基準)
    siteWorkDays: {
      '202605': {
        ih: 20,         // IH 現場の calendar (土曜も休む変形労働制)
        sasazuka: 23,   // 笹塚現場の calendar (日曜のみ休み)
      },
    },
    locks: {},
    plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 },
    mforeman: {},
    ...overrides,
  } as MainData
}

describe('旧ルール継続者の所定日数 (workerPrescribedDays)', () => {
  test('useOldRules=true: IH 現場のみ配置でも全社23日が採用される (フンケース)', () => {
    const main = buildMain({
      workers: [{
        id: 104, name: 'フン', org: 'hibi', visa: 'tokutei2', job: 'tobi',
        rate: 0, hourlyRate: 2354, otMul: 1.25,
        hireDate: '2023-01-01', retired: '',
        useOldRules: true, token: 'fun-token',
      } as MainData['workers'][0]],
      assign: { ih: { workers: [104], subcons: [] }, sasazuka: { workers: [], subcons: [] } },
    })
    const attD: Record<string, { w: number; p?: number }> = {}
    // 10日 IH 出勤
    for (const d of [1, 2, 4, 5, 6, 7, 8, 9, 11, 12]) {
      Object.assign(attD, { [attKey('ih', 104, '202605', d)]: { w: 1 } })
    }
    // 10日 有給
    for (const d of [13, 14, 15, 16, 18, 19, 20, 21, 22, 23]) {
      Object.assign(attD, { [attKey('ih', 104, '202605', d)]: { w: 0, p: 1 } })
    }
    const result = computeMonthly(main, attD, {}, '202605', 23, { ih: 20, sasazuka: 23 }, 20)
    const w = result.workers.find(x => x.id === 104)!

    // 旧ルール: 全社23日が採用される
    expect(w.prescribedHours).toBeCloseTo(23 * 20 / 3, 1)  // 23日 × 6.667h = 153.33h
    expect(w.absence).toBe(3)  // 23 - 10 - 10 = 3日欠勤
    expect(w.absentDeduction).toBeGreaterThan(40000)  // 2354 × 6.667 × 3 ≈ ¥47,080
    expect(w.absentDeduction).toBeLessThan(48000)
  })

  test('useOldRules=false (新ルール): IH 現場のみ配置なら 20日が採用される (変形労働制)', () => {
    const main = buildMain({
      workers: [{
        id: 105, name: 'ハウ', org: 'hibi', visa: 'tokutei2', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25,
        hireDate: '2023-01-01', retired: '',
        useOldRules: false, token: 'hau-token',
      } as MainData['workers'][0]],
      assign: { ih: { workers: [105], subcons: [] }, sasazuka: { workers: [], subcons: [] } },
    })
    const attD: Record<string, { w: number }> = {}
    for (const d of [1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23]) {
      Object.assign(attD, { [attKey('ih', 105, '202605', d)]: { w: 1 } })
    }
    const result = computeMonthly(main, attD, {}, '202605', 23, { ih: 20, sasazuka: 23 }, 20)
    const w = result.workers.find(x => x.id === 105)!
    // 新ルール: regularWorkDays=20, baseDays=20 → 追加所定なし、欠勤なし
    expect(w.absentDeduction || 0).toBe(0)
  })

  test('useOldRules=true: 複数現場配置でも全社所定が優先される', () => {
    const main = buildMain({
      workers: [{
        id: 106, name: 'テスト', org: 'hibi', visa: 'tokutei2', job: 'tobi',
        rate: 0, hourlyRate: 2000, otMul: 1.25,
        hireDate: '2023-01-01', retired: '',
        useOldRules: true, token: 't-token',
      } as MainData['workers'][0]],
      assign: { ih: { workers: [106], subcons: [] }, sasazuka: { workers: [106], subcons: [] } },
    })
    const attD: Record<string, { w: number }> = {}
    // IH 5日 + 笹塚 5日 + 残り欠勤
    for (const d of [1, 2, 4, 5, 6]) {
      Object.assign(attD, { [attKey('ih', 106, '202605', d)]: { w: 1 } })
    }
    for (const d of [7, 8, 9, 11, 12]) {
      Object.assign(attD, { [attKey('sasazuka', 106, '202605', d)]: { w: 1 } })
    }
    const result = computeMonthly(main, attD, {}, '202605', 23, { ih: 20, sasazuka: 23 }, 20)
    const w = result.workers.find(x => x.id === 106)!
    // 旧ルール: 全社23日 - 出勤10 - 有給0 = 13日欠勤
    expect(w.absence).toBe(13)
  })

  test('4月以前 (ym<202605) は useOldRules フラグに関わらず旧ルール扱い', () => {
    const main = buildMain({
      workers: [{
        id: 107, name: '4月テスト', org: 'hibi', visa: 'tokutei2', job: 'tobi',
        rate: 0, hourlyRate: 2000, otMul: 1.25,
        hireDate: '2023-01-01', retired: '',
        useOldRules: false,  // 新ルール設定だが、ym<202605 なので旧ルール
        token: 'apr-token',
      } as MainData['workers'][0]],
      assign: { ih: { workers: [107], subcons: [] }, sasazuka: { workers: [], subcons: [] } },
      workDays: { '202604': 22 },
      siteWorkDays: { '202604': { ih: 18, sasazuka: 22 } },
    })
    const attD: Record<string, { w: number }> = {}
    for (const d of [1, 2, 3]) {
      Object.assign(attD, { [attKey('ih', 107, '202604', d)]: { w: 1 } })
    }
    const result = computeMonthly(main, attD, {}, '202604', 22, { ih: 18, sasazuka: 22 }, 20)
    const w = result.workers.find(x => x.id === 107)!
    // 4月以前: useOldRules=false でも site calendar (18) ではなく 全社所定 (22) が使われる
    expect(w.absence).toBe(19)  // 22 - 3 - 0 - 0 = 19
  })
})

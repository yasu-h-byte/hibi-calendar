import { describe, test, expect, vi } from 'vitest'
import type { AttendanceEntry } from '@/types'

/**
 * 評価者ウェイトの共働日数（2026-09-10 出面ベース化）
 *
 * 大介さん（職長だが担当現場なし）が白戸職長の現場でアインと一緒に働いていた期間が
 * 「共働 0 日 → 0.1」になっていた。評価者本人の同日同現場の出勤も共働として数える。
 */
const ATT: Record<string, { d: Record<string, AttendanceEntry> }> = {}
vi.mock('@/lib/compute', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/compute')>()
  return {
    ...mod,
    getAttData: vi.fn(async (ym: string) => ATT[ym] ?? { d: {} }),
    getMainData: vi.fn(async () => { throw new Error('main は引数で渡す') }),
  }
})
import { calcEvaluatorWeights } from '@/lib/evaluator-weights'
import type { MainData } from '@/lib/compute'

const main = {
  workers: [], subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
  sites: [
    { id: 'siteA', name: '白戸現場', start: '', end: '', foreman: 2, archived: false },
    { id: 'siteB', name: '大川現場', start: '', end: '', foreman: 3, archived: false },
  ],
  mforeman: {},
  defaultRates: { tobiRate: 25000, dokoRate: 20000 },
} as unknown as MainData

function put(ym: string, sid: string, wid: number, day: number, entry: AttendanceEntry = { w: 1 } as AttendanceEntry) {
  ATT[ym] ??= { d: {} }
  ATT[ym].d[`${sid}_${wid}_${ym}_${day}`] = entry
}

// 2026-08: アイン(105) が siteA に 1〜10日、siteB に 11〜12日出勤
for (let d = 1; d <= 10; d++) put('202608', 'siteA', 105, d)
for (let d = 11; d <= 12; d++) put('202608', 'siteB', 105, d)
// 大介(6): siteA に 1〜8日 一緒に出勤（職長登録なし）。9日は有給（共働に数えない）
for (let d = 1; d <= 8; d++) put('202608', 'siteA', 6, d)
put('202608', 'siteA', 6, 9, { p: 1 } as AttendanceEntry)
// 白戸(2): siteA の職長。本人は 1〜3日しか出勤していないが、責任現場なので 10日全部が共働
for (let d = 1; d <= 3; d++) put('202608', 'siteA', 2, d)
// 大川(3): siteB の職長（本人の出勤なし）→ 11〜12日の2日
// 政仁(1): 固定ウェイト

describe('calcEvaluatorWeights: 出面ベースの共働', () => {
  test('同じ現場・同じ日の出勤を共働として数える（職長登録がなくても）', async () => {
    const w = await calcEvaluatorWeights(105, [1, 2, 3, 6, 0], '2026-09-10', main)
    expect(w[6].yearDays).toBe(8)      // 1〜8日。有給の9日は含まない
    expect(w[6].weight).toBeGreaterThan(0.1)
    expect(w[2].yearDays).toBe(10)     // 責任現場なので本人不在の日も共働
    expect(w[3].yearDays).toBe(2)      // siteB の職長分
    expect(w[1].weight).toBe(0.7)      // 固定
    expect(w[0].weight).toBe(0.5)
  })
  test('直近90日は年間の部分集合', async () => {
    const w = await calcEvaluatorWeights(105, [6], '2026-09-10', main)
    expect(w[6].recentDays).toBe(8)
    expect(w[6].recentDays).toBeLessThanOrEqual(w[6].yearDays)
  })
  test('職長本人が責任現場に出勤していても二重に数えない', async () => {
    const w = await calcEvaluatorWeights(105, [2], '2026-09-10', main)
    expect(w[2].yearDays).toBe(10)
  })
})

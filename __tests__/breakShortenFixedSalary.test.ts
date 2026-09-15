import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/**
 * フォン(207)・タン(208): 旧ルール固定月給（useOldRules）・7時間契約（日給8,890 = 時給1,270 × 7）。
 * 2026-09-14 代表決定: 残業・休憩短縮手当の単価は契約時給 1,270円。
 * 旧来の「日給 ÷ 6h40m」だと 1,333.5円（残業1,667円）で契約より高く出ていた。
 * フン(104: 日給15,693 ≠ 2,403×7) は従来どおり残業単価 2,943円。
 */
function main(): MainData {
  return {
    workers: [
      { id: 207, name: 'フォン', org: 'hfu', visa: 'jisshu1', job: 'tobi', rate: 8890, hourlyRate: 1270, salary: 213784, otMul: 1.25, hireDate: '2026-06-01', token: '', useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202609' },
      { id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25, hireDate: '2017-10-01', token: '', useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202609' },
    ],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { s: { workers: [207, 104], subcons: [] } }, massign: {}, billing: {}, workDays: { '202608': 23, '202609': 23 }, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}
const WORK = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]  // 11日
function att(ym: string) {
  const a: Record<string, AttendanceEntry> = {}
  for (const wid of [207, 104]) {
    for (const d of WORK) a[`s_${wid}_${ym}_${d}`] = { w: 1, o: d === 1 ? 2 : 0 } as unknown as AttendanceEntry  // 1日に残業2h
    a[`s_${wid}_${ym}_15`] = { p: 1 } as unknown as AttendanceEntry  // 有給日は対象外
  }
  return a
}
const run = (ym: string, id: number) => computeMonthly(main(), att(ym), {}, ym, 23, undefined, 20).workers.find(x => x.id === id)!

describe('7時間契約の固定月給者は契約時給で計算（2026-09分〜）', () => {
  test('フォン9月: 休憩短縮 = 11日×20分×1,270、残業 = ceil(1,270×1.25)×2h、エラーなし', () => {
    const errs: string[] = []
    const orig = console.error; console.error = (...a: unknown[]) => { errs.push(String(a[0])) }
    const w = run('202609', 207)
    console.error = orig
    expect(w.breakShortenAllowance).toBe(Math.ceil(1270 * 11 * 20 / 60))
    expect(w.otAllowance).toBe(1588 * 2)
    expect(errs).toEqual([])
  })
  test('フォン9月: 欠勤控除・日給は 8,890 のまま（23所定 − 11出勤 − 1有給 = 11日）', () => {
    const w = run('202609', 207)
    expect(w.absentDeduction).toBe(8890 * 11)
  })
  test('7月分以前は従来どおり（日給÷6h40m）', () => {
    const w = run('202607', 207)
    expect(w.otAllowance).toBe(Math.ceil(Math.ceil(8890 / (20 / 3) * 1.25) * 2))
    expect(w.breakShortenAllowance).toBeUndefined()
  })
  test('8月分から契約時給 1,270円（残業単価 1,588円）で計算する（2026-09-15 代表決定）', () => {
    const w = run('202608', 207)
    expect(w.otAllowance).toBe(1588 * 2)
  })
  test('フンは対象外: 残業単価 2,943円のまま', () => {
    const w = run('202609', 104)
    expect(w.otAllowance).toBe(2943 * 2)
  })
})

/**
 * 「未入力」の数え方（lib/attendance-missing.ts・2026-10-02 総合点検）
 * 職長の一覧（lib/foreman-todo.ts evaluateSiteDay）と、職長スマホ（ログイン版）が同じ結果になること
 */
import { describe, test, expect } from 'vitest'
import { evaluateDayInputs, isWorkDayOf } from '@/lib/attendance-missing'
import { evaluateSiteDay } from '@/lib/foreman-todo'
import type { AttendanceEntry } from '@/types'

describe('isWorkDayOf', () => {
  test('承認済みカレンダーがあれば work だけ仕事の日', () => {
    const cal = { '1': 'work', '2': 'off', '3': 'holiday' }
    expect(isWorkDayOf(cal, 2026, 9, 1)).toBe(true)
    expect(isWorkDayOf(cal, 2026, 9, 2)).toBe(false)
    expect(isWorkDayOf(cal, 2026, 9, 3)).toBe(false)
    expect(isWorkDayOf(cal, 2026, 9, 4)).toBe(false)   // 記載なし＝仕事の日ではない
  })
  test('カレンダーが無ければ日曜以外', () => {
    expect(isWorkDayOf(null, 2026, 9, 6)).toBe(false)   // 2026-09-06 は日曜
    expect(isWorkDayOf(null, 2026, 9, 5)).toBe(true)    // 土曜
    expect(isWorkDayOf(undefined, 2026, 9, 21)).toBe(true)  // 祝日もカレンダーが無ければ仕事の日
  })
})

describe('evaluateDayInputs', () => {
  type W = { id: number; name: string }
  const workers: W[] = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }, { id: 4, name: 'D' }]
  const place = (m: Record<number, 'here' | 'elsewhere' | 'none'>) => (w: W) => m[w.id] || 'none'
  test('仕事の日: 別現場の人と対象外の人は数えない', () => {
    const r = evaluateDayInputs({
      workers, isWorkDay: true,
      placeOf: place({ 1: 'here', 2: 'elsewhere', 3: 'none', 4: 'none' }),
      expectedOn: w => w.id !== 4,   // D は入社前
    })
    expect(r.entered).toBe(1)
    expect(r.missing.map(w => w.id)).toEqual([3])
    expect(r.elsewhere.map(w => w.id)).toEqual([2])
    expect(r.notExpected).toBe(1)
    expect(r.total).toBe(2)   // 4人 − 別現場1 − 対象外1
  })
  test('休みの日: 入力した人だけが対象で、未入力は無い', () => {
    const r = evaluateDayInputs({ workers, isWorkDay: false, placeOf: place({ 1: 'here' }) })
    expect(r.entered).toBe(1)
    expect(r.total).toBe(1)
    expect(r.missing).toEqual([])
  })
  test('入力がある人は、対象外でも「入力あり」に数える（帰国中に入った hk など）', () => {
    const r = evaluateDayInputs({ workers, isWorkDay: true, placeOf: place({ 1: 'here' }), expectedOn: () => false })
    expect(r.entered).toBe(1)
    expect(r.notExpected).toBe(3)
    expect(r.total).toBe(1)
  })
})

describe('evaluateSiteDay（職長の一覧）は共通の数え方と同じ', () => {
  const ym = '202609'
  const att: Record<string, AttendanceEntry> = {
    [`ihi_101_${ym}_1`]: { w: 1, s: 'staff' },
    [`sasazuka_102_${ym}_1`]: { w: 1, s: 'staff' },   // 102 は IHI の配置のまま笹塚で入力
    [`ihi_104_${ym}_1`]: { w: 0.5 },                   // 半日（2026-10-02 まで未入力に落ちていた）
    [`ihi_105_${ym}_1`]: { w: 0 },                     // 残骸だけ＝未入力
  }
  const roster = [
    { id: 101, name: 'A' }, { id: 102, name: 'B' }, { id: 103, name: 'C' }, { id: 104, name: 'D' }, { id: 105, name: 'E' },
    { id: 106, name: 'F', hireDate: '2026-09-15' },    // 9/1 は入社前
  ]
  test('仕事の日', () => {
    const r = evaluateSiteDay(att, ['ihi'], roster, ym, 1, true)
    expect(r.entered).toBe(2)                              // A・D（半日）
    expect(r.missingNames).toEqual(['C', 'E'])
    expect(r.elsewhere).toEqual([{ name: 'B', siteIds: ['sasazuka'] }])
    expect(r.total).toBe(4)                                // 6 − 別現場1 − 入社前1
  })
  test('休みの日は入力した人だけ', () => {
    const r = evaluateSiteDay(att, ['ihi'], roster, ym, 1, false)
    expect(r.entered).toBe(2)
    expect(r.total).toBe(2)
    expect(r.missingNames).toEqual([])
  })
})

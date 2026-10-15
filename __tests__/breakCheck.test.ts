import { describe, test, expect } from 'vitest'
import { checkBreaksForDay, formatBreakIssue } from '@/lib/break-check'
import type { AttendanceEntry } from '@/types'

const vn = (id: number, e: Partial<AttendanceEntry>) => ({ workerId: id, name: `VN${id}`, visa: 'jisshu2', entry: { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, ...e } as AttendanceEntry })
const jp = (id: number, e: Partial<AttendanceEntry>) => ({ workerId: id, name: `JP${id}`, visa: 'none', entry: { w: 1, ...e } as AttendanceEntry })

describe('休憩チェックの点検', () => {
  test('ふつうの日（全員休憩あり・残業なし）は何も出ない', () => {
    expect(checkBreaksForDay(14, [vn(201, {}), vn(202, {}), jp(2, {})])).toEqual([])
  })
  test('① 午前・午後どちらもチェックなし → 出る（残業1hになる）', () => {
    const r = checkBreaksForDay(14, [vn(201, { b1: 0, b3: 0 })])
    expect(r).toHaveLength(1)
    expect(r[0].reasons).toContain('noBreaks')
    expect(r[0].overtime).toBe(1)
  })
  test('② 日本人は残業なしなのに、ベトナム人だけ残業 → 出る', () => {
    const r = checkBreaksForDay(14, [vn(201, { et: '18:00' }), jp(2, {})])
    expect(r[0].reasons).toEqual(['otAlone'])
  })
  test('② 日本人も残業していれば出ない', () => {
    expect(checkBreaksForDay(14, [vn(201, { et: '18:00' }), jp(2, { o: 1 })])).toEqual([])
  })
  test('② 日本人がその日にいなければ比べられないので出ない', () => {
    expect(checkBreaksForDay(14, [vn(201, { et: '18:00' })])).toEqual([])
  })
  test('③ ほかの人はみんな午後休憩を取っているのに、1人だけ無い → 出る', () => {
    const r = checkBreaksForDay(14, [vn(201, {}), vn(202, {}), vn(203, { b3: 0 })])
    expect(r.map(x => [x.workerId, x.reasons])).toEqual([[203, ['missedAfternoon']]])
  })
  test('有給・欠勤・現場都合休・時刻なしの日は見ない', () => {
    expect(checkBreaksForDay(14, [
      vn(201, { p: 1, b1: 0, b3: 0 }), vn(202, { r: 1, b1: 0, b3: 0 }), vn(203, { w: 0.6, b1: 0, b3: 0 }),
      { workerId: 204, name: 'x', visa: 'jisshu2', entry: { w: 1 } as AttendanceEntry },
    ])).toEqual([])
  })
  test('任意の休憩が無い現場（午後休憩なし）では①は出さない', () => {
    const ws = { startTime: '08:00', endTime: '17:00', morningBreak: { enabled: true, minutes: 30, mandatory: false }, lunchBreak: { enabled: true, minutes: 60, mandatory: true }, afternoonBreak: { enabled: false, minutes: 0, mandatory: false } }
    expect(checkBreaksForDay(14, [vn(201, { b1: 0, b3: 0, et: '16:30' })], ws)).toEqual([])
  })
  test('表示の文', () => {
    const r = checkBreaksForDay(14, [vn(201, { b1: 0, b3: 0 }), jp(2, {})])
    expect(formatBreakIssue(r[0], 10)).toBe('10/14 VN201: 午前・午後の休憩チェックなし／日本人は残業なしなのに残業あり（1h）')
  })
})

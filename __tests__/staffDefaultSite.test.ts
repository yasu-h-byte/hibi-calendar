import { describe, test, expect } from 'vitest'
import { defaultStaffSiteId } from '@/lib/staff-default-site'
import type { AttendanceEntry } from '@/types'

// スタッフのスマホで最初に出す現場（2026-10-05）。現場 A・B に配置、X は配置の外。A1 は A の工種サイト
const W = { w: 1 } as AttendanceEntry
const familyOf = (sid: string) => (sid === 'A' ? ['A', 'A1'] : [sid])
const run = (d: Record<string, AttendanceEntry | null>, prev?: Record<string, AttendanceEntry | null>, assigned = ['A', 'B']) =>
  defaultStaffSiteId({
    assigned, familyOf, workerId: 101, today: { ym: '202610', day: 5 },
    months: [{ ym: '202610', d }, ...(prev ? [{ ym: '202609', d: prev }] : [])],
  })

describe('スタッフのスマホで最初に出す現場', () => {
  test('配置が1つならその現場（記録は見ない）', () => {
    expect(run({ 'B_101_202610_3': W }, undefined, ['A'])).toBe('A')
  })
  test('配置が2つ: いちばん最近に出勤を入れた配置現場', () => {
    expect(run({ 'A_101_202610_1': W, 'B_101_202610_3': W })).toBe('B')
    expect(run({ 'A_101_202610_4': W, 'B_101_202610_3': W })).toBe('A')
  })
  test('工種サイトへの記録は親現場として数える', () => {
    expect(run({ 'B_101_202610_2': W, 'A1_101_202610_4': W })).toBe('A')
  })
  test('配置の外の現場・ほかの人・有給・欠・0.6補・先の日は材料にしない', () => {
    expect(run({
      'A_101_202610_1': W,
      'X_101_202610_4': W,
      'B_102_202610_4': W,
      'B_101_202610_2': { p: 1 } as AttendanceEntry,
      'B_101_202610_3': { r: 1 } as AttendanceEntry,
      'B_101_202610_4': { w: 0.6 } as AttendanceEntry,
      'B_101_202610_9': W,
    })).toBe('A')
  })
  test('今月に無ければ前月を見る。どこにも無ければ配置の先頭', () => {
    expect(run({}, { 'B_101_202609_30': W, 'A_101_202609_29': W })).toBe('B')
    expect(run({}, {})).toBe('A')
    expect(run({})).toBe('A')
  })
  test('社員番号が後ろに重なる人（1101）の記録を 101 のものと取り違えない', () => {
    expect(run({ 'A_101_202610_1': W, 'B_1101_202610_4': W })).toBe('A')
  })
})

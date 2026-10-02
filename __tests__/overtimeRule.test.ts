/**
 * 残業時間の決まり（calcOvertimeHours / withDerivedOvertime・2026-10-02）
 *
 * 確認すること:
 *   - 残業 = 日勤の実働 − 7h。取らなかった休憩はそのまま残業に入る
 *   - 休憩の長さは現場の workSchedule に従う（画面ごとに違う休憩で数えない）
 *   - 夜勤ブロックは残業に入れない
 *   - 職長画面のように o を持たない時刻つきの出勤でも、HFU → 日比建設 の請求書に残業が乗る
 */
import { describe, test, expect } from 'vitest'
import { calcOvertimeHours, withDerivedOvertime, type AttendanceEntry, type SiteWorkSchedule } from '@/types'
import type { MainData } from '@/lib/compute'
import { buildHfuInvoiceDraft } from '@/lib/hfu-invoice'

const base = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as AttendanceEntry
const shortLunch: SiteWorkSchedule = {
  startTime: '08:00', endTime: '17:00',
  morningBreak: { enabled: true, minutes: 30, mandatory: false },
  lunchBreak: { enabled: true, minutes: 45, mandatory: true },
  afternoonBreak: { enabled: true, minutes: 30, mandatory: false },
}

describe('calcOvertimeHours', () => {
  test('8:00〜17:00 で休憩を全部取れば残業なし', () => {
    expect(calcOvertimeHours(base)).toBe(0)
  })
  test('休憩を取らずに働いた分は残業に入る', () => {
    expect(calcOvertimeHours({ ...base, b3: 0 })).toBe(0.5)
    expect(calcOvertimeHours({ ...base, b1: 0, b2: 0, b3: 0 })).toBe(2)
  })
  test('現場の休憩設定で数える（昼45分の現場は 15分 残業が付く）', () => {
    expect(calcOvertimeHours(base, shortLunch)).toBe(0.3)
  })
  test('夜勤ブロックは残業に入れない', () => {
    expect(calcOvertimeHours({ ...base, ns: 1, nst: '20:00', net: '29:00' })).toBe(0)
  })
  test('時刻の無い日は入力された o をそのまま使う', () => {
    expect(calcOvertimeHours({ w: 1, o: 2.5 })).toBe(2.5)
  })
})

describe('withDerivedOvertime', () => {
  test('時刻のある日は o を付け直す（古い o は消える）', () => {
    expect(withDerivedOvertime({ ...base, et: '19:00' }).o).toBe(2)
    expect(withDerivedOvertime({ ...base, o: 3 }).o).toBeUndefined()
  })
  test('時刻の無い日は触らない', () => {
    const e = { w: 1, o: 1.5 } as AttendanceEntry
    expect(withDerivedOvertime(e)).toBe(e)
  })
})

describe('HFU → 日比建設 の請求書は時刻から残業を数える', () => {
  test('o を持たない時刻つきの出勤（職長画面の入力）でも残業の行が出る', () => {
    const main = {
      workers: [{ id: 201, name: 'グエン', org: 'hfu', visa: 'jisshu', job: 'tobi', rate: 0, otMul: 1.25, hireDate: '2020-01-01', token: '' }],
      sites: [{ id: 'own', name: '自社現場', start: '', end: '', foreman: 0, archived: false, workSchedule: shortLunch }],
      subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
      defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {}, nightDays: {},
      hfuInvoice: { tobiRate: 30000, dokoRate: 0 },
    } as unknown as MainData
    const attD: Record<string, AttendanceEntry> = {
      own_201_202609_1: { ...base, et: '19:00', s: 'foreman' },   // 昼45分の現場: 実働 9.25h → 残業 2.3h（o は無い）
    }
    const draft = buildHfuInvoiceDraft(main, attD, '202609')!
    const otLine = draft.lines.find(l => l.unit === 'h')!
    expect(otLine.days).toBe(2.3)
    expect(otLine.rate).toBe(4688)
  })
})

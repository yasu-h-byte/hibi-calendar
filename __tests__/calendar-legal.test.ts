import { describe, it, expect } from 'vitest'
import { checkCalendarLegal } from '@/lib/calendar-legal'

const Y = 2026, M = 3 // 2026年3月（31日）
const dim = new Date(Y, M, 0).getDate()
const dow = (d: number) => new Date(Y, M - 1, d).getDay()
// predicate(d) が true の日を 'work'、それ以外を 'off' にした days マップ
const build = (pred: (d: number) => boolean) => {
  const days: Record<string, string> = {}
  for (let d = 1; d <= dim; d++) days[String(d)] = pred(d) ? 'work' : 'off'
  return days
}

describe('checkCalendarLegal', () => {
  it('平日(月〜金)出勤・土日休み → 違反なし（月上限内・各週に休み・5連勤）', () => {
    const r = checkCalendarLegal(build(d => dow(d) !== 0 && dow(d) !== 6), `${Y}-0${M}`)
    expect(r.hasError).toBe(false)
    expect(r.hasWarn).toBe(false)
    expect(r.findings.filter(f => f.code === 'consecutive')).toHaveLength(0)
    expect(r.maxConsecutive).toBeLessThanOrEqual(6)
  })

  it('全日出勤 → 月総枠超(error) + 法定休日なし(warn) + 連勤(info)', () => {
    const r = checkCalendarLegal(build(() => true), '202603')
    expect(r.hasError).toBe(true)
    expect(r.findings.some(f => f.code === 'monthlyCap' && f.severity === 'error')).toBe(true)
    expect(r.findings.some(f => f.code === 'weeklyRest' && f.severity === 'warn')).toBe(true)
    expect(r.findings.some(f => f.code === 'consecutive')).toBe(true)
    expect(r.workHours).toBe(dim * 7)
  })

  it('ある1週だけ休みなし（他は休み）→ warn(法定休日) は出るが error は出ない', () => {
    // 最初の完全な日曜週（日曜起算で7日とも月内）を全出勤、それ以外は休み
    let weekStart = -1
    for (let d = 1; d + 6 <= dim; d++) { if (dow(d) === 0) { weekStart = d; break } }
    const r = checkCalendarLegal(build(d => d >= weekStart && d <= weekStart + 6), `${Y}-0${M}`)
    expect(r.hasError).toBe(false)               // 7日だけなので月総枠は超えない
    expect(r.hasWarn).toBe(true)
    expect(r.findings.some(f => f.code === 'weeklyRest')).toBe(true)
    expect(r.workDays).toBe(7)
  })

  it('週境界をまたぐ7連勤（各週には休みあり）→ consecutive(info) のみ・warn なし', () => {
    // 水曜起点で7日連続出勤（Sun を1日含むが、その週の他日は休み）
    let wed = -1
    for (let d = 1; d + 6 <= dim; d++) { if (dow(d) === 3) { wed = d; break } }
    const r = checkCalendarLegal(build(d => d >= wed && d <= wed + 6), '202603')
    expect(r.hasError).toBe(false)
    expect(r.hasWarn).toBe(false)                // どの完全週も全出勤ではない
    expect(r.findings.some(f => f.code === 'consecutive' && f.severity === 'info')).toBe(true)
    expect(r.maxConsecutive).toBe(7)
  })
})

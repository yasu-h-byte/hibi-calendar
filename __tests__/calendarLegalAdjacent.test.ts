import { describe, test, expect } from 'vitest'
import { checkCalendarLegal } from '@/lib/calendar-legal'
import { resolveDayType, countWorkDays, buildCalendarDays } from '@/lib/calendar'
import type { DayType } from '@/types'

/**
 * 法令チェックの月またぎ・欠けた日（2026-10-02 総合点検）
 * - 9/27(日)〜10/3(土) が全部出勤 → 9月（翌月込み）・10月（前月込み）どちらでも法定休日なしの警告
 * - 連勤は月をまたいで数える
 * - days にキーが無い日は「日曜休み・他は出勤」（画面・出面側と同じ）。旧は休み扱いで上限超えを見逃した
 */
function month(y: number, m: number, f: (d: number, dow: number) => DayType): Record<string, DayType> {
  const out: Record<string, DayType> = {}
  const dim = new Date(y, m, 0).getDate()
  for (let d = 1; d <= dim; d++) out[String(d)] = f(d, new Date(y, m - 1, d).getDay())
  return out
}

describe('月をまたぐ週と連勤', () => {
  // 9月: 27〜30 出勤、他は日曜休み。10月: 1〜3 出勤、4 日曜休み、以後は日曜休み
  const sep = month(2026, 9, (d, dow) => d >= 27 ? 'work' : (dow === 0 ? 'off' : 'work'))
  const oct = month(2026, 10, (d, dow) => d <= 3 ? 'work' : (dow === 0 ? 'off' : 'work'))

  test('隣の月が無ければ従来どおり月内だけ（またぐ週は出ない）', () => {
    expect(checkCalendarLegal(sep, '2026-09').findings.map(f => f.code)).not.toContain('weeklyRest')
    expect(checkCalendarLegal(oct, '2026-10').findings.map(f => f.code)).not.toContain('weeklyRest')
  })
  test('翌月・前月を渡すと 9/27〜10/3 の週が両方の月で警告になる', () => {
    const s = checkCalendarLegal(sep, '2026-09', { nextMonthDays: oct })
    expect(s.findings.find(f => f.code === 'weeklyRest')?.message).toContain('9/27〜10/3')
    const o = checkCalendarLegal(oct, '2026-10', { prevMonthDays: sep })
    expect(o.findings.find(f => f.code === 'weeklyRest')?.message).toContain('9/27〜10/3')
    expect(o.hasWarn).toBe(true)
  })
  test('連勤は月をまたいで数える（9/21〜10/3 の12連勤 → 両方の月で info）', () => {
    const sep2 = month(2026, 9, (d, dow) => d >= 21 ? 'work' : (dow === 0 ? 'off' : 'work'))
    const o = checkCalendarLegal(oct, '2026-10', { prevMonthDays: sep2 })
    const c = o.findings.find(f => f.code === 'consecutive')
    expect(c?.message).toContain('9/21〜10/3')
    expect(c?.message).toContain('13連勤')
    expect(o.maxConsecutive).toBe(13)
    expect(checkCalendarLegal(sep2, '2026-09', { nextMonthDays: oct }).maxConsecutive).toBe(13)
  })
})

describe('欠けた日の扱い', () => {
  test('キーが無い日は日曜休み・他は出勤。法令チェック・出勤日数・画面が同じ', () => {
    const partial: Record<string, DayType> = {}
    for (let d = 1; d <= 20; d++) partial[String(d)] = 'work'   // 21〜31 のキーなし（2026-10: 25日(日) だけ休み）
    expect(resolveDayType(partial, 2026, 10, 25)).toBe('off')
    expect(resolveDayType(partial, 2026, 10, 26)).toBe('work')
    expect(countWorkDays(partial, '2026-10')).toBe(30)
    const legal = checkCalendarLegal(partial, '2026-10')
    expect(legal.workDays).toBe(30)
    expect(legal.hasError).toBe(true)   // 30日×7h=210h > 177.1h（旧: 20日と数えて見逃した）
    const days = buildCalendarDays(2026, 10, partial)
    expect(days[24].dayType).toBe('off')
    expect(days[25].dayType).toBe('work')
  })
  test('全部出勤の月は上限超え、土日祝休みは通る', () => {
    const all = month(2026, 10, () => 'work')
    expect(checkCalendarLegal(all, '2026-10').hasError).toBe(true)
    const weekends = month(2026, 10, (_d, dow) => (dow === 0 || dow === 6) ? 'off' : 'work')
    expect(checkCalendarLegal(weekends, '2026-10').hasError).toBe(false)
  })
})

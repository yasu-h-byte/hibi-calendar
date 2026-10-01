import { describe, test, expect, afterEach, vi } from 'vitest'
import { todayJstIso, todayIso, currentYmJst, currentYearJst, todayJstDate, localMidnight } from '@/lib/date-utils'
import { currentYm6, nextYm7, prevYm6 } from '@/lib/ym'

// 2026-10-01 UTC 日付ずれの一括修正。サーバ（Vercel）は UTC で動くため、
// 日本時間 0〜9時は「UTC ではまだ前日」。この時間帯でも日本の今日・今月・今年を返すこと。

afterEach(() => { vi.useRealTimers() })

/** 日本時間 2026-10-01 03:00（= UTC 2026-09-30 18:00）＝月初・UTC ではまだ前月 */
const MONTH_START_EARLY = new Date('2026-09-30T18:00:00Z')
/** 日本時間 2027-01-01 08:59（= UTC 2026-12-31 23:59）＝元日・UTC ではまだ前年 */
const NEW_YEAR_EARLY = new Date('2026-12-31T23:59:00Z')

describe('日本時間の今日・今月・今年', () => {
  test('月初の 0〜9時でも当月', () => {
    vi.useFakeTimers({ now: MONTH_START_EARLY })
    expect(todayJstIso()).toBe('2026-10-01')
    expect(todayIso()).toBe('2026-10-01')
    expect(currentYmJst()).toBe('202610')
    const d = todayJstDate()
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 10, 1])
    expect(d.getDay()).toBe(4) // 2026-10-01 は木曜
  })

  test('元日の 0〜9時でも新しい年', () => {
    vi.useFakeTimers({ now: NEW_YEAR_EARLY })
    expect(currentYearJst()).toBe(2027)
    expect(currentYmJst()).toBe('202701')
  })

  test('lib/ym の今月・来月・前月も日本時間', () => {
    vi.useFakeTimers({ now: MONTH_START_EARLY })
    expect(currentYm6()).toBe('202610')
    expect(nextYm7()).toBe('2026-11')
    expect(prevYm6()).toBe('202609')
  })
})

describe('localMidnight', () => {
  test('出面の日付（new Date(y, m-1, d)）と同じ時刻になる', () => {
    expect(localMidnight('2026-10-01').getTime()).toBe(new Date(2026, 9, 1).getTime())
    expect(localMidnight('2026-10-01T12:34:56Z').getTime()).toBe(new Date(2026, 9, 1).getTime())
  })
})

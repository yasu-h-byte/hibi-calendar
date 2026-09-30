import { describe, test, expect } from 'vitest'
import { leaveRequestEarliestDate, leaveRequestDateError } from '@/lib/leave-rules'

describe('有給の申請期限（前日まで）', () => {
  test('翌日から申請できる', () => {
    expect(leaveRequestEarliestDate('2026-09-30')).toBe('2026-10-01')
    expect(leaveRequestDateError('2026-10-01', '2026-09-30')).toBeNull()
  })
  test('当日・過ぎた日は申請できない', () => {
    expect(leaveRequestDateError('2026-09-30', '2026-09-30')).not.toBeNull()
    expect(leaveRequestDateError('2026-09-29', '2026-09-30')).not.toBeNull()
  })
  test('月末・年末をまたぐ', () => {
    expect(leaveRequestEarliestDate('2026-12-31')).toBe('2027-01-01')
  })
})

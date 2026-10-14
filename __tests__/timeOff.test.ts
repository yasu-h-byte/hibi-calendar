import { describe, test, expect } from 'vitest'
import { mergeTimeOffDays, coversDate, sortTimeOff } from '@/lib/time-off'
import { can } from '@/lib/permissions'
import { requiredCapsForPath } from '@/lib/page-guard'

describe('休みの予定', () => {
  test('同じ人・同じ種類・同じ段階で続く日は1行にまとめる（月をまたいでも）', () => {
    const m = mergeTimeOffDays([
      { kind: 'leave', stage: 'approved', workerId: 201, date: '2026-10-31' },
      { kind: 'leave', stage: 'approved', workerId: 201, date: '2026-11-01' },
      { kind: 'leave', stage: 'approved', workerId: 201, date: '2026-11-03' },
      { kind: 'leave', stage: 'pending', workerId: 201, date: '2026-11-02' },
      { kind: 'absence', stage: 'reported', workerId: 202, date: '2026-10-20' },
    ])
    expect(m).toEqual([
      { kind: 'leave', stage: 'approved', workerId: 201, start: '2026-10-31', end: '2026-11-01' },
      { kind: 'leave', stage: 'approved', workerId: 201, start: '2026-11-03', end: '2026-11-03' },
      { kind: 'leave', stage: 'pending', workerId: 201, start: '2026-11-02', end: '2026-11-02' },
      { kind: 'absence', stage: 'reported', workerId: 202, start: '2026-10-20', end: '2026-10-20' },
    ])
  })
  test('その日にかかっているか', () => {
    expect(coversDate({ start: '2026-10-10', end: '2026-10-20' }, '2026-10-14')).toBe(true)
    expect(coversDate({ start: '2026-10-15', end: '2026-10-20' }, '2026-10-14')).toBe(false)
  })
  test('並び: 始まる日 → 帰国・有給・欠勤届', () => {
    const s = sortTimeOff([
      { start: '2026-10-20', kind: 'leave' as const, workerName: 'B' },
      { start: '2026-10-20', kind: 'home' as const, workerName: 'A' },
      { start: '2026-10-15', kind: 'absence' as const, workerName: 'C' },
    ])
    expect(s.map(x => x.workerName)).toEqual(['C', 'A', 'B'])
  })
  test('職長も見られる・画面の鍵', () => {
    expect(can({ role: 'foreman', workerId: 20 }, 'timeOff.view')).toBe(true)
    expect(can({ role: 'jimu', workerId: 304 }, 'timeOff.view')).toBe(true)
    expect(requiredCapsForPath('/time-off')).toEqual(['timeOff.view'])
  })
})

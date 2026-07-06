/**
 * 勤務時間一覧（社労士提出用）の1日分の実労働時間計算のテスト
 *
 * 回帰防止: 時間ベース入力(st/et)の日に、残業込みの実労働時間へさらに残業を
 *   足していた二重加算バグ（例: 8:00-19:30 実9.5h が 12h と表示）を解消した件。
 */
import { describe, test, expect } from 'vitest'
import { timesheetDayHours } from '@/lib/export'

describe('timesheetDayHours', () => {
  const prescribed = 7 // 変形労働時間制（5月以降）の所定7時間

  test('時間ベース入力: 実労働時間をそのまま総労働時間にする（残業を二重加算しない）', () => {
    // 8:00-19:30、昼休み+午前午後休憩=2h控除 → 実労働 9.5h
    const entry = { st: '08:00', et: '19:30', w: 1, b1: 1, b2: 1, b3: 1 }
    const { dayHours, dayOT } = timesheetDayHours(entry, prescribed)
    expect(dayHours).toBe(9.5)          // 9.5h（旧バグでは 9.5+2.5=12h だった）
    expect(dayOT).toBe(2.5)             // うち残業 = 9.5 - 7
  })

  test('時間ベース入力: 所定ちょうどなら残業0', () => {
    // 8:00-17:00、休憩2h → 実労働7h
    const entry = { st: '08:00', et: '17:00', w: 1, b1: 1, b2: 1, b3: 1 }
    const { dayHours, dayOT } = timesheetDayHours(entry, prescribed)
    expect(dayHours).toBe(7)
    expect(dayOT).toBe(0)
  })

  test('レガシー入力: 所定 + 残業o を総労働時間にする', () => {
    const entry = { w: 1, o: 2 }
    const { dayHours, dayOT } = timesheetDayHours(entry, prescribed)
    expect(dayHours).toBe(9)  // 所定7 + 残業2
    expect(dayOT).toBe(2)
  })

  test('レガシー入力: 残業なしなら所定のみ', () => {
    const entry = { w: 1 }
    const { dayHours, dayOT } = timesheetDayHours(entry, prescribed)
    expect(dayHours).toBe(7)
    expect(dayOT).toBe(0)
  })

  test('休業補償(0.6): 所定の0.6按分・残業なし', () => {
    const entry = { w: 0.6 }
    const { dayHours, dayOT } = timesheetDayHours(entry, prescribed)
    expect(dayHours).toBe(4.2)  // 7 × 0.6
    expect(dayOT).toBe(0)
  })
})

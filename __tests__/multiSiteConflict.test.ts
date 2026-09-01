import { describe, it, expect } from 'vitest'
import { detectMultiSiteConflict, dayShiftOccupancy } from '@/lib/attendance'
import type { AttendanceEntry } from '@/types'

/**
 * 同日多現場の重複ガード（2026-08-31 合計人工ベースへ改修）
 *
 * - 合計人工が1を超える組み合わせはブロック（1+1、1+0.5、P+1 など）
 * - **半日×2現場（0.5+0.5）は許可**（代表決定）
 * - 日勤＋夜勤は枠が別なので許可
 * - 現場休(h)は本人の枠を使わないので、別現場への出勤を妨げない
 */
const SITES = [
  { id: 'sasazuka', name: '笹塚' },
  { id: 'ihi', name: 'IHI' },
  { id: 'yaesu_night', name: '八重洲夜勤' },
]

const att = (sid: string, entry: Record<string, unknown>) =>
  ({ [`${sid}_4_202609_1`]: entry }) as unknown as Record<string, AttendanceEntry>

const check = (existSid: string, exist: Record<string, unknown>, target: string, newEntry?: Record<string, unknown>) =>
  detectMultiSiteConflict(att(existSid, exist), target, 4, '202609', 1, SITES, newEntry as AttendanceEntry | undefined)

describe('dayShiftOccupancy', () => {
  it('出勤は人工そのまま・全日ステータスは1・現場休と夜勤のみは0', () => {
    expect(dayShiftOccupancy({ w: 1 } as AttendanceEntry)).toBe(1)
    expect(dayShiftOccupancy({ w: 0.5 } as AttendanceEntry)).toBe(0.5)
    expect(dayShiftOccupancy({ w: 0.6 } as AttendanceEntry)).toBe(1)   // 0.6補償は全日
    expect(dayShiftOccupancy({ w: 0, p: 1 } as AttendanceEntry)).toBe(1)
    expect(dayShiftOccupancy({ w: 0, r: 1 } as AttendanceEntry)).toBe(1)
    expect(dayShiftOccupancy({ w: 0, h: 1 } as AttendanceEntry)).toBe(0)
    expect(dayShiftOccupancy({ ns: 1, nonly: 1 } as unknown as AttendanceEntry)).toBe(0)
    expect(dayShiftOccupancy(null)).toBe(0)
  })
})

describe('detectMultiSiteConflict（合計人工ベース）', () => {
  it('1人工＋1人工はブロック（本田さんのケース）', () => {
    expect(check('sasazuka', { w: 1 }, 'ihi', { w: 1 })).not.toBeNull()
  })

  it('半日×2現場（0.5+0.5）は許可', () => {
    expect(check('sasazuka', { w: 0.5 }, 'ihi', { w: 0.5 })).toBeNull()
  })

  it('0.5＋1 はブロック（合計1.5）', () => {
    expect(check('sasazuka', { w: 0.5 }, 'ihi', { w: 1 })).not.toBeNull()
    expect(check('sasazuka', { w: 1 }, 'ihi', { w: 0.5 })).not.toBeNull()
  })

  it('有給Pがある日に別現場へ出勤はブロック（二重払い防止）', () => {
    expect(check('sasazuka', { w: 0, p: 1 }, 'ihi', { w: 1 })).not.toBeNull()
    expect(check('sasazuka', { w: 0, p: 1 }, 'ihi', { w: 0.5 })).not.toBeNull()
  })

  it('出勤がある日に別現場へ有給Pを入れるのもブロック（承認・時季指定経路）', () => {
    expect(check('ihi', { w: 1 }, 'sasazuka', { w: 0, p: 1 })).not.toBeNull()
    expect(check('ihi', { w: 0.5 }, 'sasazuka', { w: 0, p: 1 })).not.toBeNull()
  })

  it('現場休(h)の現場がある日は、別現場への出勤を許可', () => {
    expect(check('sasazuka', { w: 0, h: 1 }, 'ihi', { w: 1 })).toBeNull()
  })

  it('日勤＋夜勤現場は許可（枠が別）', () => {
    expect(check('yaesu_night', { ns: 1, nonly: 1 }, 'ihi', { w: 1 })).toBeNull()
    expect(check('yaesu_night', { w: 1 }, 'ihi', { w: 1 })).toBeNull()  // 夜勤現場の w=1 も日勤枠とは別
  })

  it('newEntry 省略時は全日（1）として安全側に判定（スタッフ・職長経路）', () => {
    expect(check('sasazuka', { w: 1 }, 'ihi')).not.toBeNull()
    expect(check('sasazuka', { w: 0.5 }, 'ihi')).not.toBeNull()  // 0.5+1(省略時) = 1.5
    expect(check('sasazuka', { w: 0, h: 1 }, 'ihi')).toBeNull()
  })

  it('3現場目の0.5もブロック（0.5+0.5 済みの日）', () => {
    const data = {
      ...att('sasazuka', { w: 0.5 }),
      [`ihi_4_202609_1`]: { w: 0.5 } as AttendanceEntry,
    }
    const third = detectMultiSiteConflict(data, 'yaesu_night', 4, '202609', 1,
      [...SITES, { id: 'another_day', name: '別日勤' }], { w: 0.5 } as AttendanceEntry)
    // yaesu_night は夜勤なので許可される（日勤枠を数えない）
    expect(third).toBeNull()
    const thirdDay = detectMultiSiteConflict(data, 'another_day', 4, '202609', 1,
      [...SITES, { id: 'another_day', name: '別日勤' }], { w: 0.5 } as AttendanceEntry)
    expect(thirdDay).not.toBeNull()  // 日勤枠 0.5+0.5+0.5 = 1.5 → ブロック
  })
})

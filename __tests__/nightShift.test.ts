import { describe, it, expect } from 'vitest'
import {
  timeToMinutes, formatTimeLabel, calcDayShiftHours, calcNightShiftHours,
  calcActualHours, calcManDays, getNightRange, isNightShift,
  NIGHT_START_OPTIONS, NIGHT_END_OPTIONS, DAY_END_OPTIONS,
  AttendanceEntry,
} from '@/types'
import { calcNightShiftLegalRequiredPay } from '@/lib/compute'
import { computeAttendanceDeleteFields } from '@/lib/attendance'

// 台風待機で発生した夜勤の扱い（2026-08 実装）。
// 設計の要点:
//   - 終業は "29:00" のような24時超え表記で保存する（timeToMinutes が単調増加になる）
//   - w（出勤日数）は夜勤があっても 1。人工は calcManDays が ns から導出
//   - 日本人は 1.5人工（日勤＋夜勤なら 2.5人工）で支給し、法定必要額と比較して警告する

describe('24時超え表記', () => {
  it('timeToMinutes は 24 時以降もそのまま分換算する', () => {
    expect(timeToMinutes('17:00')).toBe(1020)
    expect(timeToMinutes('24:00')).toBe(1440)
    expect(timeToMinutes('29:00')).toBe(1740)  // 翌5:00
    expect(timeToMinutes('33:00')).toBe(1980)  // 翌9:00
  })

  it('画面表示は「翌H:MM」に変換される', () => {
    expect(formatTimeLabel('17:00')).toBe('17:00')
    expect(formatTimeLabel('23:30')).toBe('23:30')
    expect(formatTimeLabel('24:00')).toBe('翌0:00')
    expect(formatTimeLabel('29:00')).toBe('翌5:00')
    expect(formatTimeLabel('30:30')).toBe('翌6:30')
  })

  it('夜勤の選択肢が日付またぎをカバーする', () => {
    expect(NIGHT_START_OPTIONS[0]).toBe('15:00')
    expect(NIGHT_START_OPTIONS[NIGHT_START_OPTIONS.length - 1]).toBe('23:30')
    expect(NIGHT_END_OPTIONS).toContain('29:00')   // 翌5:00
    expect(NIGHT_END_OPTIONS[NIGHT_END_OPTIONS.length - 1]).toBe('33:00')
    // 日勤の終業は 23:00 まで（従来どおり・夜勤とは別レンジ）
    expect(DAY_END_OPTIONS[DAY_END_OPTIONS.length - 1]).toBe('23:00')
  })
})

describe('夜勤ブロックの実労働時間', () => {
  it('20:00→翌5:00・休憩60分 = 8時間', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, nst: '20:00', net: '29:00', nb: 60 }
    expect(calcNightShiftHours(e)).toBe(8)
  })

  it('日付をまたがない夜勤（17:00→23:00・休憩なし）も計算できる', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, nst: '17:00', net: '23:00', nb: 0 }
    expect(calcNightShiftHours(e)).toBe(6)
  })

  it('休憩は既定60分', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, nst: '20:00', net: '29:00' }
    expect(calcNightShiftHours(e)).toBe(8)
  })

  it('nst/net が無ければ夜勤ゼロ（st/et にフォールバックしない = 二重計上を防ぐ）', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, st: '08:00', et: '17:00' }
    expect(getNightRange(e)).toBeNull()
    expect(calcNightShiftHours(e)).toBe(0)
  })

  it('24時超え表記でない手入力データも翌日として救済する', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, nst: '20:00', net: '05:00', nb: 60 }
    expect(calcNightShiftHours(e)).toBe(8)
  })
})

describe('日勤ブロックと合計', () => {
  const ws = undefined  // 既定休憩 30/60/30

  it('日勤のみ 8:00-17:00（休憩120分）= 7時間', () => {
    const e: AttendanceEntry = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 }
    expect(calcDayShiftHours(e, ws)).toBe(7)
    expect(calcActualHours(e, ws)).toBe(7)
  })

  it('日勤＋夜勤: 日勤7h + 夜勤8h = 合計15h。日勤ブロック単体は7hのまま', () => {
    const e: AttendanceEntry = {
      w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1,
      ns: 1, nst: '20:00', net: '29:00', nb: 60,
    }
    expect(calcDayShiftHours(e, ws)).toBe(7)
    expect(calcNightShiftHours(e)).toBe(8)
    expect(calcActualHours(e, ws)).toBe(15)
  })

  it('夜勤のみ（nonly）は日勤ゼロ', () => {
    const e: AttendanceEntry = { w: 1, ns: 1, nonly: 1, nst: '20:00', net: '29:00', nb: 60 }
    expect(calcDayShiftHours(e, ws)).toBe(0)
    expect(calcActualHours(e, ws)).toBe(8)
  })

  it('日勤の終業が日付をまたぐ形で入っても実労働0hに落ちない（旧バグの回帰防止）', () => {
    // 補正が無いと end - start = 300 - 1200 = -900 → Math.max(0,...) で 0h になり、
    // 深夜手当だけが出る矛盾した給与計算になっていた
    const e: AttendanceEntry = { w: 1, st: '20:00', et: '05:00', b2: 1 }
    expect(calcDayShiftHours(e, ws)).toBe(8)
  })
})

describe('人工数（calcManDays）', () => {
  it('日勤のみは w のまま（既存挙動を変えない）', () => {
    expect(calcManDays({ w: 1, st: '08:00', et: '17:00' })).toBe(1)
    expect(calcManDays({ w: 0.5, st: '08:00', et: '12:00' })).toBe(0.5)
  })

  it('日勤＋夜勤 = 2.5人工', () => {
    expect(calcManDays({
      w: 1, st: '08:00', et: '17:00', ns: 1, nst: '20:00', net: '29:00',
    })).toBe(2.5)
  })

  it('夜勤のみ = 1.5人工', () => {
    expect(calcManDays({ w: 1, ns: 1, nonly: 1, nst: '20:00', net: '29:00' })).toBe(1.5)
  })

  it('日本人は st/et を持たないが nonly で日勤の有無を判別できる', () => {
    // 日給月給の日本人は始業終業を記録しないため、st/et の有無では判別不能
    expect(calcManDays({ w: 1, ns: 1, nst: '20:00', net: '29:00' })).toBe(2.5)
    expect(calcManDays({ w: 1, ns: 1, nonly: 1, nst: '20:00', net: '29:00' })).toBe(1.5)
  })

  it('半日出勤（0.5）＋夜勤 = 2.0人工。夜勤は日勤の長さに関係なく1.5人工', () => {
    // 2026-08-11 の実例: 午後から出勤（0.5）してそのまま台風待機に入った
    const night = { ns: 1, nst: '17:00', net: '29:00', nb: 60 }
    expect(calcManDays({ w: 0.5, ...night })).toBe(2)
    expect(calcManDays({ w: 1, ...night })).toBe(2.5)
    expect(calcManDays({ w: 0.5, nonly: 1, ...night })).toBe(1.5)
  })

  it('有給・欠勤・現場休・帰国中・試験は人工0', () => {
    expect(calcManDays({ w: 0, p: 1 })).toBe(0)
    expect(calcManDays({ w: 0, r: 1 })).toBe(0)
    expect(calcManDays({ w: 0, h: 1 })).toBe(0)
    expect(calcManDays({ w: 0, hk: 1 })).toBe(0)
    expect(calcManDays({ w: 0, exam: 1 })).toBe(0)
  })

  it('isNightShift は明示フラグのみを見る（深夜帯にかかる日勤を夜勤扱いしない）', () => {
    expect(isNightShift({ w: 1, st: '13:00', et: '23:00' })).toBe(false)
    expect(isNightShift({ w: 1, ns: 1, nst: '20:00', net: '29:00' })).toBe(true)
    expect(isNightShift(null)).toBe(false)
  })
})

describe('1.5人工が法定を満たすか（日本人・日給月給）', () => {
  const R = 15000  // 日額
  const args = (totalHours: number, nightHours: number, isLegalHoliday: boolean) => ({
    dailyRate: R, prescribedHours: 8, totalHours, nightHours, isLegalHoliday, otMul: 1.25,
  })
  /** 法定必要額を人工換算に直す（日額に依存しない比較にするため） */
  const inManDays = (yen: number) => Math.round((yen / R) * 1000) / 1000

  it('平日・実労働8h・深夜7h → 1.22人工。1.5人工で足りる', () => {
    expect(inManDays(calcNightShiftLegalRequiredPay(args(8, 7, false)))).toBeCloseTo(1.219, 2)
  })

  it('平日・実労働9.5h・深夜7h → 1.45人工。1.5人工でギリギリ足りる', () => {
    expect(inManDays(calcNightShiftLegalRequiredPay(args(9.5, 7, false)))).toBeCloseTo(1.453, 2)
  })

  it('平日・実労働11h・深夜7h → 1.69人工。1.5人工では不足', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(11, 7, false)))
    expect(need).toBeCloseTo(1.688, 2)
    expect(need).toBeGreaterThan(1.5)
  })

  it('日曜（法定休日）・実労働8h・深夜7h → 1.57人工。1.5人工では不足', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(8, 7, true)))
    expect(need).toBeCloseTo(1.569, 2)
    expect(need).toBeGreaterThan(1.5)
  })

  it('日曜・実労働7h・深夜7h → 1.40人工。1.5人工で足りる', () => {
    expect(inManDays(calcNightShiftLegalRequiredPay(args(7, 7, true)))).toBeCloseTo(1.4, 2)
  })

  it('日勤7h＋夜勤11h（通し18h）・深夜7h → 2.78人工。2.5人工では不足', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(18, 7, false)))
    expect(need).toBeCloseTo(2.781, 2)
    expect(need).toBeGreaterThan(2.5)
  })

  it('日勤7h＋夜勤6h（13h）・深夜1h → 1.81人工。2.5人工で余裕', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(13, 1, false)))
    expect(need).toBeCloseTo(1.813, 2)
    expect(need).toBeLessThan(2.5)
  })

  it('半日4h＋夜勤11h（通し15h）・深夜7h → 2.31人工必要。2.0人工では不足', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(15, 7, false)))
    expect(need).toBeCloseTo(2.313, 2)
    expect(need).toBeGreaterThan(2.0)
  })

  it('半日4h＋夜勤8h（12h）・深夜7h → 1.84人工。2.0人工で足りる', () => {
    const need = inManDays(calcNightShiftLegalRequiredPay(args(12, 7, false)))
    expect(need).toBeCloseTo(1.844, 2)
    expect(need).toBeLessThan(2.0)
  })

  it('日額が未設定なら0（判定不能なので警告を出さない）', () => {
    expect(calcNightShiftLegalRequiredPay({ ...args(8, 7, false), dailyRate: 0 })).toBe(0)
  })
})

describe('残骸フィールドの削除', () => {
  it('夜勤フィールドも削除対象に含まれる（ステータス変更で残骸が残らない）', () => {
    const fields = computeAttendanceDeleteFields({ w: 0, p: 1 })
    for (const f of ['ns', 'nonly', 'nst', 'net', 'nb', 'nnote']) {
      expect(fields).toContain(f)
    }
  })

  it('夜勤エントリでは夜勤フィールドが削除されない', () => {
    const fields = computeAttendanceDeleteFields({
      w: 1, ns: 1, nst: '20:00', net: '29:00', nb: 60, nnote: '台風待機',
    })
    for (const f of ['ns', 'nst', 'net', 'nb', 'nnote']) {
      expect(fields).not.toContain(f)
    }
    // nonly は未設定なので削除対象（= 日勤＋夜勤に切り替えたときに残骸が残らない）
    expect(fields).toContain('nonly')
  })
})

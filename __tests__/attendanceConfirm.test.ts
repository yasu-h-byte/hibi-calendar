import { describe, test, expect } from 'vitest'
import {
  confirmTargetYm, isSuspectCompanyRest, summarizeWorkerMonth, summaryFingerprint, mainSiteOfMonth,
} from '@/lib/attendance-confirm'

describe('確認する月（月末3日は当月・1〜10日は前月）', () => {
  test('9/28〜9/30 は 9月', () => {
    expect(confirmTargetYm('2026-09-28')).toBe('202609')
    expect(confirmTargetYm('2026-09-30')).toBe('202609')
  })
  test('10/1〜10/10 は 9月、10/11〜10/28 は出さない', () => {
    expect(confirmTargetYm('2026-10-01')).toBe('202609')
    expect(confirmTargetYm('2026-10-10')).toBe('202609')
    expect(confirmTargetYm('2026-10-11')).toBeNull()
    expect(confirmTargetYm('2026-10-28')).toBeNull()
    expect(confirmTargetYm('2026-10-29')).toBe('202610')
  })
  test('1月上旬は前年12月・2月末（28日の年）は26日から', () => {
    expect(confirmTargetYm('2027-01-05')).toBe('202612')
    expect(confirmTargetYm('2027-02-26')).toBe('202702')
    expect(confirmTargetYm('2027-02-25')).toBeNull()
  })
})

describe('会社都合の休みの選び間違いの疑い', () => {
  test('201 の 8/26 と同じ形（その他＋メモ 60%）は疑い', () => {
    expect(isSuspectCompanyRest({ w: 0, r: 1, rReason: 'other', rNote: '60%' })).toBe(true)
    expect(isSuspectCompanyRest({ w: 0, r: 1, rReason: 'other', rNote: 'nghỉ công trường' })).toBe(true)
    expect(isSuspectCompanyRest({ w: 0, r: 1, rReason: 'other', rNote: '現場休み' })).toBe(true)
  })
  test('私用・体調不良、メモが無関係なものは疑いにしない', () => {
    expect(isSuspectCompanyRest({ w: 0, r: 1, rReason: 'personal' })).toBe(false)
    expect(isSuspectCompanyRest({ w: 0, r: 1, rReason: 'other', rNote: '役所の手続き' })).toBe(false)
    expect(isSuspectCompanyRest({ w: 0.6 })).toBe(false)
  })
})

describe('1人・1か月の数え方', () => {
  const ym = '202608'
  const d = {
    ihi_201_202608_3: { w: 1, st: '06:30', et: '17:30', b1: 1, b2: 1, b3: 1, o: 2 },
    ihi_201_202608_4: { w: 1 },
    ihi_201_202608_5: { w: 0, p: 1 },
    ihi_201_202608_6: { w: 0.6 },
    ihi_201_202608_7: { w: 0, r: 1, rReason: 'personal' },
    ihi_201_202608_10: { w: 0, r: 1, rReason: 'other', rNote: '60%' },
    // 同じ日に2現場（出勤と休み）→ 休みを優先して1日
    ihi_201_202608_11: { w: 1 },
    kwsk_201_202608_11: { w: 0, r: 1, rReason: 'sick' },
    // 別の人（102 と 2012 は数えない）
    ihi_2012_202608_4: { w: 1 },
    ihi_102_202608_4: { w: 1 },
  }
  // 3〜12日を仕事の日、それ以外は休み（カレンダー）
  const cal: Record<string, string> = {}
  for (let i = 1; i <= 31; i++) cal[String(i)] = i >= 3 && i <= 12 ? 'work' : 'off'

  test('出勤・残業・有給・会社都合・自分の都合・未入力', () => {
    const s = summarizeWorkerMonth({ d, workerId: 201, ym, calDays: cal, todayIso: '2026-08-31' })
    expect(s.workDays).toBe(2)
    expect(s.otHours).toBe(2)
    expect(s.plDays).toBe(1)
    expect(s.compDays).toBe(1)
    expect(s.restDays).toBe(3)
    expect(s.restList.map(r => r.day)).toEqual([7, 10, 11])
    expect(s.restList.find(r => r.day === 10)?.suspect).toBe(true)
    expect(s.missingDays).toEqual([8, 9, 12])
  })
  test('未入力は今日までしか数えない・入社前は数えない', () => {
    const s = summarizeWorkerMonth({ d, workerId: 201, ym, calDays: cal, todayIso: '2026-08-09' })
    expect(s.missingDays).toEqual([8, 9])
    const s2 = summarizeWorkerMonth({ d: {}, workerId: 201, ym, calDays: cal, hireDate: '2026-08-10', todayIso: '2026-08-31' })
    expect(s2.missingDays).toEqual([10, 11, 12])
  })
  test('出面が変わると指紋が変わる', () => {
    const a = summarizeWorkerMonth({ d, workerId: 201, ym, calDays: cal, todayIso: '2026-08-31' })
    const b = summarizeWorkerMonth({ d: { ...d, ihi_201_202608_10: { w: 0.6 } }, workerId: 201, ym, calDays: cal, todayIso: '2026-08-31' })
    expect(summaryFingerprint(a)).not.toBe(summaryFingerprint(b))
    expect(summaryFingerprint(a)).toBe(summaryFingerprint(summarizeWorkerMonth({ d, workerId: 201, ym, calDays: cal, todayIso: '2026-08-31' })))
  })
  test('主現場は記録の一番多い現場', () => {
    expect(mainSiteOfMonth(d, 201, ym)).toBe('ihi')
    expect(mainSiteOfMonth(d, 999, ym)).toBeNull()
  })
})

import { breakShortenMinFor } from '@/lib/attendance-confirm'
describe('休憩短縮（旧契約の毎日20分）', () => {
  test('出勤した日だけ数える（現場都合休・休み・有給は除く・同じ日の2現場は1日）', () => {
    const d = {
      a_207_202610_1: { w: 1, st: '08:00', et: '17:00' },
      a_207_202610_2: { w: 1 },
      b_207_202610_2: { w: 0.5 },
      a_207_202610_3: { w: 0.6 },
      a_207_202610_5: { w: 0, r: 1 },
      a_207_202610_6: { w: 0, p: 1 },
    }
    const s = summarizeWorkerMonth({ d, workerId: 207, ym: '202610', calDays: null, todayIso: '2026-10-31', breakShortenMin: 20 })
    expect(s.breakShorten).toEqual({ minPerDay: 20, days: 2, minutes: 40 })
  })
  test('設定が無ければ出さない', () => {
    const s = summarizeWorkerMonth({ d: { a_1_202610_1: { w: 1 } }, workerId: 1, ym: '202610', calDays: null, todayIso: '2026-10-31' })
    expect(s.breakShorten).toBeUndefined()
  })
  test('適用開始月より前は0', () => {
    expect(breakShortenMinFor({ breakShortenMin: 20, breakShortenFrom: '202610' }, '202609')).toBe(0)
    expect(breakShortenMinFor({ breakShortenMin: 20, breakShortenFrom: '202610' }, '2026-10')).toBe(20)
    expect(breakShortenMinFor({}, '202610')).toBe(0)
  })
})

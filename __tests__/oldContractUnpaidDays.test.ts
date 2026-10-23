import { describe, test, expect } from 'vitest'
import { computeMonthly } from '@/lib/compute-monthly'
import { type MainData } from '@/lib/compute'
import { isOldContractPrescribedDay, isOldContractWorker, oldContractUnpaidDays } from '@/lib/old-contract'
import type { AttendanceEntry } from '@/types'

/**
 * 旧契約の所定の日（日曜以外）の空欄・「現場休み」は欠勤（日給100%控除）になる。
 * 2026-10-23 タン(208) 9/21・22（笹塚のカレンダーが休み）が空欄のまま締まり、60%補償が抜けた件の再発防止。
 */
const YM = '202609'
const e = (x: object) => x as unknown as AttendanceEntry

describe('旧契約の判定', () => {
  test('useOldRules の外国人だけ（visa / visaType どちらでも）', () => {
    expect(isOldContractWorker({ visa: 'jisshu1', useOldRules: true })).toBe(true)
    expect(isOldContractWorker({ visaType: 'jisshu1', useOldRules: true })).toBe(true)
    expect(isOldContractWorker({ visa: 'jisshu1' })).toBe(false)
    expect(isOldContractWorker({ visa: 'none', useOldRules: true })).toBe(false)
    expect(isOldContractWorker(null)).toBe(false)
  })
  test('所定の日 = 日曜以外（祝日・現場の休みも所定）', () => {
    expect(isOldContractPrescribedDay('2026-09-21')).toBe(true)   // 敬老の日（月）
    expect(isOldContractPrescribedDay('2026-09-22')).toBe(true)   // 国民の休日（火）
    expect(isOldContractPrescribedDay('2026-09-20')).toBe(false)  // 日曜
  })
})

describe('空欄・現場休みの日を見つける', () => {
  const attD: Record<string, AttendanceEntry> = {
    s_208_202609_1: e({ w: 1 }),
    s_208_202609_2: e({ w: 0.6 }),
    s_208_202609_3: e({ w: 0, r: 1 }),      // 欠（本人都合）は数えない
    s_208_202609_4: e({ w: 0, h: 1 }),      // 現場休みだけ → 数える
    s_208_202609_5: e({ p: 1 }),
  }
  test('昨日まで・日曜を除く', () => {
    const r = oldContractUnpaidDays({ attD, workerId: 208, ym: YM, todayIso: '2026-09-08' })
    expect(r.siteOff).toEqual([4])
    expect(r.blank).toEqual([7])           // 6日は日曜・8日は今日
  })
  test('入社前・退職後は数えない', () => {
    const r = oldContractUnpaidDays({ attD, workerId: 208, ym: YM, hireDate: '2026-09-07', todayIso: '2026-09-08' })
    expect(r.blank).toEqual([7])
    expect(r.siteOff).toEqual([])
  })
})

describe('月次集計の注意点', () => {
  function main(): MainData {
    return {
      workers: [
        { id: 208, name: 'タン', org: 'hfu', visa: 'jisshu1', job: 'tobi', rate: 8890, hourlyRate: 1270, salary: 213784, otMul: 1.25, hireDate: '2026-08-01', token: '', useOldRules: true },
        { id: 205, name: '新ルール', org: 'hfu', visa: 'jisshu3', job: 'tobi', rate: 9975, hourlyRate: 1425, otMul: 1.25, hireDate: '2023-10-23', token: '' },
      ],
      sites: [{ id: 's', name: '笹塚', start: '', end: '', foreman: 0, archived: false }],
      subcons: [], assign: { s: { workers: [208, 205], subcons: [] } }, massign: {}, billing: {}, workDays: { [YM]: 26 }, siteWorkDays: {}, locks: {}, plData: {},
      defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
    } as unknown as MainData
  }
  function att(fill21: boolean): Record<string, AttendanceEntry> {
    const a: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 30; d++) {
      if (new Date(2026, 8, d).getDay() === 0) continue
      for (const wid of [208, 205]) {
        if (d === 21 || d === 22) { if (fill21 && wid === 208) a[`s_${wid}_${YM}_${d}`] = e({ w: 0.6, s: 'admin' }); continue }
        a[`s_${wid}_${YM}_${d}`] = e({ w: 1 })
      }
    }
    return a
  }
  // 9/21・22 は現場カレンダーで休み
  const cal = { s: Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
    const d = i + 1
    const sun = new Date(2026, 8, d).getDay() === 0
    return [String(d), sun || d === 21 || d === 22 ? 'holiday' : 'work']
  })) }

  test('空欄のまま: 注意点（2日・60%補償の額）と「稼働日未入力 2日」が出る', () => {
    const w = computeMonthly(main(), att(false), {}, YM, 26, { s: 24 }, 20, cal).workers.find(x => x.id === 208)!
    const n = w.payNotes?.find(x => x.code === 'oldRuleUnpaidDays')
    expect(n?.message).toContain('21・22日')
    expect(n?.amount).toBe(Math.ceil(8890 * 0.6 * 2))
    expect(w.calendarBlankDays).toBe(2)
  })
  test('0.6補を入れれば出ない・支給額は60%補償の分ふえる', () => {
    const ws0 = computeMonthly(main(), att(false), {}, YM, 26, { s: 24 }, 20, cal).workers
    const ws1 = computeMonthly(main(), att(true), {}, YM, 26, { s: 24 }, 20, cal).workers
    const before = ws0.find(x => x.id === 208)!, after = ws1.find(x => x.id === 208)!
    expect(after.payNotes?.some(x => x.code === 'oldRuleUnpaidDays')).toBeFalsy()
    expect((after.salaryNetPay || 0) - (before.salaryNetPay || 0)).toBe(10668)
  })
  test('新ルールの人は現場カレンダーで判定（休みの日の空欄は注意しない）', () => {
    const w = computeMonthly(main(), att(false), {}, YM, 26, { s: 24 }, 20, cal).workers.find(x => x.id === 205)!
    expect(w.payNotes?.some(x => x.code === 'oldRuleUnpaidDays')).toBeFalsy()
    expect(w.calendarBlankDays || 0).toBe(0)
  })
})

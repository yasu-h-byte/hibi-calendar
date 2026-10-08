import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import {
  settleLimit, fiveDayReserve, isLeaveSettleEligible, countPaidDaysInMonth, settledDaysForYm,
  lastDayOfYm, prevYm, LEAVE_SETTLE_REASON, type SettleLimitInput,
} from '@/lib/leave-settle'
import type { AttendanceEntry } from '@/types'

/**
 * 有給精算（日本人の日給月給・2026-10-08 代表決定）の決まりを守っているか
 *   ① 年5日の枠は必ず残す ② 期の半分を過ぎて5日未満なら止める ③ 月24日まで
 *   ④ 日給月給だけ（月給・役員・外国人は対象外） ⑤ 給料には日額×日数で足し、出面の有給日数には入れない
 */

const base: SettleLimitInput = {
  hasGrant: true, grantDate: '2026-10-01', grantDays: 11, remaining: 11, periodTaken: 0,
  pendingOtherDays: 0, paidDaysInMonth: 15, settledInMonth: 0,
  todayIso: '2026-10-20', fiveDayDeadlineIso: '2027-04-01',
}

describe('精算できる日数の上限', () => {
  test('期の初め（11日付与・取得0）: 5日を残して6日まで', () => {
    expect(settleLimit(base).maxDays).toBe(6)
    expect(settleLimit(base).breakdown.reserve).toBe(5)
  })

  test('稼働日に2日休んだ後（残9）: 残す日数が3日に減り、精算できるのは6日のまま', () => {
    expect(settleLimit({ ...base, remaining: 9, periodTaken: 2 }).maxDays).toBe(6)
  })

  test('年5日を取り終えたら残り全部を精算できる（月の上限の範囲で）', () => {
    expect(settleLimit({ ...base, remaining: 6, periodTaken: 5 }).maxDays).toBe(6)
  })

  test('残りが年5日の分だけなら精算できない', () => {
    const r = settleLimit({ ...base, remaining: 5, periodTaken: 0 })
    expect(r.maxDays).toBe(0)
    expect(r.blockReason).toContain('年5日')
  })

  test('承認待ちの精算は先に引く（二重に申請して枠を超えない）', () => {
    expect(settleLimit({ ...base, pendingOtherDays: 4 }).maxDays).toBe(2)
  })

  test('月24日まで: 出勤20日の月は4日まで', () => {
    expect(settleLimit({ ...base, paidDaysInMonth: 20 }).maxDays).toBe(4)
  })

  test('同じ月にもう承認済みの精算があれば、その分も月24日に数える', () => {
    expect(settleLimit({ ...base, paidDaysInMonth: 20, settledInMonth: 3 }).maxDays).toBe(1)
  })

  test('出勤・有給で24日に達した月は精算できない', () => {
    const r = settleLimit({ ...base, paidDaysInMonth: 24 })
    expect(r.maxDays).toBe(0)
    expect(r.blockReason).toContain('24日')
  })

  test('付与から半年を過ぎて年5日に届いていない人は止める', () => {
    const r = settleLimit({ ...base, periodTaken: 4, remaining: 7, todayIso: '2027-04-01' })
    expect(r.maxDays).toBe(0)
    expect(r.blockReason).toContain('半年')
  })

  test('半年を過ぎていても年5日を取っていれば精算できる', () => {
    expect(settleLimit({ ...base, periodTaken: 5, remaining: 6, todayIso: '2027-05-01' }).maxDays).toBe(6)
  })

  test('付与がまだの人は精算できない', () => {
    expect(settleLimit({ ...base, hasGrant: false }).maxDays).toBe(0)
  })

  test('付与10日未満の人は年5日の義務の対象外（残す日数0）', () => {
    expect(fiveDayReserve(9, 0)).toBe(0)
    expect(settleLimit({ ...base, grantDays: 9, remaining: 9, todayIso: '2027-05-01' }).maxDays).toBe(9)
  })
})

describe('対象の人', () => {
  test('日本人の日給月給だけ', () => {
    expect(isLeaveSettleEligible({ visa: 'none', rate: 20000, job: 'tobi' })).toBe(true)
    expect(isLeaveSettleEligible({ visa: '', rate: 20000, job: 'tobi' })).toBe(true)
    expect(isLeaveSettleEligible({ visa: 'none', rate: 20000, salary: 300000, job: 'tobi' })).toBe(false) // 月給
    expect(isLeaveSettleEligible({ visa: 'none', rate: 20000, job: 'yakuin' })).toBe(false)               // 役員
    expect(isLeaveSettleEligible({ visa: 'tokutei1', rate: 0, job: 'tobi' })).toBe(false)                 // 外国人
    expect(isLeaveSettleEligible(undefined)).toBe(false)
  })
})

describe('数え方', () => {
  test('給料が出る日: 出勤・有給・0.6補・試験。同じ日の2現場は1日。帰国だけの日は数えない', () => {
    const d: Record<string, unknown> = {
      'site1_5_202610_1': { w: 1 },
      'site_a_5_202610_1': { w: 0.5 },        // 同じ日に別の現場（現場IDに _ を含む）
      'site1_5_202610_2': { w: 0, p: 1 },
      'site1_5_202610_3': { w: 0.6 },
      'site1_5_202610_5': { w: 0, exam: 1 },
      'site1_5_202610_6': { w: 0, hk: 1 },
      'site1_5_202610_7': { w: 0, r: 1 },     // 欠
      'site1_55_202610_8': { w: 1 },          // 別の人
      'site1_5_202609_9': { w: 1 },           // 別の月
    }
    expect(countPaidDaysInMonth(d, 5, '202610')).toBe(4)
  })

  test('承認済みの精算は buyoutHistory の reason と月で数える', () => {
    const records = [
      { buyoutHistory: [
        { days: 2, reason: LEAVE_SETTLE_REASON, ym: '202610' },
        { days: 1, reason: LEAVE_SETTLE_REASON, ym: '202611' },
        { days: 3, reason: 'year-end' },
      ] },
    ]
    expect(settledDaysForYm(records, '202610')).toBe(2)
    expect(settledDaysForYm(records, '202611')).toBe(1)
    expect(settledDaysForYm(undefined, '202610')).toBe(0)
  })

  test('月の境目', () => {
    expect(lastDayOfYm('202702')).toBe('2027-02-28')
    expect(lastDayOfYm('202612')).toBe('2026-12-31')
    expect(prevYm('202701')).toBe('202612')
  })
})

// ── 給与計算 ──
function buildMain(overrides: Partial<MainData>): MainData {
  return {
    workers: [], sites: [{ id: 'site1', name: '現場1', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { site1: { workers: [], subcons: [] } }, massign: {}, billing: {},
    workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
    ...overrides,
  } as MainData
}
const attKey = (siteId: string, workerId: number, ym: string, day: number) => `${siteId}_${workerId}_${ym}_${day}`
const settleRec = (days: number, ym: string) => ([{
  fy: '2026', grantDate: '2026-10-01', grantDays: 11, carryOver: 0, adjustment: 0, used: 0,
  buyoutHistory: [{ at: '2026-10-25T00:00:00Z', by: 'test', days, reason: LEAVE_SETTLE_REASON, ym }],
  buyoutDays: days,
}])

describe('給料への反映', () => {
  const jp = { id: 5, name: 'A', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2015-04-01', token: '' }
  // 10月の稼働日（日曜 4,11,18,25 を避ける）から15日
  const days = [1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17]

  const run = (worker: object, plDays: number, settle: number, ym = '202610', workDays = days) => {
    const main = buildMain({
      workers: [worker] as MainData['workers'],
      assign: { site1: { workers: [5], subcons: [] } },
      siteWorkDays: { [ym]: { site1: 22 } },
      plData: { '5': settleRec(settle, ym) } as unknown as MainData['plData'],
    })
    const attD: Record<string, AttendanceEntry> = {}
    workDays.forEach(d => { attD[attKey('site1', 5, ym, d)] = { w: 1 } as AttendanceEntry })
    for (let i = 0; i < plDays; i++) attD[attKey('site1', 5, ym, 19 + i)] = { w: 0, p: 1 } as AttendanceEntry
    const r = computeMonthly(main, attD, {}, ym, 22, { site1: 22 }, 20)
    return { r, w: r.workers.find(x => x.id === 5)! }
  }

  test('出勤15＋精算3 → 日額×3 を足す。有給日数・有給手当には入れない。原価も支給額と一致', () => {
    const { r, w } = run(jp, 0, 3)
    expect(w.leaveSettleDays).toBe(3)
    expect(w.leaveSettleAllowance).toBe(60000)
    expect(w.paidLeaveDays ?? 0).toBe(0)
    expect(w.paidLeaveAllowance ?? 0).toBe(0)
    expect(w.salaryNetPay).toBe(20000 * 15 + 60000)
    expect(w.totalCost).toBe(w.salaryNetPay)
    expect(r.sites.reduce((s, x) => s + x.cost, 0)).toBe(w.totalCost)
    expect(w.payNotes?.some(n => n.code === 'leaveSettleOverCap')).toBeFalsy()
  })

  test('締めの時点で月24日を超えていたら注意点を出す（支給額は変えない）', () => {
    const many = [1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 26]
    const { w } = run(jp, 0, 3, '202610', many)
    expect(w.leaveSettleAllowance).toBe(60000)
    expect(w.payNotes?.some(n => n.code === 'leaveSettleOverCap')).toBe(true)
  })

  test('月給の人には足さず、注意点で知らせる', () => {
    const { w } = run({ ...jp, salary: 300000 }, 0, 2)
    expect(w.leaveSettleAllowance ?? 0).toBe(0)
    expect(w.payNotes?.some(n => n.code === 'leaveSettleNotDaily')).toBe(true)
  })

  test('2026年9月分より前の月には何もしない', () => {
    const { w } = run(jp, 0, 2, '202609')
    expect(w.leaveSettleAllowance ?? 0).toBe(0)
  })
})

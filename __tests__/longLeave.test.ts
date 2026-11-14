import { describe, it, expect } from 'vitest'
import {
  longLeaveKindOf, hkCodeOf, kindFromHk, hkShortLabel, hkDuringLabel, deemedWorkedForLeave, isForeignOnlyKind, LONG_LEAVE_KINDS,
} from '@/lib/long-leave'
import { planHomeLeaveDay } from '@/lib/home-leave-sync'
import { isProxyApprovalDay, approvingForemenOnDay } from '@/lib/foremen'
import { getEntryStatus } from '@/lib/attendance'
import type { AttendanceEntry } from '@/types'

/**
 * 長い休みの種類（2026-11-14 代表・白戸職長の育休）
 * 帰国の仕組み（homeLongLeave・出面の hk）に種類を足した。
 */
describe('長い休みの種類', () => {
  it('kind が無い古い記録は帰国（reason が「一時帰国」「ビザ更新帰国」「その他」でも）', () => {
    expect(longLeaveKindOf({})).toBe('kikoku')
    expect(longLeaveKindOf({ reason: '一時帰国' })).toBe('kikoku')
    expect(longLeaveKindOf({ reason: 'ビザ更新帰国' })).toBe('kikoku')
    expect(longLeaveKindOf({ reason: 'その他' })).toBe('kikoku')
    expect(longLeaveKindOf(null)).toBe('kikoku')
  })
  it('kind があればそれ。おかしな値は無視して reason から', () => {
    expect(longLeaveKindOf({ kind: 'ikukyu' })).toBe('ikukyu')
    expect(longLeaveKindOf({ kind: 'xxx', reason: '育児休業' })).toBe('ikukyu')
  })
  it('hk の値と種類は行き来できる。1・不明な値は帰国', () => {
    for (const k of LONG_LEAVE_KINDS) expect(kindFromHk(hkCodeOf(k))).toBe(k)
    expect(hkCodeOf('kikoku')).toBe(1)  // 今までの出面のデータ（hk:1）は帰国のまま
    expect(kindFromHk(1)).toBe('kikoku')
    expect(kindFromHk(99)).toBe('kikoku')
    expect(kindFromHk(undefined)).toBe('kikoku')
    // 値は種類ごとに別
    expect(new Set(LONG_LEAVE_KINDS.map(hkCodeOf)).size).toBe(LONG_LEAVE_KINDS.length)
  })
  it('出面の表示名', () => {
    expect(hkShortLabel(1)).toBe('帰国')
    expect(hkShortLabel(hkCodeOf('ikukyu'))).toBe('育休')
    expect(hkDuringLabel(hkCodeOf('ikukyu'))).toBe('育休中')
  })
  it('育休・産休・介護休業は有給の出勤率で出勤とみなす（労基法39条10項）。帰国・休職はみなさない', () => {
    expect(deemedWorkedForLeave('ikukyu')).toBe(true)
    expect(deemedWorkedForLeave('sankyu')).toBe(true)
    expect(deemedWorkedForLeave('kaigo')).toBe(true)
    expect(deemedWorkedForLeave('kikoku')).toBe(false)
    expect(deemedWorkedForLeave('kyushoku')).toBe(false)
  })
  it('帰国だけが外国人スタッフ限定', () => {
    expect(isForeignOnlyKind('kikoku')).toBe(true)
    expect(isForeignOnlyKind('ikukyu')).toBe(false)
  })
  it('hk が 2 以上（育休など）でも出面の状態は「長い休み」（旧: hk === 1 だけを見ていた）', () => {
    expect(getEntryStatus({ w: 0, hk: hkCodeOf('ikukyu') } as AttendanceEntry)).toBe('home_leave')
    expect(getEntryStatus({ w: 0, hk: 1 } as AttendanceEntry)).toBe('home_leave')
  })
})

describe('出面の印の同期（種類つき）', () => {
  const e = (x: Partial<AttendanceEntry>) => x as AttendanceEntry
  it('同じ種類の印があれば何もしない・違う種類なら書き直す', () => {
    expect(planHomeLeaveDay(e({ w: 0, hk: 2 }), 2)).toBe('noop')
    expect(planHomeLeaveDay(e({ w: 0, hk: 1 }), 2)).toBe('write')
    expect(planHomeLeaveDay(undefined, 2)).toBe('write')
  })
  it('true は帰国（1）として扱う（今までの呼び方）', () => {
    expect(planHomeLeaveDay(e({ w: 0, hk: 1 }), true)).toBe('noop')
  })
  it('0 は印を消す', () => {
    expect(planHomeLeaveDay(e({ w: 0, hk: 2 }), 0)).toBe('clear-entry')
  })
  it('出勤・有給などの実績がある日は種類を問わず触らない', () => {
    expect(planHomeLeaveDay(e({ w: 1 }), 2)).toBe('skip')
    expect(planHomeLeaveDay(e({ p: 1, w: 0 }), 2)).toBe('skip')
  })
})

describe('職長が休みの日の職長承認（政仁さんが代わりに）', () => {
  // 白戸職長（id 2・職種=職長）が現場 S の職長。育休は 12/7〜12/19・12/26〜2/16
  const workers = [{ id: 2, job: 'shokucho' }, { id: 5, job: 'shokucho' }, { id: 9, job: 'tobi' }]
  const site = { id: 'S', foreman: 2 }
  const leaves = [
    { workerId: 2, startDate: '2026-12-07', endDate: '2026-12-19' },
    { workerId: 2, startDate: '2026-12-26', endDate: '2027-02-16' },
  ]
  it('休みの日は代わり・出ている日は職長', () => {
    expect(isProxyApprovalDay(site, {}, '202612', workers, '2026-12-05', leaves)).toBe(false)
    expect(isProxyApprovalDay(site, {}, '202612', workers, '2026-12-07', leaves)).toBe(true)
    expect(isProxyApprovalDay(site, {}, '202612', workers, '2026-12-19', leaves)).toBe(true)
    expect(isProxyApprovalDay(site, {}, '202612', workers, '2026-12-20', leaves)).toBe(false)
    expect(isProxyApprovalDay(site, {}, '202612', workers, '2026-12-26', leaves)).toBe(true)
    expect(isProxyApprovalDay(site, {}, '202702', workers, '2027-02-16', leaves)).toBe(true)
    expect(isProxyApprovalDay(site, {}, '202702', workers, '2027-02-17', leaves)).toBe(false)
  })
  it('その月だけ別の職長を登録した（月別の職長）ら、その職長が承認する', () => {
    const mforeman = { S_202701: { foreman: 5 } }
    expect(approvingForemenOnDay(site, mforeman, '202701', workers, '2027-01-10', leaves)).toEqual([5])
    expect(isProxyApprovalDay(site, mforeman, '202701', workers, '2027-01-10', leaves)).toBe(false)
  })
  it('職長でない人が職長に登録された現場は、休みに関係なく代わり（今までどおり）', () => {
    expect(isProxyApprovalDay({ id: 'T', foreman: 9 }, {}, '202612', workers, '2026-12-01', [])).toBe(true)
  })
})

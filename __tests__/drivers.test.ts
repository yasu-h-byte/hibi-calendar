/**
 * 運転記録（drv）の決まり（2026-10-02 点検）。
 * - 月・日の検証（'202613' で att_202613 のごみを作らない）と未来日の拒否
 * - 工種サイトのキーは親へまとめて、同じ便の同じ人を二重に払わない
 * - その日その現場（親＋工種）で働いていない人の運転は払わない（下流の防御）
 */
import { describe, it, expect } from 'vitest'
import {
  calcMonthlyAllowances, driveFamilyIds, drvKeyOf, driversByDayForSite, isValidYm,
  nonWorkingDriverIds, normalizeDrvKeys, validateDriverDate,
} from '@/lib/allowance'
import type { AttendanceEntry } from '@/types'

const sites = [
  { id: 'P', name: '親現場' },
  { id: 'C1', name: '親現場 鉄骨', parentId: 'P', workType: '鉄骨' },
  { id: 'C2', name: '親現場 仮設', parentId: 'P', workType: '仮設' },
  { id: 'X', name: '別の現場' },
]
const A = (o: Record<string, Record<string, unknown>>) => o as unknown as Record<string, AttendanceEntry>

describe('validateDriverDate / isValidYm', () => {
  it('月は 01〜12 だけ', () => {
    expect(isValidYm('202610')).toBe(true)
    expect(isValidYm('202613')).toBe(false)
    expect(isValidYm('202600')).toBe(false)
    expect(isValidYm('20261')).toBe(false)
    expect(validateDriverDate('202613', 1, '2026-10-02', true)).toBe('月が正しくありません')
    expect(validateDriverDate('202613', 1, '2026-10-02', false)).toBe('月が正しくありません')
  })
  it('日はその月の範囲', () => {
    expect(validateDriverDate('202609', 31, '2026-10-02', true)).toBe('日付が正しくありません')
    expect(validateDriverDate('202609', 0, '2026-10-02', true)).toBe('日付が正しくありません')
    expect(validateDriverDate('202609', 1.5, '2026-10-02', true)).toBe('日付が正しくありません')
    expect(validateDriverDate('202609', 30, '2026-10-02', true)).toBeNull()
  })
  it('記録は今日まで。未来日は不可・消す操作は通す', () => {
    expect(validateDriverDate('202610', 2, '2026-10-02', true)).toBeNull()
    expect(validateDriverDate('202610', 3, '2026-10-02', true)).toBe('まだ来ていない日の運転者は記録できません')
    expect(validateDriverDate('202610', 3, '2026-10-02', false)).toBeNull()
  })
})

describe('nonWorkingDriverIds（その日この現場で働いた人だけ）', () => {
  const att = A({
    'P_1_202610_1': { w: 1 },
    'C1_2_202610_1': { w: 0.5 },      // 工種で半日 → OK
    'P_3_202610_1': { w: 0.6 },       // 0.6補償 → 不可
    'P_4_202610_1': { w: 0, p: 1 },   // 有給 → 不可
    'P_5_202610_1': { w: 0, ns: 1 },  // 夜勤のみ → OK
    'X_6_202610_1': { w: 1 },         // 別の現場 → 不可
    'P_7_202610_1': { w: 0, h: 1 },   // 休み → 不可
  })
  it('出勤・夜勤だけ通す（工種の画面から見ても親＋工種で探す）', () => {
    const fam = driveFamilyIds(sites, 'C1')
    expect(fam).toEqual(['P', 'C1', 'C2'])
    expect(nonWorkingDriverIds(att, fam, '202610', 1, [1, 2, 3, 4, 5, 6, 7, 8])).toEqual([3, 4, 6, 7, 8])
  })
})

describe('工種サイトのキーは親へまとめる', () => {
  it('drvKeyOf は親の id', () => {
    expect(drvKeyOf(sites, 'C1', '202610', 5)).toBe('P_202610_5')
    expect(drvKeyOf(sites, 'P', '202610', 5)).toBe('P_202610_5')
    expect(drvKeyOf(sites, 'X', '202610', 5)).toBe('X_202610_5')
  })
  it('親と工種の両方のキーにある同じ人は1回に（他月のキーは捨てる）', () => {
    const drv = {
      'P_202610_1': { am: [1], pm: [1] },
      'C1_202610_1': { am: [1, 2], pm: [] },
      'P_202609_1': { am: [9], pm: [9] },
    }
    expect(normalizeDrvKeys(drv, '202610', sites)).toEqual({ 'P_202610_1': { am: [1, 2], pm: [1] } })
  })
  it('読み出しは工種の画面でも親の画面でも同じ（まとめた結果）', () => {
    const drv = { 'P_202610_1': { am: [1] }, 'C2_202610_1': { pm: [2] }, 'X_202610_1': { am: [3] } }
    expect(driversByDayForSite(drv, sites, 'C1', '202610')).toEqual({ 1: { am: [1], pm: [2] } })
    expect(driversByDayForSite(drv, sites, 'P', '202610')).toEqual({ 1: { am: [1], pm: [2] } })
    expect(driversByDayForSite(drv, sites, 'X', '202610')).toEqual({ 1: { am: [3], pm: [] } })
  })
})

describe('calcMonthlyAllowances の運転手当（2026-10-02）', () => {
  it('親と工種の両方に同じ便が残っていても二重に払わない・配賦先は働いた工種', () => {
    const att = A({ 'C1_1_202610_1': { w: 1 } })
    const drv = { 'P_202610_1': { am: [1], pm: [1] }, 'C1_202610_1': { am: [1], pm: [] } }
    const r = calcMonthlyAllowances(att, '202610', {}, drv, [], undefined, undefined, sites)
    expect(r.get(1)!.driveLegs).toBe(2)
    expect(r.get(1)!.driveAllowanceYen).toBe(2000)
    expect(r.get(1)!.bySite).toEqual({ C1: { days: 0, yen: 0, driveYen: 2000 } })
  })
  it('その日働いていない人（未来日・休み・0.6補償・別の現場）の記録は払わない', () => {
    const att = A({
      'P_1_202610_1': { w: 1 },
      'P_2_202610_1': { w: 0.6 },
      'X_3_202610_1': { w: 1 },
      'P_4_202610_1': { w: 0, p: 1 },
    })
    const drv = { 'P_202610_1': { am: [1, 2, 3, 4], pm: [5] }, 'P_202610_20': { am: [1], pm: [1] } }
    const r = calcMonthlyAllowances(att, '202610', {}, drv, [], undefined, undefined, sites)
    expect(r.get(1)!.driveAllowanceYen).toBe(1000)
    for (const id of [2, 3, 4, 5]) expect(r.get(id)?.driveAllowanceYen ?? 0).toBe(0)
  })
  it('運転手当なしの現場は、工種のキーでも払わない', () => {
    const att = A({ 'C1_1_202610_1': { w: 1 } })
    const drv = { 'C1_202610_1': { am: [1], pm: [1] } }
    const r = calcMonthlyAllowances(att, '202610', {}, drv, [], undefined, new Set(['P', 'C1', 'C2']), sites)
    expect(r.get(1)?.driveAllowanceYen ?? 0).toBe(0)
  })
})

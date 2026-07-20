/**
 * 帰国中（一時帰国・復帰未定）の給与計算テスト（2026-07-18 追加）
 *
 * 仕様（B案・代表確定）:
 *   - 「急な帰国・復帰未定」は homeLongLeave の endDate に番兵('9999-12-31')を入れて表現。
 *   - 給与計算(computeMonthly)は在籍日数按分に帰国中日を織り込み、その日を
 *     「無給かつ欠勤に計上しない」扱いにする（＝所定日数から除外）。
 *   - まるごと1ヶ月帰国でも欠勤控除ではなく 0 円支給になる（旧: 欠勤21日等と表示されていた）。
 *
 * 検証戦略: 帰国あり/なしを同一勤務データで比較し、「欠勤が消える」ことを確認する。
 */
import { describe, test, expect } from 'vitest'
import { computeMonthly, countHomeLeaveDaysInRange, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

function buildMain(overrides: Partial<MainData>): MainData {
  return {
    workers: [],
    sites: [{ id: 'site1', name: '現場1', start: '', end: '', foreman: 0, archived: false }],
    subcons: [],
    assign: { site1: { workers: [], subcons: [] } },
    massign: {},
    billing: {},
    workDays: {},
    siteWorkDays: {},
    locks: {},
    plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 },
    mforeman: {},
    ...overrides,
  } as MainData
}
const attKey = (siteId: string, workerId: number, ym: string, day: number) => `${siteId}_${workerId}_${ym}_${day}`
function dayWork(siteId: string, workerId: number, ym: string, day: number, w = 1, o = 0): Record<string, AttendanceEntry> {
  return { [attKey(siteId, workerId, ym, day)]: { w, ...(o > 0 ? { o } : {}) } as AttendanceEntry }
}
const SENTINEL = '9999-12-31'

// ─────────────────────────────────────────────────────────────
// countHomeLeaveDaysInRange（暦日の重なり計算）
// ─────────────────────────────────────────────────────────────
describe('countHomeLeaveDaysInRange', () => {
  test('復帰未定（番兵終了日）は月末まで加算される', () => {
    const hl = [{ workerId: 1, startDate: '2026-05-10', endDate: SENTINEL }]
    // 5/10〜5/31 = 22日
    expect(countHomeLeaveDaysInRange(hl, 1, '2026-05-01', '2026-05-31')).toBe(22)
  })
  test('在籍期間より前に始まる帰国は在籍開始日でクランプ', () => {
    const hl = [{ workerId: 1, startDate: '2026-04-20', endDate: '2026-05-05' }]
    // 在籍 5/1〜5/31、帰国は 5/1〜5/5 に切り詰め = 5日
    expect(countHomeLeaveDaysInRange(hl, 1, '2026-05-01', '2026-05-31')).toBe(5)
  })
  test('別のスタッフの帰国はカウントしない', () => {
    const hl = [{ workerId: 2, startDate: '2026-05-01', endDate: SENTINEL }]
    expect(countHomeLeaveDaysInRange(hl, 1, '2026-05-01', '2026-05-31')).toBe(0)
  })
  test('重複する期間でも暦日は二重計上しない', () => {
    const hl = [
      { workerId: 1, startDate: '2026-05-01', endDate: '2026-05-20' },
      { workerId: 1, startDate: '2026-05-15', endDate: '2026-05-31' },
    ]
    expect(countHomeLeaveDaysInRange(hl, 1, '2026-05-01', '2026-05-31')).toBe(31)
  })
  test('homeLeaves 未指定なら 0', () => {
    expect(countHomeLeaveDaysInRange(undefined, 1, '2026-05-01', '2026-05-31')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 時給制ベトナム人（新ルール）— 帰国中の給与
// ─────────────────────────────────────────────────────────────
describe('computeMonthly - 帰国中（新ルール時給）', () => {
  const worker = {
    id: 101, name: 'トゥアン', org: 'hfu', visa: 'tokutei1' as const, job: 'tobi',
    rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
  }
  const mkMain = () => buildMain({
    workers: [worker],
    assign: { site1: { workers: [101], subcons: [] } },
    siteWorkDays: { '202605': { site1: 20 } },
  })

  test('まるごと1ヶ月帰国（復帰未定）→ 支給0円・欠勤0・帰国中日数=31', () => {
    const main = mkMain()
    const homeLeaves = [{ workerId: 101, startDate: '2026-05-01', endDate: SENTINEL }]
    const result = computeMonthly(main, {}, {}, '202605', 20, { site1: 20 }, 20, undefined, homeLeaves)
    const w = result.workers.find(x => x.id === 101)
    expect(w).toBeDefined()                 // 帰国中でも一覧に表示される
    expect(w!.hkDays).toBe(31)              // 5月は31日
    expect(w!.salaryNetPay).toBe(0)         // 無給（欠勤控除ではなく所定0で0円）
    expect(w!.absence ?? 0).toBe(0)         // 欠勤に計上されない
    expect(w!.fixedBasePay ?? 0).toBe(0)
  })

  test('月途中から帰国（前半のみ勤務）→ 勤務分は支給・欠勤0（帰国なしなら欠勤が出る）', () => {
    // 5/1,2,4,5,6,7,8,9 の8日出勤（日曜 5/3 を避ける）、5/10以降は帰国・復帰未定
    const workDays = [1, 2, 4, 5, 6, 7, 8, 9]
    const attD: Record<string, AttendanceEntry> = {}
    for (const d of workDays) Object.assign(attD, dayWork('site1', 101, '202605', d))

    // 帰国あり
    const withHL = computeMonthly(
      mkMain(), attD, {}, '202605', 20, { site1: 20 }, 20, undefined,
      [{ workerId: 101, startDate: '2026-05-10', endDate: SENTINEL }],
    ).workers.find(x => x.id === 101)!
    // 帰国なし（同じ勤務データ）
    const noHL = computeMonthly(
      mkMain(), attD, {}, '202605', 20, { site1: 20 }, 20, undefined, [],
    ).workers.find(x => x.id === 101)!

    // 帰国中日数 = 5/10〜5/31 = 22日
    expect(withHL.hkDays).toBe(22)
    // 帰国ありは欠勤ゼロ（残りは帰国中扱い）、支給は内訳合計と一致
    expect(withHL.absence ?? 0).toBe(0)
    const sum = (withHL.fixedBasePay || 0) + (withHL.additionalAllowance || 0) + (withHL.paidLeaveAllowance || 0)
      + (withHL.nonStatutoryOTAllowance || 0) + (withHL.otAllowance || 0)
      + (withHL.legalHolidayAllowance || 0) + (withHL.nightAllowance || 0) + (withHL.compAllowance || 0)
      - (withHL.absentDeduction || 0)
    expect(withHL.salaryNetPay).toBe(sum)
    expect(withHL.salaryNetPay).toBeGreaterThan(0)  // 勤務分は支給される

    // 帰国なしだと同じ勤務でも「欠勤」が発生する（＝この機能が欠勤化を防いでいる証拠）
    expect((noHL.absence ?? 0)).toBeGreaterThan(0)
    expect(noHL.hkDays ?? 0).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 固定月給ベトナム人（フン）— 帰国中の給与
// ─────────────────────────────────────────────────────────────
describe('computeMonthly - 帰国中（固定月給・フン）', () => {
  const fun = {
    id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1' as const, job: 'tobi',
    rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25,
    hireDate: '2017-10-01', token: 'h', useOldRules: true,
  }
  const mkMain = () => buildMain({
    workers: [fun],
    assign: { site1: { workers: [104], subcons: [] } },
    siteWorkDays: { '202606': { site1: 26 } },
  })

  test('まるごと1ヶ月帰国 → 基本給0・支給0・欠勤0（帰国なしなら欠勤が発生）', () => {
    // 帰国あり（6/1〜復帰未定）
    const withHL = computeMonthly(
      mkMain(), {}, {}, '202606', 26, { site1: 26 }, 20, undefined,
      [{ workerId: 104, startDate: '2026-06-01', endDate: SENTINEL }],
    ).workers.find(x => x.id === 104)!
    // 帰国なし（同じく無出勤）
    const noHL = computeMonthly(
      mkMain(), {}, {}, '202606', 26, { site1: 26 }, 20, undefined, [],
    ).workers.find(x => x.id === 104)!

    expect(withHL.hkDays).toBe(30)          // 6月は30日
    expect(withHL.basePay ?? 0).toBe(0)     // 固定月給も帰国中は日割り0
    expect(withHL.salaryNetPay).toBe(0)     // 無給
    expect(withHL.absence ?? 0).toBe(0)     // 欠勤に計上されない

    // 帰国なしだと固定月給が満額計上され「欠勤◯日」が発生する（旧来の挙動＝フン6月問題）
    expect((noHL.absence ?? 0)).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 回帰: homeLeaves 未指定なら従来どおり
// ─────────────────────────────────────────────────────────────
describe('computeMonthly - 帰国中の後方互換', () => {
  test('homeLeaves を渡さなければ hkDays は未設定で給与は従来どおり', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))
    const w = computeMonthly(main, attD, {}, '202605', 20, { site1: 20 }, 20).workers.find(x => x.id === 101)!
    expect(w.hkDays).toBeUndefined()
    expect(w.fixedBasePay).toBe(1500 * 20 * 7)  // 通常の基本給
  })
})

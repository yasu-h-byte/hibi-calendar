import { describe, test, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  computeLeaveBalanceFromAtt, computeRecordBalance, selectEndedPeriodRecord, grantPeriodEndExclusive,
} from '@/lib/leave-compute'
import { generateLeaveLedger, type LeaveLedgerRecord } from '@/lib/export'
import type { AttendanceEntry } from '@/types'

/**
 * 残数の画面間一致（2026-10-02 総合点検）
 *
 * 同じ付与レコード＋出面から、申請の検証（computeLeaveBalanceFromAtt＝getLeaveBalance の本体）・
 * 休暇管理の「前の期」と賞与の精勤賞与（selectEndedPeriodRecord + computeRecordBalance）・管理簿 Excel
 * （generateLeaveLedger）が同じ残になることを固定する。
 * データには「付与日を前に寄せた重なる期間」「来年の承認済み P」「買取あり」「付与日を過ぎて未付与」を入れる。
 */
const att: Record<string, AttendanceEntry> = {}
const p = (wid: number, ym: string, d: number) => { att[`siteA_${wid}_${ym}_${d}`] = { w: 0, p: 1 } as AttendanceEntry }

// 5: 付与日を前に寄せた日本人（2025-12-01 → 2026-10-01）。2026-02 に1日、10/15・11/10 に有給、繰越の残骸あり
p(5, '202602', 3); p(5, '202610', 15); p(5, '202611', 10)
const rec5 = [
  { fy: '2025', grantDate: '2025-12-01', grantDays: 10, carryOver: 3, adjustment: 0 },
  { fy: '2026', grantDate: '2026-10-01', grantDays: 11, carryOver: 0, adjustment: 0 },
]
// 6: 外国人。前の期に買取1日（履歴のみ）、来年1月（テト）の承認済み有給が2日
p(6, '202701', 12); p(6, '202701', 13); p(6, '202606', 2)
const rec6 = [
  { fy: '2025', grantDate: '2025-11-01', grantDays: 12, carryOver: 0, adjustment: 1, buyoutHistory: [{ days: 1, reason: 'retirement' }] },
  { fy: '2026', grantDate: '2026-11-01', grantDays: 14, carryOver: 8, adjustment: 0 },
]
// 7: 期を過ぎて次の付与がまだ（2025-10-01 付与・今日 2026-12-05）
p(7, '202611', 20)
const rec7 = [{ fy: '2025', grantDate: '2025-10-01', grantDays: 12, carryOver: 0, adjustment: 2 }]

describe('残数は申請の検証・前の期（賞与）・管理簿で同じ', () => {
  test('前に寄せた人: 10〜11月の有給は今の期だけに数え、前の期は 10/1 の前日で終わる', () => {
    const today = '2026-10-20'
    const now = computeLeaveBalanceFromAtt(5, rec5, att, today, { isJp: true })
    expect(now.grantDate).toBe('2026-10-01')
    expect(now.used).toBe(2)               // 10/15・11/10（承認済みの未来分も申請ベース）
    expect(now.remaining).toBe(9)
    expect(grantPeriodEndExclusive(rec5, rec5[0])).toBe('2026-10-01')
    const ended = selectEndedPeriodRecord(rec5, today)
    expect(ended?.grantDate).toBe('2025-12-01')
    const prev = computeRecordBalance(5, rec5, ended!, att, { isJp: true, todayIso: today })
    expect(prev.carryOver).toBe(0)          // 日本人の繰越は足さない
    expect(prev.periodUsed).toBe(1)         // 2/3 だけ（10/15 は数えない）
    expect(prev.remaining).toBe(9)
    expect(prev.periodLastDay).toBe('2026-09-30')
  })

  test('外国人: 調整・買取履歴・来年の P を含めて同じ残', () => {
    const today = '2026-12-01'
    const b = computeLeaveBalanceFromAtt(6, rec6, att, today, { isJp: false })
    expect(b.total).toBe(22)
    expect(b.used).toBe(2)                  // 来年1月の2日
    expect(b.remaining).toBe(20)
    const prevRec = selectEndedPeriodRecord(rec6, today)!
    const prev = computeRecordBalance(6, rec6, prevRec, att, { isJp: false, todayIso: today })
    expect(prev.used).toBe(1 + 1 + 1)       // 調整1＋買取1（履歴から）＋6/2
    expect(prev.remaining).toBe(9)
  })

  test('期を過ぎて次の付与がまだ: 申請の検証は残0（付与の処理待ち）、期末時点の残は別に持つ', () => {
    const b = computeLeaveBalanceFromAtt(7, rec7, att, '2026-12-05', { isJp: true })
    expect(b.periodOver).toBe(true)
    expect(b.remaining).toBe(0)
    expect(b.remainingAtPeriodEnd).toBe(12 - 2 - 0)   // 11/20 の P は期の外
    expect(b.periodEnd).toBe('2026-10-01')
    expect(computeLeaveBalanceFromAtt(7, rec7, att, '2026-09-30', { isJp: true }).periodOver).toBe(false)
  })

  test('管理簿 Excel の残日数・取得日数は同じ本体の値（取得日数は出面の P だけ）', () => {
    const wb = generateLeaveLedger({
      workers: [
        { id: 5, name: '前倒し', org: 'hibi', visa: 'none', hireDate: '2020-04-01' },
        { id: 6, name: '外国人', org: 'hibi', visa: 'tokutei1', hireDate: '2019-05-01' },
      ],
      plData: { '5': rec5, '6': rec6 } as Record<string, LeaveLedgerRecord[]>,
      allAtt: att,
    })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['管理簿'], { header: 1 }) as unknown[][]
    const header = rows[3] as string[]
    const col = (name: string) => header.findIndex(h => String(h).startsWith(name))
    const find = (id: number, fy: string) => rows.find(r => r[0] === id && String(r[col('FY')]) === fy)!
    const r5old = find(5, '2025')
    expect(r5old[col('繰越日数')]).toBe(0)
    expect(r5old[col('取得日数')]).toBe(1)
    expect(r5old[col('残日数')]).toBe(9)
    const r5new = find(5, '2026')
    expect(r5new[col('取得日数')]).toBe(2)
    expect(r5new[col('残日数')]).toBe(9)
    const r6old = find(6, '2025')
    expect(r6old[col('取得日数')]).toBe(1)   // 出面の P だけ（調整1・買取1 は別の列）
    expect(r6old[col('調整')]).toBe(1)
    expect(r6old[col('買取日数')]).toBe(1)
    expect(r6old[col('残日数')]).toBe(9)
    const r6new = find(6, '2026')
    expect(r6new[col('取得日数')]).toBe(2)   // 来年1月の承認済み有給
    expect(r6new[col('残日数')]).toBe(20)
  })
})

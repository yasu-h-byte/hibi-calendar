/**
 * 遠方現場日当・運転手当の computeMonthly 組み込みテスト。
 *
 * ルール自体のテストは allowance.test.ts。ここで固定するのは「組み込み」:
 * - 施行前の月はゲート（loadMonthlyAllowances が undefined）で計算が変わらない
 * - allowances を渡すと netPay / salaryNetPay / totalCost / 現場原価 / totals.cost に
 *   正しく乗る（日本人日給月給は bySite で現場へ直接配賦、実支給原価組は支給額経由）
 *
 * 入力はゴールデンマスターと同じ本番3ヶ月フィクスチャ（202608）を使い、
 * 「手当なし実行」との差分だけを検証する——将来の給与ロジック変更でこのテストが
 * 無関係に壊れないようにするため。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeMonthly, loadMonthlyAllowances, type MainData } from '@/lib/compute'
import type { WorkerAllowanceMonthly } from '@/lib/allowance'
import type { AttendanceEntry } from '@/types'

const DIR = join(__dirname, 'fixtures', 'golden')
const loadJson = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as T

const YM = '202608'

function run(allowances?: Map<number, WorkerAllowanceMonthly>) {
  const main = loadJson<MainData>('main.json')
  const att = loadJson<{ d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>(`att_${YM}.json`)
  const calendars = loadJson<Record<string, Record<string, Record<string, string>>>>('calendars.json')
  const homeLeaves = loadJson<{ workerId: number; startDate: string; endDate: string }[]>('homeLeaves.json')
  const prescribedDays = main.workDays[YM] || 0
  const siteWorkDaysMap = main.siteWorkDays?.[YM] || {}
  const hasCal = Object.keys(siteWorkDaysMap).length > 0
  const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
  return computeMonthly(
    main, att.d, att.sd, YM, prescribedDays, hasCal ? siteWorkDaysMap : undefined,
    baseDays, calendars[YM] || {}, homeLeaves, allowances,
  )
}

const al = (partial: Partial<WorkerAllowanceMonthly> & { workerId: number }): WorkerAllowanceMonthly => ({
  siteAllowanceYen: 0, allowanceDays: 0, driveAllowanceYen: 0, driveLegs: 0, bySite: {}, ...partial,
})

describe('手当の computeMonthly 組み込み', () => {
  it('施行前の月は loadMonthlyAllowances が undefined（給与計算のゲート）', async () => {
    // ゲートは最初の行なので Firestore には触らない（テスト環境でも安全に呼べる）
    await expect(loadMonthlyAllowances({} as MainData, '202609', {}, undefined)).resolves.toBeUndefined()
    await expect(loadMonthlyAllowances({} as MainData, '202512', {}, undefined)).resolves.toBeUndefined()
  })

  it('allowances 未指定（過去月の経路）は結果が完全に一致する', () => {
    expect(JSON.stringify(run(new Map()))).toBe(JSON.stringify(run(undefined)))
  })

  it('日本人日給月給: netPay・totalCost・現場原価・totals.cost に乗る', () => {
    const base = run()
    const jp = base.workers.find(w => w.visa === 'none' && !(w.salary && w.salary > 0) && w.sites.length > 0)!
    const sid = jp.sites[0]
    const withAl = run(new Map([[jp.id, al({
      workerId: jp.id, siteAllowanceYen: 3000, allowanceDays: 2,
      driveAllowanceYen: 2000, driveLegs: 2,
      bySite: { [sid]: { days: 2, yen: 3000, driveYen: 2000 } },
    })]]))
    const w2 = withAl.workers.find(w => w.id === jp.id)!
    expect(w2.siteAllowance).toBe(3000)
    expect(w2.driveAllowance).toBe(2000)
    expect(w2.netPay - jp.netPay).toBe(5000)
    expect(w2.totalCost - jp.totalCost).toBe(5000)
    const s1 = base.sites.find(s => s.id === sid)!
    const s2 = withAl.sites.find(s => s.id === sid)!
    expect(s2.cost - s1.cost).toBe(5000)
    expect(s2.profit - s1.profit).toBe(-5000)
    expect(withAl.totals.cost - base.totals.cost).toBe(5000)
  })

  it('実支給原価組（ベトナム人）: salaryNetPay 経由で原価・現場配賦に乗る', () => {
    const base = run()
    const vn = base.workers.find(w => w.visa !== 'none' && (w.salaryNetPay ?? 0) > 0 && !w.isDispatched)!
    const withAl = run(new Map([[vn.id, al({
      workerId: vn.id, siteAllowanceYen: 33000, allowanceDays: 22,
      bySite: { [vn.sites[0]]: { days: 22, yen: 33000 } },
    })]]))
    const w2 = withAl.workers.find(w => w.id === vn.id)!
    expect(w2.siteAllowance).toBe(33000)
    expect((w2.salaryNetPay ?? 0) - (vn.salaryNetPay ?? 0)).toBe(33000)
    // 原価＝実支給額なので totalCost にも同額が乗る
    expect(w2.totalCost - vn.totalCost).toBe(33000)
    expect(withAl.totals.cost - base.totals.cost).toBe(33000)
    // 現場原価の合計にも同額（配賦は出勤日数比なので現場単位ではなく合計で確認）
    const sum = (r: ReturnType<typeof run>) => r.sites.reduce((s, x) => s + x.cost, 0)
    expect(sum(withAl) - sum(base)).toBe(33000)
  })

  it('対象月に在籍しない workerId の手当は無視される（防御）', () => {
    const base = run()
    const withAl = run(new Map([[99999, al({ workerId: 99999, siteAllowanceYen: 1500, allowanceDays: 1 })]]))
    expect(JSON.stringify(withAl)).toBe(JSON.stringify(base))
  })
})

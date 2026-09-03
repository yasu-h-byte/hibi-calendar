import { describe, test, expect, vi, afterEach } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import { getUpcomingGrants } from '@/lib/leave-auto'
import type { AttendanceEntry } from '@/types'

/**
 * 有給総点検（第4回・2026-09-02）の回帰テスト
 *
 * 1. 試験日(exam)で20日枠が埋まっても有給日給が消えない（枠を埋めた日数＝出勤＋試験）
 * 2. 日本人日給月給の有給手当が現場原価にも乗る（Σsite.cost = totalCost）
 * 3. 通知ベルの付与予定: 日本人は 10/1 統一（入社応当日ではない）・繰越0
 */
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

describe('有給日給と試験日（20日枠）', () => {
  const worker = {
    id: 101, name: 'A', org: 'hfu', visa: 'tokutei1' as const, job: 'tobi',
    rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
  }
  const mkMain = () => buildMain({ workers: [worker], assign: { site1: { workers: [101], subcons: [] } }, siteWorkDays: { '202606': { site1: 26 } } })
  // 6月の稼働日（日曜 7,14,21,28 を避ける）
  const workdays = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 29, 30]

  test('出勤19＋試験1＋有給1 → 有給日給が1日分出る（旧実装は0円だった）', () => {
    const attD: Record<string, AttendanceEntry> = {}
    workdays.slice(0, 19).forEach(d => { attD[attKey('site1', 101, '202606', d)] = { w: 1 } as AttendanceEntry })
    attD[attKey('site1', 101, '202606', workdays[19])] = { w: 0, exam: 1 } as AttendanceEntry
    attD[attKey('site1', 101, '202606', workdays[20])] = { w: 0, p: 1 } as AttendanceEntry
    const w = computeMonthly(mkMain(), attD, {}, '202606', 26, { site1: 26 }, 20).workers.find(x => x.id === 101)!
    expect(w.examDays).toBe(1)
    expect(w.plUsed).toBe(1)
    expect(w.paidLeaveDays).toBe(1)
    expect(w.paidLeaveAllowance).toBe(1500 * 7)
    expect(w.absence ?? 0).toBe(0)
  })

  test('出勤19＋試験2 → 試験1日は追加所定として支給（試験は出勤と同等）', () => {
    const attD: Record<string, AttendanceEntry> = {}
    workdays.slice(0, 19).forEach(d => { attD[attKey('site1', 101, '202606', d)] = { w: 1 } as AttendanceEntry })
    attD[attKey('site1', 101, '202606', workdays[19])] = { w: 0, exam: 1 } as AttendanceEntry
    attD[attKey('site1', 101, '202606', workdays[20])] = { w: 0, exam: 1 } as AttendanceEntry
    const w = computeMonthly(mkMain(), attD, {}, '202606', 26, { site1: 26 }, 20).workers.find(x => x.id === 101)!
    expect(w.additionalAllowance).toBe(1500 * 7)
    expect(w.absence ?? 0).toBe(0)
  })
})

describe('日本人日給月給の有給手当と現場原価', () => {
  test('出勤20＋有給2 → totalCost(=支給額) と現場原価の合計が一致する', () => {
    const jp = { id: 5, name: '倉本', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2015-04-01', token: '' }
    const main = buildMain({ workers: [jp], assign: { site1: { workers: [5], subcons: [] } }, siteWorkDays: { '202606': { site1: 22 } } })
    const attD: Record<string, AttendanceEntry> = {}
    const days = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 22, 23]
    days.forEach(d => { attD[attKey('site1', 5, '202606', d)] = { w: 1 } as AttendanceEntry })
    attD[attKey('site1', 5, '202606', 24)] = { w: 0, p: 1 } as AttendanceEntry
    attD[attKey('site1', 5, '202606', 25)] = { w: 0, p: 1 } as AttendanceEntry
    const r = computeMonthly(main, attD, {}, '202606', 22, { site1: 22 }, 20)
    const w = r.workers.find(x => x.id === 5)!
    expect(w.paidLeaveAllowance).toBe(40000)
    expect(w.totalCost).toBe(20000 * 20 + 40000)
    const siteCost = r.sites.reduce((s, x) => s + x.cost, 0)
    expect(siteCost).toBe(w.totalCost)   // 旧実装は 400,000（有給手当が現場に配賦されなかった）
  })
})

describe('通知ベルの付与予定（日本人は 10/1 統一）', () => {
  afterEach(() => { vi.useRealTimers() })
  test('前回付与 2025-10-01 の日本人 → 次回は 2026-10-01・繰越0（入社応当日ではない）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T03:00:00+09:00'))
    const main = buildMain({
      workers: [{ id: 10, name: '梶原', org: 'hibi', visa: 'none', job: 'tobi', rate: 18000, otMul: 1.25, hireDate: '2023-04-01', token: '' }],
      plData: { '10': [{ fy: '2025', grantDate: '2025-10-01', grantDays: 12, carryOver: 0, adjustment: 0, used: 0 }] },
    })
    // 2026-09-15 時点（固定）: 30日先の 10/1 が予定に入る
    const up = getUpcomingGrants(main, 30).find(u => u.workerId === 10)
    expect(up).toBeDefined()
    const g = up!.grantDate
    expect(`${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`).toBe('2026-10-01')
    expect(up!.carryOver).toBe(0)
  })
})

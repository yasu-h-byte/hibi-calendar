import { describe, test, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({ doc: () => null, getDoc: async () => ({ exists: () => false }), setDoc: async () => {} }))
// 本人の出面の承認はそろっている（そろっていないときは従来のテスト staffConfirmState.test.ts）
vi.mock('@/lib/approval-gap', () => ({
  approvalGap: async () => ({ foremanMissing: [], finalMissing: [], latestAt: '2026-11-01T00:00:00.000Z' }),
  FINAL_APPROVAL_REQUIRED_FROM_YM: '202609',
}))
const company = { foremanMissing: [] as unknown[], finalMissing: [] as unknown[], latestAt: '2026-11-01T05:00:00.000Z' }
const calls: string[] = []
vi.mock('@/lib/month-approval-status', () => ({
  monthApprovalStatus: async (_m: unknown, _d: unknown, _ym: string, org: string) => {
    calls.push(org)
    return { needed: 10, finalRequired: true, gap: company, complete: company.foremanMissing.length + company.finalMissing.length === 0 }
  },
}))
import { confirmMonthContext } from '@/lib/attendance-confirm-server'
import type { AttendanceEntry } from '@/types'

// 2026-11-02 代表決定（10月分から）: 本人確認は「会社の全現場の承認」と「本人の空欄なし」がそろってから出す
const YM = '202610'
const dow = (d: number) => new Date(2026, 9, d).getDay()
const main = {
  workers: [{ id: 201, org: 'hfu' }, { id: 101, org: 'hibi' }],
  sites: [{ id: 's', name: 'S' }],
}
const worker = { id: 201, visaType: 'jisshu3', hireDate: '2022-10-01' }
const fullMonth = (skip: number[] = []) => {
  const d: Record<string, AttendanceEntry | null> = {}
  for (let day = 1; day <= 31; day++) if (dow(day) !== 0 && !skip.includes(day)) d[`s_201_${YM}_${day}`] = { w: 1 } as AttendanceEntry
  return d
}

describe('本人確認を出す条件（10月分から）', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T03:00:00Z'))
    company.foremanMissing = []; company.finalMissing = []; calls.length = 0
  })

  test('本人の承認・会社の全現場の承認がそろい、空欄も無ければ出す（そろった日時は会社の分の遅いほう）', async () => {
    const r = await confirmMonthContext(main.sites, YM, fullMonth(), main).readiness(worker)
    expect(r.ready).toBe(true)
    expect(r.readyAt).toBe('2026-11-01T05:00:00.000Z')
    expect(calls).toEqual(['hfu'])   // 本人の会社で数える
  })

  test('ほかの人の分の承認が残っていれば出さない（承認待ち）', async () => {
    company.finalMissing = [{ familyId: 'x', day: 3 }, { familyId: 'x', day: 4 }]
    const r = await confirmMonthContext(main.sites, YM, fullMonth(), main).readiness(worker)
    expect(r.ready).toBe(false)
    expect(r.companyMissing).toBe(2)
  })

  test('本人の出面に空欄の仕事の日があれば出さない（空欄の日を返す）', async () => {
    const r = await confirmMonthContext(main.sites, YM, fullMonth([10, 12]), main).readiness(worker)
    expect(r.ready).toBe(false)
    expect(r.blankDays).toEqual([10, 12])
  })

  test('9月分までは従来どおり（本人の承認だけ）', async () => {
    const d: Record<string, AttendanceEntry | null> = { [`s_201_202609_1`]: { w: 1 } as AttendanceEntry }
    company.finalMissing = [{ familyId: 'x', day: 3 }]
    const r = await confirmMonthContext(main.sites, '202609', d, main).readiness(worker)
    expect(r.ready).toBe(true)
    expect(calls).toEqual([])
  })

  test('会社は1回だけ数える（同じ文脈で何人分判定しても）', async () => {
    const ctx = confirmMonthContext(main.sites, YM, fullMonth(), main)
    await ctx.readiness(worker); await ctx.readiness(worker)
    expect(calls).toEqual(['hfu'])
  })
})

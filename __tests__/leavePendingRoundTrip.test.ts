import { describe, test, expect } from 'vitest'
import { listPendingGrants, validateGrantForExecution, type PendingGrantWorker, type PendingGrantRecord } from '@/lib/leave-pending'
import { getUpcomingGrants } from '@/lib/leave-auto'
import type { MainData } from '@/lib/compute'

/**
 * 付与待ち → まとめて付与 の往復（2026-10-02 総合点検）
 *
 * 付与待ち一覧（listPendingGrants）が出した日数を、そのまま実行の検証（validateGrantForExecution）に通して
 * 拒否されないことを固定する。旧: 実行側が isJapanese を渡しておらず、10/1 へ前倒しした日本人の
 * 「みなし勤続」の日数（梶原さん 2027-10-01 の16日）を法定超として全員分まとめて拒否した。
 */
const workers: PendingGrantWorker[] = [
  { id: 10, name: '10/1 の日本人（入社 2023-05-15）', visa: 'none', job: 'tobi', hireDate: '2023-05-15' },
  { id: 11, name: '新ルールの日本人（入社 2026-06-01）', visa: 'none', job: 'tobi', hireDate: '2026-06-01' },
  { id: 12, name: '外国人（付与日が入社応当日とずれている）', visa: 'tokutei1', job: 'tobi', hireDate: '2019-04-23' },
  { id: 13, name: '月末入社の外国人', visa: 'jisshu1', job: 'tobi', hireDate: '2026-02-28' },
  { id: 14, name: '役員（対象外）', visa: 'none', job: 'yakuin', hireDate: '2010-01-01' },
]
const plData: Record<string, PendingGrantRecord[]> = {
  '10': [{ fy: '2026', grantDate: '2026-10-01', grantDays: 14, carryOver: 0, adjustment: 0 }],
  '11': [],
  '12': [{ fy: '2025', grantDate: '2025-11-01', grantDays: 20, carryOver: 5, adjustment: 0 }],
  '13': [],
}

describe('付与待ち一覧の日数は、そのまま実行して通る', () => {
  test('2027-09-15 時点: 10/1 の日本人は 2027-10-01 に16日（みなし 11/15）、外国人は前回付与日+1年', () => {
    const pending = listPendingGrants(workers, plData, '2027-09-15')
    const byId = Object.fromEntries(pending.map(p => [p.workerId, p]))
    expect(byId[10]?.nextGrantDate).toBe('2027-10-01')
    expect(byId[10]?.deemedDate).toBe('2027-11-15')
    expect(byId[10]?.legalDays).toBe(16)
    expect(byId[12]?.nextGrantDate).toBe('2026-11-01')  // 過ぎた未付与は何日過ぎても対象のまま
    expect(byId[12]?.legalDays).toBe(20)
    expect(byId[14]).toBeUndefined()
    for (const p of pending) {
      const w = workers.find(x => x.id === p.workerId)
      const v = validateGrantForExecution({ workerId: p.workerId, grantDate: p.nextGrantDate, grantDays: p.legalDays }, w)
      expect(v.ok, `${p.name}: ${'error' in v ? v.error : ''}`).toBe(true)
    }
  })

  test('新ルールの日本人は入社6ヶ月後（2026-12-01）に10日。30日前から対象', () => {
    expect(listPendingGrants(workers, plData, '2026-10-31').find(p => p.workerId === 11)).toBeUndefined()
    const p = listPendingGrants(workers, plData, '2026-11-01').find(x => x.workerId === 11)
    expect(p?.nextGrantDate).toBe('2026-12-01')
    expect(p?.legalDays).toBe(10)
    expect(validateGrantForExecution({ workerId: 11, grantDate: '2026-12-01', grantDays: 10 }, workers[1]).ok).toBe(true)
  })

  test('月末入社（2026-02-28）の外国人は 2026-08-28 に10日で通る', () => {
    const p = listPendingGrants(workers, plData, '2026-08-28').find(x => x.workerId === 13)
    expect(p?.nextGrantDate).toBe('2026-08-28')
    expect(p?.legalDays).toBe(10)
    expect(validateGrantForExecution({ workerId: 13, grantDate: '2026-08-28', grantDays: 10 }, workers[3]).ok).toBe(true)
  })

  test('旧: isJapanese 無しの検証は 10/1 の日本人の16日を拒否していた（回帰の記録）', () => {
    const v = validateGrantForExecution({ workerId: 10, grantDate: '2027-10-01', grantDays: 16 }, { hireDate: '2023-05-15', visa: 'tokutei1' })
    expect(v.ok).toBe(false)
  })

  test('通知ベル（getUpcomingGrants）は付与待ち一覧と同じ日付・日数で、30日を過ぎた未付与も出し続ける', () => {
    const main = {
      workers: workers.map(w => ({ ...w, org: 'hibi', rate: 0, otMul: 1, token: '' })),
      plData, sites: [], subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, defaultRates: {}, mforeman: {},
    } as unknown as MainData
    const up = getUpcomingGrants(main, 30)
    const u12 = up.find(u => u.workerId === 12)
    expect(u12).toBeDefined()  // 2026-11-01 の付与がずっと未処理 → 出し続ける（旧: 30日で消えた）
    expect(u12!.days).toBe(20)
  })
})

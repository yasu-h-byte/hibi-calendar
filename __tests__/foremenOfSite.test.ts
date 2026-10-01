import { describe, test, expect } from 'vitest'
import { foremenOfSiteForMonth, approvingForemenOfSite, isProxyApprovalSite, buildAuthUser } from '@/lib/auth'
import { permRoleOf } from '@/lib/permissions'

// 承認の権限判定（出面・有給・帰国申請）で共通の「その月の現場の職長」（2026-10-01 一本化）
describe('foremenOfSiteForMonth', () => {
  const site = { id: 's1', foreman: 2 }
  test('月別職長が無ければ現場の職長', () => {
    expect(foremenOfSiteForMonth(site, {}, '202610')).toEqual([2])
  })
  test('月別職長（foreman）があればその人だけ（旧職長は外れる）', () => {
    expect(foremenOfSiteForMonth(site, { s1_202610: { foreman: 3 } }, '202610')).toEqual([3])
  })
  test('古い書き込み形式（wid）も読む', () => {
    expect(foremenOfSiteForMonth(site, { s1_202610: { wid: 6 } }, '202610')).toEqual([6])
  })
  test('別の月の月別職長は効かない・YYYY-MM でも同じ', () => {
    expect(foremenOfSiteForMonth(site, { s1_202609: { foreman: 3 } }, '2026-10')).toEqual([2])
  })
  test('職長未設定の現場は空', () => {
    expect(foremenOfSiteForMonth({ id: 's2' }, {}, '202610')).toEqual([])
  })
})

// 2026-10-01 代表決定: 職長承認は「現場の職長に登録」かつ「職種が職長」の人だけ。いなければ政仁さんが代行
describe('approvingForemenOfSite / isProxyApprovalSite', () => {
  const workers = [{ id: 2, jobType: 'shokucho' }, { id: 5, job: 'tobi' }, { id: 0, job: 'yakuin' }, { id: 3, job: 'shokucho' }]
  test('職長（職種）が登録されている現場はその人が承認・代行なし', () => {
    expect(approvingForemenOfSite({ id: 'a', foreman: 2 }, {}, '202610', workers)).toEqual([2])
    expect(isProxyApprovalSite({ id: 'a', foreman: 2 }, {}, '202610', workers)).toBe(false)
  })
  test('とび・役員が登録されている現場は承認できる人がいない＝政仁さんが代行', () => {
    expect(approvingForemenOfSite({ id: 'b', foreman: 5 }, {}, '202610', workers)).toEqual([])
    expect(isProxyApprovalSite({ id: 'b', foreman: 5 }, {}, '202610', workers)).toBe(true)
    expect(isProxyApprovalSite({ id: 'c', foreman: 0 }, {}, '202610', workers)).toBe(true)
  })
  test('生データの job でも判定する・月別職長が職長ならその月は代行なし', () => {
    expect(approvingForemenOfSite({ id: 'b', foreman: 5 }, { b_202610: { wid: 3 } }, '202610', workers)).toEqual([3])
  })
  test('職長未設定の現場も代行', () => {
    expect(isProxyApprovalSite({ id: 'd' }, {}, '202610', workers)).toBe(true)
  })
})

// 2026-10-01 代表指示: 日比靖仁さん（ID 0・代表・開発者）は個人パスワードでも代表（全権限）
describe('buildAuthUser: 代表', () => {
  test('ID 0 は職種が役員でも代表（admin → owner）', () => {
    const u = buildAuthUser({ id: 0, name: '日比靖仁', jobType: 'yakuin' } as never, [], {})
    expect(u.role).toBe('admin')
    expect(permRoleOf({ role: u.role })).toBe('owner')
  })
  test('政仁さん（ID 1）は事業責任者・ほかの役員は役員のまま', () => {
    expect(buildAuthUser({ id: 1, name: '日比政仁', jobType: 'yakuin' } as never, [], {}).role).toBe('approver')
    expect(buildAuthUser({ id: 9, name: '役員', jobType: 'yakuin' } as never, [], {}).role).toBe('officer')
  })
})

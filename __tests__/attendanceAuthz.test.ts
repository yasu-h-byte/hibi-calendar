import { describe, test, expect } from 'vitest'
import {
  resolveApiRoleFromMain, checkForemanSiteScope, isForemanScopedGridAction, approvalDateError,
} from '@/lib/attendance-authz'

/** 出面グリッド POST の担当現場チェック（2026-09-15） */
const main = {
  workers: [
    { id: 1, name: '政仁', job: 'yakuin' },
    { id: 10, name: '職長A', job: 'shokucho' },
    { id: 11, name: '職長B', job: 'shokucho' },
    { id: 20, name: '事務', job: 'jimu' },
    { id: 30, name: '役員', job: 'yakuin' },
  ],
  sites: [
    { id: 'idemitsu', name: '出光', foreman: 10, archived: false },
    { id: 'idemitsu_steel', name: '出光（鉄骨）', foreman: 10, archived: false, parentId: 'idemitsu' },
    { id: 'sasazuka', name: '笹塚', foreman: 11, archived: false },
    { id: 'old', name: '旧現場', foreman: 10, archived: true },
  ],
  mforeman: { sasazuka_202610: { foreman: 10 } },
}

const scope = (actor: number | 'super-admin', siteId: unknown, ym = '202609') =>
  checkForemanSiteScope(resolveApiRoleFromMain({ authorized: true, actor }, main, ym), siteId)

describe('attendance-authz', () => {
  test('職長は担当現場なら可', () => {
    expect(scope(10, 'idemitsu')).toEqual({ ok: true })
  })
  test('職長は工種サイト（親の職長コピー）も可', () => {
    expect(scope(10, 'idemitsu_steel')).toEqual({ ok: true })
  })
  test('職長は他現場なら 403', () => {
    const r = scope(10, 'sasazuka')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
    expect(scope(11, 'idemitsu').ok).toBe(false)
  })
  test('月別職長交代(mforeman)を対象月で反映', () => {
    expect(scope(10, 'sasazuka', '202610')).toEqual({ ok: true })
    expect(scope(11, 'sasazuka', '202610').ok).toBe(false)
    expect(scope(10, 'sasazuka', '2026-10')).toEqual({ ok: true })
  })
  test('アーカイブ済み現場・siteId 欠落は職長不可', () => {
    expect(scope(10, 'old').ok).toBe(false)
    expect(scope(10, undefined).ok).toBe(false)
    expect(scope(10, '').ok).toBe(false)
  })
  test('管理者系・事業責任者・事務・役員は制限しない', () => {
    expect(scope('super-admin', 'sasazuka')).toEqual({ ok: true })
    expect(scope(1, 'sasazuka')).toEqual({ ok: true })
    expect(scope(20, 'sasazuka')).toEqual({ ok: true })
    expect(scope(30, 'sasazuka')).toEqual({ ok: true })
  })
  test('未認証・人員マスタにいない個人パスワードは 401', () => {
    expect(checkForemanSiteScope(resolveApiRoleFromMain({ authorized: false }, main, '202609'), 'idemitsu'))
      .toMatchObject({ ok: false, status: 401 })
    expect(scope(999, 'idemitsu')).toMatchObject({ ok: false, status: 401 })
  })
  test('対象アクション', () => {
    for (const a of [undefined, '', 'saveAttendance', 'approve', 'approve_foreman', 'unapprove', 'unapprove_foreman']) {
      expect(isForemanScopedGridAction(a)).toBe(true)
    }
    // 2026-10-02 総合点検: 配置・運転者・夜勤の日・工種も担当現場だけ（旧: 一覧に無く、他現場を書けた）
    for (const a of ['saveAssign', 'saveDrivers', 'saveNightDays', 'saveDefaultWorkType', 'moveWorkType', 'setDayWorkType']) {
      expect(isForemanScopedGridAction(a)).toBe(true)
    }
    // これから足すアクションも、既定で担当現場チェックの対象になる
    expect(isForemanScopedGridAction('someNewAction')).toBe(true)
    // 外すのは理由のあるものだけ（最終承認は管理者だけ・全社の所定日数は現場を持たない）
    for (const a of ['approve_final', 'unapprove_final', 'saveWorkDays']) {
      expect(isForemanScopedGridAction(a)).toBe(false)
    }
  })
})

describe('approvalDateError（承認できる日か・2026-10-02 総合点検）', () => {
  const today = '2026-10-05'
  test('今日まで・実在する日は承認できる', () => {
    expect(approvalDateError('202610', 5, today)).toBeNull()
    expect(approvalDateError('202610', 1, today)).toBeNull()
    expect(approvalDateError('202609', 30, today)).toBeNull()
    expect(approvalDateError('202609', '30', today)).toBeNull()
  })
  test('先の日は承認できない（PC の「まとめて承認」が月末まで送っていた）', () => {
    expect(approvalDateError('202610', 6, today)).toContain('先の日')
    expect(approvalDateError('202610', 31, today)).toContain('先の日')
    expect(approvalDateError('202611', 1, today)).toContain('先の日')
  })
  test('実在しない日・形の違う月は承認できない', () => {
    expect(approvalDateError('202609', 31, today)).toContain('実在しない')
    expect(approvalDateError('202602', 29, today)).toContain('実在しない')
    expect(approvalDateError('202609', 0, today)).toContain('実在しない')
    expect(approvalDateError('202609', 1.5, today)).toContain('実在しない')
    expect(approvalDateError('2026-09', 1, today)).not.toBeNull()
    expect(approvalDateError('202613', 1, today)).not.toBeNull()
  })
})

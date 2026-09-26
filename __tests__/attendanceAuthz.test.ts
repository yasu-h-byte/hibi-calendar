import { describe, test, expect } from 'vitest'
import {
  resolveApiRoleFromMain, checkForemanSiteScope, isForemanScopedGridAction,
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
    for (const a of ['approve_final', 'unapprove_final', 'saveWorkDays', 'saveAssign']) {
      expect(isForemanScopedGridAction(a)).toBe(false)
    }
  })
})

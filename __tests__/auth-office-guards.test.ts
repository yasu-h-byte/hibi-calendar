/**
 * 事務所の人だけ・代表だけの認証（lib/auth.ts・2026-09-26）
 *
 * 職長は共通パスワード＋名前選択でログインするため、サーバーからは共通パスワード（actor='admin'）＝職長。
 * 月締め・請求額の編集（requireOfficeAuth）と保守ツール（requireSuperAdmin）は共通パスワードを通さない。
 */
import { describe, test, expect, vi, beforeAll } from 'vitest'

const main = {
  userPasswords: { '50': 'pw-jimu', '1': 'pw-masahito', '7': 'pw-yakuin', '30': 'pw-shokucho' },
  workers: [
    { id: 50, name: '森田', jobType: 'jimu' },
    { id: 1, name: '日比政仁', jobType: 'yakuin' },
    { id: 7, name: '役員', jobType: 'yakuin' },
    { id: 30, name: '職長', jobType: 'shokucho' },
  ],
  sites: [], mforeman: {},
}
vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => structuredClone(main) }),
}))

const req = (pw: string) => ({ headers: new Headers({ 'x-admin-password': pw }) }) as never

beforeAll(() => {
  process.env.ADMIN_PASSWORD = 'pw-common'
  process.env.SUPER_ADMIN_PASSWORD = 'pw-super'
})

describe('requireOfficeAuth（月締め・請求額の編集）', () => {
  test.each([
    ['代表', 'pw-super', true],
    ['事務', 'pw-jimu', true],
    ['事業責任者', 'pw-masahito', true],
    ['役員', 'pw-yakuin', true],
    ['職長（個人パスワード）', 'pw-shokucho', false],
    ['共通パスワード（＝職長）', 'pw-common', false],
    ['不明', 'nope', false],
  ])('%s → %s', async (_label, pw, ok) => {
    const { requireOfficeAuth } = await import('@/lib/auth')
    expect(await requireOfficeAuth(req(pw)) === null).toBe(ok)
  })
})

describe('requireSuperAdmin（出面データの保守ツール）', () => {
  test.each([
    ['代表', 'pw-super', true],
    ['事業責任者', 'pw-masahito', false],
    ['事務', 'pw-jimu', false],
    ['共通パスワード', 'pw-common', false],
  ])('%s → %s', async (_label, pw, ok) => {
    const { requireSuperAdmin } = await import('@/lib/auth')
    expect(await requireSuperAdmin(req(pw)) === null).toBe(ok)
  })
})

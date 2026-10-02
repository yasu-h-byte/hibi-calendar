/**
 * 職長の通行証（lib/session-token.ts・2026-09-26）と、共通パスワードを API で通さないこと（lib/auth.ts）
 */
import { describe, test, expect, vi, beforeAll } from 'vitest'

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => ({ userPasswords: { '50': 'pw-jimu', '51': 'pw-retired' } }) }),
}))
// 通行証の持ち主が在籍しているかは人員マスタ（getMainData）で見る（2026-10-02 総合点検）
vi.mock('@/lib/compute', () => ({
  getMainData: async () => ({
    workers: [
      { id: 10, name: '職長', job: 'shokucho', retired: '' },
      { id: 11, name: '退職した職長', job: 'shokucho', retired: '2026-01-31' },
      { id: 12, name: '退職予定の職長', job: 'shokucho', retired: '2099-12-31' },
      { id: 50, name: '事務', job: 'jimu', retired: '' },
      { id: 51, name: '退職した事務', job: 'jimu', retired: '2026-01-31' },
    ],
    sites: [], mforeman: {},
  }),
}))

beforeAll(() => {
  process.env.ADMIN_PASSWORD = 'pw-common'
  process.env.SUPER_ADMIN_PASSWORD = 'pw-super'
})

const req = (pw: string) => ({ headers: new Headers({ 'x-admin-password': pw }) }) as never

describe('通行証', () => {
  test('発行した通行証は本人の workerId として通る', async () => {
    const { createForemanToken, verifyForemanToken } = await import('@/lib/session-token')
    const t = createForemanToken(10)
    expect(verifyForemanToken(t)).toBe(10)
    const { getApiAuthUser } = await import('@/lib/auth')
    expect(await getApiAuthUser(req(t))).toEqual({ authorized: true, actor: 10 })
  })

  test('workerId の書き換え・署名の改ざん・期限切れは通らない', async () => {
    const { createForemanToken, verifyForemanToken, FOREMAN_TOKEN_TTL_SEC } = await import('@/lib/session-token')
    const t = createForemanToken(10)
    const [p, , exp, sig] = t.split('.')
    expect(verifyForemanToken(`${p}.1.${exp}.${sig}`)).toBeNull()          // 政仁さん（1）になりすまし
    expect(verifyForemanToken(`${t.slice(0, -2)}xx`)).toBeNull()
    const now = Math.floor(Date.now() / 1000)
    expect(verifyForemanToken(t, now + FOREMAN_TOKEN_TTL_SEC + 10)).toBeNull()
  })

  test('共通パスワードを変えると古い通行証は使えない', async () => {
    const { createForemanToken, verifyForemanToken } = await import('@/lib/session-token')
    const t = createForemanToken(10)
    process.env.ADMIN_PASSWORD = 'pw-common-new'
    expect(verifyForemanToken(t)).toBeNull()
    process.env.ADMIN_PASSWORD = 'pw-common'
  })

  test('パスワードそのもの（共通・代表・個人）は API で通らない。通行証だけが通る', async () => {
    const { getApiAuthUser, checkApiAuth } = await import('@/lib/auth')
    expect(await getApiAuthUser(req('pw-common'))).toEqual({ authorized: false })
    expect(await checkApiAuth(req('pw-common'))).toBe(false)
    expect(await getApiAuthUser(req('pw-super'))).toEqual({ authorized: false })
    expect(await getApiAuthUser(req('pw-jimu'))).toEqual({ authorized: false })
    const { createOwnerToken, createPersonalToken } = await import('@/lib/session-token')
    const { passwordFingerprint } = await import('@/lib/password')
    expect(await getApiAuthUser(req(createOwnerToken()))).toEqual({ authorized: true, actor: 'super-admin' })
    expect(await getApiAuthUser(req(createPersonalToken(50, passwordFingerprint('pw-jimu'))))).toEqual({ authorized: true, actor: 50 })
  })

  test('退職した人の通行証は使えない。退職予定（未来）の人・人員マスタに居ない人は？（2026-10-02 総合点検）', async () => {
    const { createForemanToken, createPersonalToken } = await import('@/lib/session-token')
    const { passwordFingerprint } = await import('@/lib/password')
    const { getApiAuthUser } = await import('@/lib/auth')
    expect(await getApiAuthUser(req(createForemanToken(11)))).toEqual({ authorized: false })
    expect(await getApiAuthUser(req(createForemanToken(12)))).toEqual({ authorized: true, actor: 12 })
    expect(await getApiAuthUser(req(createForemanToken(99)))).toEqual({ authorized: false })   // 人員マスタに居ない
    expect(await getApiAuthUser(req(createPersonalToken(51, passwordFingerprint('pw-retired'))))).toEqual({ authorized: false })
  })

  test('個人の通行証: パスワードを変えると（指紋が変わり）使えない・なりすまし不可', async () => {
    const { createPersonalToken } = await import('@/lib/session-token')
    const { passwordFingerprint } = await import('@/lib/password')
    const { getApiAuthUser } = await import('@/lib/auth')
    const old = createPersonalToken(50, passwordFingerprint('pw-jimu-OLD'))
    expect(await getApiAuthUser(req(old))).toEqual({ authorized: false })
    const t = createPersonalToken(50, passwordFingerprint('pw-jimu'))
    const [p, , exp, fp, sig] = t.split('.')
    expect(await getApiAuthUser(req(`${p}.1.${exp}.${fp}.${sig}`))).toEqual({ authorized: false })
  })
})

describe('専用の署名鍵 SESSION_SECRET（2026-10-02 総合点検）', () => {
  test('設定すると鍵が変わり、設定前の通行証は使えない（全員ログインし直し）。設定後も正しく発行・照合できる', async () => {
    const { createForemanToken, verifyForemanToken, createOwnerToken, verifyOwnerToken, hasDedicatedSessionSecret } = await import('@/lib/session-token')
    delete process.env.SESSION_SECRET
    expect(hasDedicatedSessionSecret()).toBe(false)
    const before = createForemanToken(10)
    const ownerBefore = createOwnerToken()
    process.env.SESSION_SECRET = 'x'.repeat(40)
    expect(hasDedicatedSessionSecret()).toBe(true)
    expect(verifyForemanToken(before)).toBeNull()
    expect(verifyOwnerToken(ownerBefore)).toBe(false)
    const after = createForemanToken(10)
    expect(verifyForemanToken(after)).toBe(10)
    // パスワードを変えると（鍵に含まれるので）やはり使えない
    process.env.ADMIN_PASSWORD = 'pw-common-new'
    expect(verifyForemanToken(after)).toBeNull()
    process.env.ADMIN_PASSWORD = 'pw-common'
    expect(verifyForemanToken(after)).toBe(10)
    delete process.env.SESSION_SECRET
  })
  test('32文字未満の SESSION_SECRET は設定ミスとみなして使わない（今までの鍵のまま）', async () => {
    const { createForemanToken, verifyForemanToken, hasDedicatedSessionSecret } = await import('@/lib/session-token')
    delete process.env.SESSION_SECRET
    const t = createForemanToken(10)
    process.env.SESSION_SECRET = 'short'
    expect(hasDedicatedSessionSecret()).toBe(false)
    expect(verifyForemanToken(t)).toBe(10)
    delete process.env.SESSION_SECRET
  })
})

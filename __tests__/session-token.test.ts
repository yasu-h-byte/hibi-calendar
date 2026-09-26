/**
 * 職長の通行証（lib/session-token.ts・2026-09-26）と、共通パスワードを API で通さないこと（lib/auth.ts）
 */
import { describe, test, expect, vi, beforeAll } from 'vitest'

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => ({ userPasswords: { '50': 'pw-jimu' } }) }),
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

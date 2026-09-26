/**
 * 共通パスワード＋名前選択で入れるのは職長だけ・発行されるのは本人の通行証（app/api/auth・2026-09-26）
 * 旧: workerId を書き換えれば政仁さん（事業責任者）や役員として入れた
 */
import { describe, test, expect, vi, beforeAll } from 'vitest'

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => ({ userPasswords: {}, mforeman: {} }) }),
}))
vi.mock('@/lib/accessLog', () => ({ recordAccess: async () => {}, getRequestIp: () => '' }))
vi.mock('@/lib/sites', () => ({ getSites: async () => [] }))
vi.mock('@/lib/workers', () => ({
  getWorkers: async () => [
    { id: 1, name: '日比政仁', jobType: 'yakuin', retired: '' },
    { id: 10, name: '白戸', jobType: 'shokucho', retired: '' },
    { id: 11, name: '退職職長', jobType: 'shokucho', retired: '2026-01-31' },
  ],
}))

beforeAll(() => {
  process.env.ADMIN_PASSWORD = 'pw-common'
  process.env.SUPER_ADMIN_PASSWORD = 'pw-super'
})

const login = async (body: unknown) => {
  const { POST } = await import('@/app/api/auth/route')
  return POST(new Request('http://x/api/auth', { method: 'POST', body: JSON.stringify(body) }) as never)
}

describe('職長ログイン', () => {
  test('職長を選ぶと本人の通行証が返る', async () => {
    const res = await login({ password: 'pw-common', workerId: 10 })
    expect(res.status).toBe(200)
    const { sessionToken, user } = await res.json()
    expect(user.workerId).toBe(10)
    const { verifyForemanToken } = await import('@/lib/session-token')
    expect(verifyForemanToken(sessionToken)).toBe(10)
  })
  test('政仁さん・退職した職長は共通パスワードでは選べない', async () => {
    expect((await login({ password: 'pw-common', workerId: 1 })).status).toBe(403)
    expect((await login({ password: 'pw-common', workerId: 11 })).status).toBe(403)
  })
})

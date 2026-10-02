/**
 * 定期実行（cron）の入口の鍵（lib/cron-auth.ts・2026-10-02 総合点検）
 *   - CRON_SECRET が未設定なら必ず拒否（旧: 時効処理だけ誰でも通った）
 *   - ヘッダ（Bearer / x-cron-secret）だけで受け、URL の ?secret= は見ない
 */
import { describe, test, expect, afterEach } from 'vitest'
import { isValidCronRequest, requireCron } from '@/lib/cron-auth'

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null })
const SECRET = 'this-is-a-long-cron-secret-123'

describe('isValidCronRequest', () => {
  test('未設定は拒否', () => {
    expect(isValidCronRequest(headers({ authorization: `Bearer ${SECRET}` }), undefined)).toBe(false)
    expect(isValidCronRequest(headers({ authorization: `Bearer ${SECRET}` }), '')).toBe(false)
  })
  test('Bearer か x-cron-secret が一致すれば通す', () => {
    expect(isValidCronRequest(headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true)
    expect(isValidCronRequest(headers({ 'x-cron-secret': SECRET }), SECRET)).toBe(true)
  })
  test('違う・空・長さ違いは拒否', () => {
    expect(isValidCronRequest(headers({ authorization: 'Bearer wrong' }), SECRET)).toBe(false)
    expect(isValidCronRequest(headers({ authorization: 'Bearer ' }), SECRET)).toBe(false)
    expect(isValidCronRequest(headers({}), SECRET)).toBe(false)
    expect(isValidCronRequest(headers({ 'x-cron-secret': SECRET + 'x' }), SECRET)).toBe(false)
  })
})

describe('requireCron', () => {
  const orig = process.env.CRON_SECRET
  afterEach(() => { if (orig === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = orig })
  test('未設定は 500（通さない）', () => {
    delete process.env.CRON_SECRET
    expect(requireCron({ headers: headers({ authorization: 'Bearer x' }) })?.status).toBe(500)
  })
  test('URL の ?secret= では通さない（ヘッダだけ）', () => {
    process.env.CRON_SECRET = SECRET
    expect(requireCron({ headers: headers({}) })?.status).toBe(401)
    expect(requireCron({ headers: headers({ authorization: `Bearer ${SECRET}` }) })).toBeNull()
  })
})

describe('3本の cron が共通の requireCron を通る（app/api）', () => {
  test('backup/snapshot・commute/measure・leave/cron-expiry', async () => {
    const { readFileSync } = await import('fs')
    for (const f of ['app/api/backup/snapshot/route.ts', 'app/api/commute/measure/route.ts', 'app/api/leave/cron-expiry/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain('requireCron(request)')
      expect(src, f).not.toMatch(/searchParams\.get\('secret'\)/)
    }
  })
})

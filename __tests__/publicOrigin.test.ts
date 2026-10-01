import { describe, test, expect } from 'vitest'
import { isNonProductionOrigin, PRODUCTION_ORIGIN } from '@/lib/public-origin'

// 2026-10-01: お試しサイトでコピーしても、スタッフに配るURLは本番のドメインにする
describe('isNonProductionOrigin', () => {
  test('本番はそのまま', () => expect(isNonProductionOrigin(PRODUCTION_ORIGIN)).toBe(false))
  test('お試しサイト（Preview）は本番に置き換える', () => {
    expect(isNonProductionOrigin('https://hibi-calendar-git-claude-ui-wave1-71788a-yasu-h-bytes-projects.vercel.app')).toBe(true)
    expect(isNonProductionOrigin('https://hibi-calendar-5uvv4kbqv-yasu-h-bytes-projects.vercel.app')).toBe(true)
  })
  test('手元も置き換える', () => expect(isNonProductionOrigin('http://localhost:3000')).toBe(true))
  test('独自ドメインはそのまま', () => expect(isNonProductionOrigin('https://dedura.example.jp')).toBe(false))
})

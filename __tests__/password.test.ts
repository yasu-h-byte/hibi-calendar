/**
 * 個人パスワードのハッシュ化（lib/password.ts・2026-09-26）
 */
import { describe, test, expect } from 'vitest'
import { hashPassword, verifyPassword, isHashed, passwordFingerprint } from '@/lib/password'

describe('password', () => {
  test('ハッシュは平文を含まず、正しいパスワードだけ一致する', () => {
    const h = hashPassword('correct horse')
    expect(isHashed(h)).toBe(true)
    expect(h).not.toContain('correct')
    expect(verifyPassword('correct horse', h)).toBe(true)
    expect(verifyPassword('wrong', h)).toBe(false)
  })
  test('同じパスワードでも毎回違うハッシュ（ソルト）', () => {
    expect(hashPassword('abcdefgh')).not.toBe(hashPassword('abcdefgh'))
  })
  test('平文で残っている古い保存値も照合できる（移行期間）', () => {
    expect(verifyPassword('morita2026', 'morita2026')).toBe(true)
    expect(verifyPassword('morita2027', 'morita2026')).toBe(false)
  })
  test('空は一致しない・指紋は保存値が変われば変わる', () => {
    expect(verifyPassword('', 'x')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(passwordFingerprint('a')).not.toBe(passwordFingerprint('b'))
  })
})

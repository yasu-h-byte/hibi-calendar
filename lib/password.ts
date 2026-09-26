/**
 * 個人パスワードの保存形式（2026-09-26）。サーバー専用（node:crypto）。
 *
 * 旧: demmen/main.userPasswords に平文で保存し、設定画面にもそのまま表示していた。
 * 新: scrypt でハッシュ化して保存し、画面には「設定済みかどうか」だけを出す（再発行のみ）。
 *   形式: `scrypt$<salt base64url>$<hash base64url>`
 * 移行: 平文のまま残っている古い値も照合できる（isHashed で判定）。設定画面で保存すると全員分がハッシュ化される。
 */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const PREFIX = 'scrypt$'
const KEYLEN = 32

export function isHashed(stored: string): boolean {
  return stored.startsWith(PREFIX)
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, KEYLEN)
  return `${PREFIX}${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/** 入力されたパスワードが保存値と一致するか（保存値が平文の古い形式でも照合できる） */
export function verifyPassword(plain: string, stored: string | undefined | null): boolean {
  if (!stored || !plain) return false
  if (!isHashed(stored)) {
    const a = Buffer.from(plain), b = Buffer.from(stored)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const [, saltB64, hashB64] = stored.split('$')
  if (!saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64url')
  const actual = scryptSync(plain, Buffer.from(saltB64, 'base64url'), expected.length)
  return timingSafeEqual(actual, expected)
}

/**
 * 保存値の「指紋」（通行証に埋め込む）。パスワードを変える・消すと指紋が変わり、その人の古い通行証は使えなくなる。
 * 保存値そのもの（ハッシュ）は通行証に入れない。
 */
export function passwordFingerprint(stored: string): string {
  return createHash('sha256').update(stored).digest('base64url').slice(0, 10)
}

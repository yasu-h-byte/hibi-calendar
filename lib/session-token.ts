/**
 * 職長の通行証（2026-09-26・代表判断「B: 通行証方式」）。
 *
 * 職長は共通パスワード＋名前選択でログインする。旧実装はログイン後も共通パスワードそのものを
 * API に送っていたため、サーバーからは「誰か分からない管理者（actor 'admin'）」に見え、
 * 管理者・事業責任者専用の操作（パスワード変更・復元・賃金確定・請求書承認など）まで通っていた。
 *
 * 新: ログイン時にサーバーが「この人は職長 ◯◯（workerId）」と署名した通行証を発行し、
 *     以降の API にはパスワードの代わりにこの通行証を送る。共通パスワードそのものは API では通さない。
 *
 * 形式: `ft1.<workerId>.<有効期限(UNIX秒)>.<署名>`（署名 = HMAC-SHA256・base64url）
 * 鍵: SUPER_ADMIN_PASSWORD と ADMIN_PASSWORD から作る。どちらかを変えると全職長の通行証が無効になり、
 *     ログインし直しになる（共通パスワードを変えたら古い通行証も使えなくなる＝望ましい）。
 * サーバー専用（node:crypto）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'ft1'
/** 有効期間 90日（職長は同じ端末でログインしたまま使うため長め） */
export const FOREMAN_TOKEN_TTL_SEC = 90 * 24 * 60 * 60

function key(): string | null {
  const a = process.env.SUPER_ADMIN_PASSWORD
  const b = process.env.ADMIN_PASSWORD
  if (!a || !b) return null
  return `${a}\u0000${b}`
}

function sign(body: string, k: string): string {
  return createHmac('sha256', k).update(body).digest('base64url')
}

export function isForemanTokenShape(v: string): boolean {
  return v.startsWith(`${PREFIX}.`)
}

export function createForemanToken(workerId: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const k = key()
  if (!k) throw new Error('SUPER_ADMIN_PASSWORD / ADMIN_PASSWORD not configured')
  const body = `${PREFIX}.${workerId}.${nowSec + FOREMAN_TOKEN_TTL_SEC}`
  return `${body}.${sign(body, k)}`
}

/** 正しい通行証なら workerId、そうでなければ null（改ざん・期限切れ・鍵の変更） */
export function verifyForemanToken(token: string, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const k = key()
  if (!k) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null
  const [, widStr, expStr, sig] = parts
  if (!/^\d+$/.test(widStr) || !/^\d+$/.test(expStr)) return null
  const expected = sign(`${PREFIX}.${widStr}.${expStr}`, k)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (parseInt(expStr, 10) < nowSec) return null
  return parseInt(widStr, 10)
}

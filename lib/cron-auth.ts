/**
 * 定期実行（Vercel Cron）の入口の鍵（2026-10-02 総合点検）。**cron の認証はここだけ**。
 *
 * 根本原因: 3本の cron（有給の時効処理・日次バックアップ・通勤時間の測定）がそれぞれ自前で CRON_SECRET を比べていて、
 *   決まりが食い違っていた。
 *   - 時効処理（app/api/leave/cron-expiry）は「CRON_SECRET が未設定なら誰でも通す」作りだった（ほかの2本は拒否）
 *   - バックアップと通勤測定は `?secret=` でも通した（合言葉が URL に載り、アクセスログに残る）
 *   - どれも `===` の比較（時間差で1文字ずつ当てられる余地）
 * 対処: 未設定は必ず拒否・ヘッダだけで受ける・定数時間で比べる、を1つの関数にして3本とも通す。
 *
 * 受け取り方:
 *   - Vercel Cron … `Authorization: Bearer <CRON_SECRET>`（Vercel が自動で付ける）
 *   - 手で動かすとき … 同じヘッダか `x-cron-secret: <CRON_SECRET>`（URL には付けない）
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/** 長さの違いも漏らさないよう、両方を SHA-256 にしてから定数時間で比べる */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** ヘッダの合言葉が正しいか（純粋。テスト用に expected を渡せる） */
export function isValidCronRequest(
  headers: { get(name: string): string | null },
  expected: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!expected) return false   // 未設定は必ず拒否（誤って誰でも動かせる状態にしない）
  const auth = headers.get('authorization') || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const manual = headers.get('x-cron-secret') || ''
  return (bearer !== '' && sameSecret(bearer, expected)) || (manual !== '' && sameSecret(manual, expected))
}

/**
 * cron の入口で呼ぶ。通してよければ null、だめなら返すべき応答。
 * 使い方: `const denied = requireCron(request); if (denied) return denied`
 */
export function requireCron(request: { headers: { get(name: string): string | null } }): NextResponse | null {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (!isValidCronRequest(request.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

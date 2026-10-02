import { NextRequest, NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'

/**
 * Vercel Cron用エンドポイント: 有給の時効処理を月1回自動実行
 *
 * vercel.json の crons 設定:
 * { "path": "/api/leave/cron-expiry", "schedule": "0 0 1 * *" }  // 月初 0:00 UTC (JST 9:00)
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET} を自動付与
 *      もしくは外部実行の場合は x-cron-secret ヘッダで同じ値を送る（lib/cron-auth.ts requireCron・3本共通）
 *
 * 2026-10-02 総合点検:
 *   - 旧: `if (cronSecret) { …比べる… }` の形で、CRON_SECRET が未設定の環境では**誰でも**時効処理を動かせた
 *     （バックアップ・通勤測定は未設定なら拒否。ここだけ逆だった）→ 未設定は拒否にそろえた
 *   - 旧: 自分自身を `https://${VERCEL_URL}`（デプロイごとの URL）で呼んでいた。Vercel の保護がかかる URL だと
 *     ログイン画面の HTML が返り、`res.json()` が例外になって、失敗の中身が分からなかった
 *     → この cron が呼ばれたのと同じドメインを使い、JSON でない応答も読めるようにした
 *   - 本来は fetch をやめて時効処理の関数を直接呼ぶのが筋（処理の本体が app/api/leave/route.ts の中にあるため、
 *     lib へ切り出すのは有給側の整理と合わせて行う）
 */
export async function GET(request: NextRequest) {
  // auth: Vercel Cron の CRON_SECRET（lib/cron-auth.ts requireCron。未設定は拒否）
  { const denied = requireCron(request); if (denied) return denied }

  // processExpiry アクションを内部で実行
  // 代表の通行証で /api/leave を叩く（2026-09-26: API はパスワードそのものを受け付けなくなったため）
  const { createOwnerToken } = await import('@/lib/session-token')
  let adminPassword: string
  try {
    adminPassword = createOwnerToken()
  } catch {
    return NextResponse.json({ error: 'SUPER_ADMIN_PASSWORD not configured' }, { status: 500 })
  }

  // 呼び先は、この cron が呼ばれたのと同じドメイン（合言葉を確かめたあとなので、呼び元の Host を信用してよい）。
  //   取れないときだけ Vercel の自動環境変数・手元の順
  const baseUrl = request.nextUrl?.origin && /^https?:\/\//.test(request.nextUrl.origin)
    ? request.nextUrl.origin
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT || 3000}`

  const res = await fetch(`${baseUrl}/api/leave`, {
    method: 'POST',
    headers: {
      'x-admin-password': adminPassword,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'processExpiry' }),
  })

  // JSON でない応答（保護画面の HTML・時間切れ）でも中身の頭を返す（旧: res.json() の例外で 500 だけが残った）
  const text = await res.text()
  let data: Record<string, unknown>
  try { data = JSON.parse(text) as Record<string, unknown> } catch { data = { nonJson: text.slice(0, 200) } }

  if (!res.ok || 'nonJson' in data) {
    return NextResponse.json({ error: 'processExpiry failed', status: res.status, detail: data }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    triggeredBy: 'cron',
    ...data,
  })
}

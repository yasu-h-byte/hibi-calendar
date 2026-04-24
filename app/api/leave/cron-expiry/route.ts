import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Vercel Cron用エンドポイント: 有給の時効処理を月1回自動実行
 *
 * vercel.json の crons 設定:
 * { "path": "/api/leave/cron-expiry", "schedule": "0 0 1 * *" }  // 月初 0:00 UTC (JST 9:00)
 *
 * 認証: Vercel Cron は Authorization: Bearer ${CRON_SECRET} を自動付与
 *      もしくは外部実行の場合は x-cron-secret ヘッダで同じ値を送る
 */
export async function GET(request: NextRequest) {
  // Vercel Cron の認証
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = request.headers.get('authorization') || ''
    const cronHeader = request.headers.get('x-cron-secret') || ''
    const isVercelCron = authHeader === `Bearer ${cronSecret}`
    const isManualCall = cronHeader === cronSecret
    if (!isVercelCron && !isManualCall) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // processExpiry アクションを内部で実行
  // ADMIN_PASSWORD で認証済みとして /api/leave を叩く
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD not configured' }, { status: 500 })
  }

  // ベースURLを取得（Vercelの自動環境変数から）
  const baseUrl = process.env.VERCEL_URL
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

  const data = await res.json()

  if (!res.ok) {
    return NextResponse.json({ error: 'processExpiry failed', detail: data }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    triggeredBy: 'cron',
    ...data,
  })
}

/** MF経費の申請チェック（Vercel Cron: 毎朝 7:00 JST と、途中で区切ったときの続き 7:10 JST）。docs/mf-expense-check.md */
import { NextRequest, NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron-auth'
import { getMfConnectionStatus } from '@/lib/mf-expense-client.server'
import { runMfExpenseCheck } from '@/lib/mf-expense-run.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // auth: Vercel Cron の CRON_SECRET を requireCron で確かめる
  const denied = requireCron(request)
  if (denied) return denied
  const conn = await getMfConnectionStatus()
  if (!conn.connected) return NextResponse.json({ ok: true, status: 'notConnected' })
  const result = await runMfExpenseCheck({ actor: 'cron', force: false })
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

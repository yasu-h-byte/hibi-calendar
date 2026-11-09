/**
 * 領収書の読み取り（docs/mf-expense-check.md）。
 * GET は Vercel Cron（毎朝 7:20・7:40 JST）、POST は画面のボタン（expenseCheck.edit）。
 * 読み終わったらチェックをやり直して、日付・金額のずれを一覧に出す。
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron-auth'
import { actorLabel, requireCap } from '@/lib/auth'
import { getMfConnectionStatus } from '@/lib/mf-expense-client.server'
import { runMfExpenseCheck, runMfReceiptReads } from '@/lib/mf-expense-run.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function run(actor: string) {
  const conn = await getMfConnectionStatus()
  if (!conn.connected) return NextResponse.json({ ok: true, status: 'notConnected' })
  const result = await runMfReceiptReads()
  if (result.read > 0) await runMfExpenseCheck({ actor, force: true })
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

export async function GET(request: NextRequest) {
  // auth: Vercel Cron の CRON_SECRET を requireCron で確かめる
  const denied = requireCron(request)
  if (denied) return denied
  return run('cron')
}

export async function POST(request: NextRequest) {
  const denied = await requireCap(request, 'expenseCheck.edit')
  if (denied) return denied
  return run(await actorLabel(request))
}

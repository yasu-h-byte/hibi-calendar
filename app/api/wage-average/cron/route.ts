import { NextRequest, NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron-auth'
import { withCronRecord } from '@/lib/cron-status.server'
import { recordMonthlySnapshots } from '@/lib/avg-wage.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 平均日給の記録（毎月1日・2026-11-14）。決まりは lib/avg-wage.ts、読み書きは lib/avg-wage.server.ts。
 *
 * vercel.json: { "path": "/api/wage-average/cron", "schedule": "30 0 1 * *" }（毎月1日 JST 9:30）
 * 今月の1日時点の全員の日給を wageRateSnapshots/{YYYYMM} に残す。記録の無い過去の月も人員マスタから組み立てて残す。
 * 既にある月は書き換えないので、何度動いても同じ結果になる。
 */
export async function GET(request: NextRequest) {
  // auth: Vercel Cron の CRON_SECRET（lib/cron-auth.ts requireCron。未設定は拒否）
  { const denied = requireCron(request); if (denied) return denied }
  return withCronRecord('wage-average', async () => {
    const r = await recordMonthlySnapshots()
    return NextResponse.json({ ok: true, ...r })
  })
}

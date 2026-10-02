import { NextRequest, NextResponse } from 'next/server'
import { requireCap } from '@/lib/auth'
import { getWagePlan } from '@/lib/wage-plan.server'

/**
 * 賃金改定の予定と個別事情（/wage-analysis 用・2026-10-02）
 *
 * 個人の予定時給・事情を含むので、代表（lib/permissions.ts wageAnalysis.view）にだけ返す。
 * 以前は画面の JS に直接書いてあり、ログインなしで取れる /_next/static に載っていた。
 */
export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'wageAnalysis.view')
  if (denied) return denied
  return NextResponse.json(getWagePlan(), { headers: { 'Cache-Control': 'private, no-store' } })
}

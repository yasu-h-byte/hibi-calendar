/**
 * 承認まで終わった申請（docs/mf-expense-check.md）。見るだけ。MF には何も書かない。
 * GET は月の一覧（expenseCheck.view）、POST は読み込みと領収書の読み取り（expenseCheck.edit）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { actorLabel, requireCap } from '@/lib/auth'
import { APPROVED_RECHECK_BUDGET_MS, loadMfApprovedChecks, runMfApprovedCheck, runMfReceiptReads } from '@/lib/mf-expense-run.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const validYm = (v: unknown): v is string => typeof v === 'string' && /^20\d{2}(0[1-9]|1[0-2])$/.test(v)

export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'expenseCheck.view')
  if (denied) return denied
  const ym = new URL(request.url).searchParams.get('ym')
  if (!validYm(ym)) return NextResponse.json({ error: '月が正しくありません' }, { status: 400 })
  try {
    return NextResponse.json({ checks: await loadMfApprovedChecks(ym) })
  } catch (e) {
    console.error('承認済みの申請の読み込みエラー:', e)
    return NextResponse.json({ error: '読み込みに失敗しました' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireCap(request, 'expenseCheck.edit')
  if (denied) return denied
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!validYm(body?.ym)) return NextResponse.json({ error: '月が正しくありません' }, { status: 400 })
  const ym = body.ym
  try {
    const actor = await actorLabel(request)
    if (body.action === 'load') {
      const result = await runMfApprovedCheck(ym, actor)
      return NextResponse.json(result, { status: result.ok ? 200 : 502 })
    }
    if (body.action === 'receipts') {
      const result = await runMfReceiptReads({ approvedYm: ym })
      if (result.read > 0) await runMfApprovedCheck(ym, actor, APPROVED_RECHECK_BUDGET_MS)
      return NextResponse.json(result, { status: result.ok ? 200 : 502 })
    }
    return NextResponse.json({ error: '不明な操作です' }, { status: 400 })
  } catch (e) {
    console.error('承認済みの申請の操作エラー:', e)
    return NextResponse.json({ error: '処理に失敗しました' }, { status: 500 })
  }
}

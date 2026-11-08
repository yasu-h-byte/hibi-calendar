/**
 * MF経費の OAuth の戻り先（2026-11-08）。MF の承認画面からブラウザが戻ってくる。
 * 通行証のヘッダは付かないので、代表が「つなぐ」を押したときに作った1回限りの state で確かめる。
 */
import { NextRequest, NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity'
import { completeMfConnection, consumeMfState } from '@/lib/mf-expense-client.server'
import { PRODUCTION_ORIGIN } from '@/lib/public-origin'

export const dynamic = 'force-dynamic'

const back = (result: string) => NextResponse.redirect(`${PRODUCTION_ORIGIN}/expense-check?mf=${result}`)

export async function GET(request: NextRequest) {
  // auth: public — MF からのブラウザの戻り。代表が作った1回限りの state（consumeMfState）で確かめる
  const params = request.nextUrl.searchParams
  const state = params.get('state') || ''
  const actor = await consumeMfState(state)
  if (!actor) return back('state')
  if (params.get('error')) return back('denied')
  const code = params.get('code')
  if (!code) return back('denied')
  try {
    await completeMfConnection(code, actor)
    await logActivity(actor, 'mf-expense', 'MF経費に接続しました')
    return back('connected')
  } catch (e) {
    console.error('MF接続エラー:', e instanceof Error ? e.message : 'unknown')
    return back('failed')
  }
}

/**
 * 使い方を聞く（2026-11-10）。決まりは lib/help.ts、AI の呼び出しは lib/help.server.ts。
 *
 * GET          → { configured, remaining, limit }（今日あと何回聞けるか）
 * GET ?log=1   → 質問と答えの記録・新しい順に50件（代表だけ = feedback.manage）
 * POST         → 質問する { question, history?: [{ q, a }] } → { answered, answer, sources[], remaining }
 *
 * AI に渡すのは公開マニュアルの文だけ。出面・給与などの実データは読まない・渡さない。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap, callerCan, getCallerPermRole, OWNER_WORKER_ID } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, addDoc, getDocs, query, where, orderBy, limit } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute.server'
import { todayJstIso } from '@/lib/date-utils'
import {
  HELP_COL, HELP_LIMITS, helpQuestionError, helpDocsForRole,
  type HelpAnswer, type HelpLogEntry, type HelpTurn,
} from '@/lib/help'
import { askHelp, isHelpConfigured, isHelpSetupError, isHelpBusyError } from '@/lib/help.server'

export const maxDuration = 60

async function caller(request: NextRequest): Promise<{ workerId: number; name: string } | null> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return null
  const workerId = a.actor === 'super-admin' ? OWNER_WORKER_ID : Number(a.actor)
  const main = await getMainData()
  const w = (main.workers || []).find(x => x.id === workerId)
  return { workerId, name: w?.name || (workerId === OWNER_WORKER_ID ? '日比靖仁' : `ID ${workerId}`) }
}

async function usedToday(workerId: number, day: string): Promise<number> {
  const snap = await getDocs(query(collection(db, HELP_COL), where('workerId', '==', workerId), where('day', '==', day)))
  return snap.size
}

/** 画面から来た直前のやり取りを、決まった形と長さに絞る */
function cleanHistory(raw: unknown): HelpTurn[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is HelpTurn => typeof t?.q === 'string' && typeof t?.a === 'string' && !!t.q.trim() && !!t.a.trim())
    .slice(-HELP_LIMITS.historyPairs)
    .map(t => ({ q: t.q.slice(0, HELP_LIMITS.question), a: t.a.slice(0, 4000) }))
}

export async function GET(request: NextRequest) {
  { const denied = await requireCap(request, 'help.ask'); if (denied) return denied }
  try {
    const me = await caller(request)
    if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (request.nextUrl.searchParams.get('log')) {
      if (!(await callerCan(request, 'feedback.manage'))) return NextResponse.json({ error: '見られません' }, { status: 403 })
      const snap = await getDocs(query(collection(db, HELP_COL), orderBy('at', 'desc'), limit(50)))
      const log = snap.docs.map(d => {
        const e = d.data() as HelpLogEntry
        return { id: d.id, at: e.at, name: e.name, question: e.question, answered: e.answered, answer: e.answer, sources: e.sources || [] }
      })
      return NextResponse.json({ log })
    }

    const used = await usedToday(me.workerId, todayJstIso())
    return NextResponse.json({
      configured: isHelpConfigured(),
      limit: HELP_LIMITS.perDay,
      remaining: Math.max(0, HELP_LIMITS.perDay - used),
    })
  } catch (e) {
    console.error('help GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  { const denied = await requireCap(request, 'help.ask'); if (denied) return denied }
  try {
    const me = await caller(request)
    if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isHelpConfigured()) {
      return NextResponse.json({ error: 'AI の設定がまだ済んでいません。下の「新しく書く」から代表に伝えてください' }, { status: 503 })
    }
    const body = await request.json().catch(() => null)
    const err = helpQuestionError(body?.question)
    if (err) return NextResponse.json({ error: err }, { status: 400 })
    const question = String(body.question).trim()

    const day = todayJstIso()
    const used = await usedToday(me.workerId, day)
    if (used >= HELP_LIMITS.perDay) {
      return NextResponse.json({ error: `今日はもう${HELP_LIMITS.perDay}回聞きました。続きは明日か、下の「新しく書く」から代表に伝えてください` }, { status: 429 })
    }

    const role = await getCallerPermRole(request)
    const docs = helpDocsForRole(role)
    let result
    try {
      result = await askHelp(docs, question, cleanHistory(body.history))
    } catch (e) {
      console.error('help ask error:', e)
      if (isHelpSetupError(e)) return NextResponse.json({ error: 'AI が使えない状態です（設定の問題）。下の「新しく書く」から代表に伝えてください' }, { status: 503 })
      if (isHelpBusyError(e)) return NextResponse.json({ error: 'AI が混み合っています。少し待ってからもう一度聞いてください' }, { status: 503 })
      return NextResponse.json({ error: '答えを作れませんでした。もう一度聞くか、下の「新しく書く」から代表に伝えてください' }, { status: 502 })
    }

    const entry: HelpLogEntry = {
      at: new Date().toISOString(), day, workerId: me.workerId, name: me.name, role,
      question, answered: result.answered, answer: result.answer, sources: result.sources, usage: result.usage,
    }
    // 記録に失敗しても、答えは返す（聞いた人を待たせない）。回数の歯止めが1回ぶん甘くなるだけ
    await addDoc(collection(db, HELP_COL), entry).catch(e => console.error('help log write error:', e))

    const titleOf = new Map(docs.map(d => [d.url, d.title]))
    const res: HelpAnswer = {
      answered: result.answered,
      answer: result.answer,
      sources: result.sources.map(url => ({ url, title: titleOf.get(url) || url })),
      remaining: Math.max(0, HELP_LIMITS.perDay - used - 1),
    }
    return NextResponse.json(res)
  } catch (e) {
    console.error('help POST error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/**
 * 有給の索引（leaveIndex）の点検と作り直し（代表だけ・2026-10-21 総点検 §7-1 第 1 段階）。
 *
 * GET  ?months=15        … 索引と出面の食い違いを調べる（今月から months か月さかのぼり＋先 12 か月）。何も書かない
 * POST { apply: true }   … 出面から全員ぶんの索引を作り直す（読む範囲は GET と同じ）。apply が無ければ dry run（作る中身の件数だけ返す）
 *
 * 出面は 1 件 200〜300KB なので、月数ぶんの読み取りが起きる。日に何度も叩くものではない（点検・移行のときだけ）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireCap, getApiAuthUser } from '@/lib/auth'
import { getMainData, getAttData } from '@/lib/compute.server'
import { buildLeaveIndexDays, diffLeaveIndex, readLeaveIndex, writeLeaveIndex } from '@/lib/leave-index.server'
import { isAlreadyRetired } from '@/lib/workers'
import { addMonthsSafe, todayJstIso } from '@/lib/date-utils'
import { logActivity } from '@/lib/activity'
import type { AttendanceEntry } from '@/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function monthRange(backMonths: number, aheadMonths: number): { yms: string[]; isoMonths: string[] } {
  const first = todayJstIso().slice(0, 8) + '01'
  const yms: string[] = []
  for (let i = -backMonths; i <= aheadMonths; i++) yms.push(addMonthsSafe(first, i).slice(0, 7).replace('-', ''))
  return { yms, isoMonths: yms.map(ym => `${ym.slice(0, 4)}-${ym.slice(4, 6)}`) }
}

async function loadAttByYm(yms: string[]): Promise<Record<string, Record<string, AttendanceEntry>>> {
  const list = await Promise.all(yms.map(ym => getAttData(ym).then(a => [ym, a.d] as const).catch(() => [ym, {}] as const)))
  return Object.fromEntries(list)
}

/** 代表だけ（system.admin）。退職者も含めて索引を持つ（過去の月の残数・管理簿で使う） */
async function guard(request: NextRequest) {
  // auth: requireCap(system.admin) — 索引の点検・作り直しは代表だけ
  return requireCap(request, 'system.admin')
}

export async function GET(request: NextRequest) {
  // auth: guard() の中で requireCap(system.admin)（代表だけ）
  const denied = await guard(request); if (denied) return denied
  const back = Math.min(36, Math.max(1, Number(request.nextUrl.searchParams.get('months') || 15)))
  const { yms, isoMonths } = monthRange(back, 12)
  const main = await getMainData()
  const attByYm = await loadAttByYm(yms)
  const out: { workerId: number; name: string; retired: boolean; indexed: boolean; missing: string[]; extra: string[] }[] = []
  let indexedCount = 0, diffCount = 0
  for (const w of main.workers) {
    const attDays = buildLeaveIndexDays(attByYm, w.id)
    const idx = await readLeaveIndex(w.id)
    if (idx) indexedCount++
    const d = diffLeaveIndex(idx?.days, attDays, isoMonths)
    if (!idx && Object.keys(attDays).length === 0) continue   // 有給が無く索引も無い人は書かない
    if (d.missing.length || d.extra.length || !idx) diffCount++
    out.push({ workerId: w.id, name: w.name, retired: isAlreadyRetired(w.retired), indexed: !!idx, missing: d.missing, extra: d.extra })
  }
  return NextResponse.json({ months: isoMonths, workers: main.workers.length, indexed: indexedCount, withDiff: diffCount, items: out.filter(i => i.missing.length || i.extra.length || !i.indexed) })
}

export async function POST(request: NextRequest) {
  // auth: guard() の中で requireCap(system.admin)（代表だけ）
  const denied = await guard(request); if (denied) return denied
  const body = (await request.json().catch(() => ({}))) as { apply?: boolean; months?: number }
  const back = Math.min(36, Math.max(1, Number(body.months || 15)))
  const { yms } = monthRange(back, 12)
  const main = await getMainData()
  const attByYm = await loadAttByYm(yms)
  const plan = main.workers.map(w => ({ workerId: w.id, name: w.name, days: buildLeaveIndexDays(attByYm, w.id) }))
  if (body.apply !== true) {
    return NextResponse.json({ dryRun: true, months: yms.length, workers: plan.length, totalDays: plan.reduce((s, p) => s + Object.keys(p.days).length, 0) })
  }
  let written = 0
  for (const p of plan) { await writeLeaveIndex(p.workerId, p.days); written++ }
  const auth = await getApiAuthUser(request)
  await logActivity(auth.authorized ? String(auth.actor) : 'admin', 'leaveIndex.rebuild', `有給の索引を出面から作り直し（${yms.length}か月・${written}人）`)
  return NextResponse.json({ applied: true, months: yms.length, workers: written })
}

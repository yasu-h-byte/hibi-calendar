/**
 * 休憩チェックの点検をサーバーで行う（承認の API 用・2026-10-15）。決まりは lib/break-check.ts。
 *
 * 承認の API は、本文に ackBreakCheck: true が無ければこれで点検し、疑いがあれば 409（code: break_check・issues）を返す。
 * 画面は確認窓を出して、承認すると決めたら ackBreakCheck: true を付けて送り直す。
 * PC の出面入力は手元のデータで先に点検して確認を取るので、最初から ackBreakCheck: true を付ける（出面の読み直しを増やさない）。
 */
import 'server-only'
import { NextResponse } from 'next/server'
import { parseDKey } from './compute'
import { getMainData, getAttData } from './compute.server'
import { checkBreaksForDay, BREAK_CHECK_CODE, type BreakIssue, type BreakCheckWorker } from './break-check'
import type { AttendanceEntry, SiteWorkSchedule } from '@/types'

/** 現場（工種サイトの子も含む）の指定した日の疑い。出面は1回だけ読む */
export async function breakIssuesForSiteDays(siteId: string, ym: string, days: number[]): Promise<BreakIssue[]> {
  if (days.length === 0) return []
  const main = await getMainData()
  const site = (main.sites || []).find(s => s.id === siteId) as { id: string; workSchedule?: SiteWorkSchedule } | undefined
  if (!site) return []
  const family = new Set([siteId, ...(main.sites || []).filter(s => (s as { parentId?: string }).parentId === siteId).map(s => s.id)])
  const visaOf = new Map((main.workers || []).map(w => [w.id, { visa: w.visa as string | undefined, name: w.name }]))
  const att = await getAttData(ym.replace('-', ''))
  const want = new Set(days.map(Number))
  // day → workerId → entry（同じ人が親と工種サイトの両方にあれば、時刻のある方を使う）
  const byDay = new Map<number, Map<number, AttendanceEntry>>()
  for (const [key, e] of Object.entries(att.d)) {
    if (!e) continue
    const pk = parseDKey(key)
    if (!family.has(pk.sid)) continue
    const day = Number(pk.day)
    if (!want.has(day)) continue
    const wid = Number(pk.wid)
    const m = byDay.get(day) ?? new Map<number, AttendanceEntry>()
    const cur = m.get(wid)
    if (!cur || (!cur.st && e.st)) m.set(wid, e)
    byDay.set(day, m)
  }
  const out: BreakIssue[] = []
  for (const day of [...want].sort((a, b) => a - b)) {
    const m = byDay.get(day)
    if (!m) continue
    const workers: BreakCheckWorker[] = [...m.entries()].map(([wid, entry]) => ({
      workerId: wid, name: visaOf.get(wid)?.name || `ID ${wid}`, visa: visaOf.get(wid)?.visa, entry,
    }))
    out.push(...checkBreaksForDay(day, workers, site.workSchedule))
  }
  return out
}

/** 承認の前の点検。確認済み（ack）でなく疑いがあれば 409 の応答を返す。無ければ null */
export async function breakCheckResponse(siteId: string, ym: string, days: number[], ack: unknown): Promise<Response | null> {
  if (ack === true) return null
  const issues = await breakIssuesForSiteDays(siteId, ym, days)
  if (issues.length === 0) return null
  return NextResponse.json({
    error: `休憩のチェックに打刻ミスの疑いがあります（${issues.length}件）。確認してから承認してください`,
    code: BREAK_CHECK_CODE,
    issues,
  }, { status: 409 })
}

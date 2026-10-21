/**
 * 就業カレンダーの提出・承認・差し戻し・取り消しの台帳（calendarStatusLog・append-only・2026-10-22）
 *
 * siteCalendar の submittedAt / approvedAt は取り消すと消える（revert が null にする）ので、
 * 「いつ・誰が」の時系列は残らなかった。calendarSignLog（スタッフの署名の台帳）と同じ考え方で、
 * 状態が変わるたびに1件追記し、**絶対に消さない**。
 *
 * - 1出来事 = 1ドキュメント。docId は (siteId, ym, 時刻, event) で決まり冪等
 * - byName は書いた時点の人員マスタの名前を凍結（後で名前が変わっても当時の表示が残る）
 * - 本体の書き込みが成功していれば、台帳の失敗で操作を止めない（try/catch・console.error）
 * - 日次バックアップの対象（lib/backup-plan.ts）
 */
import 'server-only'
import { db } from './firebase'
import { doc, setDoc, collection, query, where, getDocs } from '@/lib/fsdb'
import { getMainData } from './compute.server'
import type { CalendarTrailEvent, CalendarTrailEntry } from './calendar-approval-trail'

const STATUS_LOG_COL = 'calendarStatusLog'

/** 人員マスタから名前を引く（30 秒キャッシュの main を使う。見つからなければ null） */
export async function workerNamesById(): Promise<Map<number, string>> {
  const main = (await getMainData()) as unknown as { workers?: { id: number; name?: string }[] }
  const map = new Map<number, string>()
  for (const w of main.workers || []) if (typeof w.id === 'number' && w.name) map.set(w.id, w.name)
  return map
}

export async function workerNameOf(id: number | null | undefined): Promise<string | null> {
  if (id === null || id === undefined) return null
  return (await workerNamesById()).get(id) ?? null
}

export async function appendCalendarStatusLog(p: {
  siteId: string
  /** 'YYYY-MM' */
  ym: string
  event: CalendarTrailEvent
  by: number | null
  at?: string
  reason?: string | null
  note?: string | null
}): Promise<void> {
  try {
    const at = p.at || new Date().toISOString()
    const byName = await workerNameOf(p.by)
    const id = `${p.siteId}_${p.ym}_${at.replace(/[/:.]/g, '-')}_${p.event}`
    await setDoc(doc(db, STATUS_LOG_COL, id), {
      siteId: p.siteId,
      ym: p.ym,
      event: p.event,
      at,
      by: p.by,
      byName,
      reason: p.reason ?? null,
      note: p.note ?? null,
      loggedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('calendarStatusLog append failed (non-fatal):', e)
  }
}

/** 月×現場の台帳を古い順で返す */
export async function loadCalendarStatusLog(siteId: string, ym: string): Promise<CalendarTrailEntry[]> {
  const snap = await getDocs(query(collection(db, STATUS_LOG_COL), where('siteId', '==', siteId), where('ym', '==', ym)))
  const out: CalendarTrailEntry[] = []
  snap.forEach(d => {
    const x = d.data() as { event?: string; at?: string; by?: number | null; byName?: string | null; reason?: string | null; note?: string | null }
    if (!x.event || !x.at) return
    out.push({
      event: x.event as CalendarTrailEvent,
      at: x.at,
      by: x.by ?? null,
      byName: x.byName ?? null,
      reason: x.reason ?? null,
      note: x.note ?? null,
      source: 'log',
    })
  })
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

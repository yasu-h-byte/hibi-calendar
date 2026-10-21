/**
 * 休みの予定（2026-10-14）。決まりは lib/time-off.ts。見るだけ（書き込みは無い）。
 *
 * GET → { today, items: TimeOffItem[], sites: {id,name}[], mySiteIds: string[] }
 *   - 期間: 有給・欠勤届は今日〜60日先。帰国は時期に限らず、まだ終わっていないものすべて（2026-10-14 代表）
 *   - 帰国: homeLongLeave（承認済み・申請中・職長承認まで）
 *   - 有給: 出面に入った有給（承認済み）＋ leaveRequests の申請中・職長承認まで（承認待ち）
 *   - 欠勤届: 出面の「欠」（届出）
 *   - 返すのは TimeOffItem の項目だけ（理由・メモ・残日数・お金は返さない。職長も見るため）
 *
 * 出面ドキュメント（1件200〜300KB）を最大3か月読むので、結果を60秒だけ覚えておく（読み取り回数を増やさない）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser, requireCap, OWNER_WORKER_ID, foremenOfSiteForMonth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, getDocs } from '@/lib/fsdb'
import { parseDKey } from '@/lib/compute'
import { getMainData, getAttData } from '@/lib/compute.server'
import { sitesOfWorkerForMonth } from '@/lib/roster'
import { isAlreadyRetired } from '@/lib/workers'
import { todayJstIso, addDaysIso } from '@/lib/date-utils'
import { isReturnUndecided } from '@/lib/homeLeave'
import { mergeTimeOffDays, sortTimeOff, TIME_OFF_DAYS_AHEAD, type TimeOffDay, type TimeOffItem } from '@/lib/time-off'

const CACHE_MS = 60_000
let cache: { at: number; today: string; items: TimeOffItem[]; sites: { id: string; name: string }[] } | null = null

async function build(today: string) {
  const until = addDaysIso(today, TIME_OFF_DAYS_AHEAD)
  const ym = today.slice(0, 7).replace('-', '')
  const main = await getMainData()
  const workers = new Map(
    (main.workers || [])
      .filter(w => !isAlreadyRetired(w.retired, today))
      .map(w => [w.id, w]),
  )
  const siteIdsOf = (wid: number) => sitesOfWorkerForMonth(main, wid, ym).map(s => s.id)
  const nameOf = (wid: number) => workers.get(wid)?.name || ''

  const days: TimeOffDay[] = []
  const ranges: TimeOffItem[] = []

  // ── 帰国（期間で持っている）──
  const hl = await getDocs(collection(db, 'homeLongLeave'))
  hl.forEach(d => {
    const h = d.data() as { workerId: number; startDate?: string; endDate?: string; status?: string }
    if (!workers.has(h.workerId) || !h.startDate || !h.endDate) return
    const stage = h.status === 'approved' ? 'approved' : (h.status === 'pending' || h.status === 'foreman_approved') ? 'pending' : null
    if (!stage) return
    // 帰国は時期に限らず、まだ終わっていないものはすべて出す（2026-10-14 代表「帰国情報は時期に限らず全て」）
    if (h.endDate < today) return
    ranges.push({
      kind: 'home', stage, workerId: h.workerId, workerName: nameOf(h.workerId), siteIds: siteIdsOf(h.workerId),
      start: h.startDate, end: h.endDate, ...(isReturnUndecided(h.endDate) ? { returnUndecided: true } : {}),
    })
  })

  // ── 有給の申請（まだ出面に入っていない段階）──
  const lr = await getDocs(collection(db, 'leaveRequests'))
  lr.forEach(d => {
    const r = d.data() as { workerId: number; date?: string; status?: string }
    if (!workers.has(r.workerId) || !r.date) return
    if (r.status !== 'pending' && r.status !== 'foreman_approved') return
    if (r.date < today || r.date > until) return
    days.push({ kind: 'leave', stage: 'pending', workerId: r.workerId, date: r.date })
  })

  // ── 出面に入った有給（承認済み）・欠勤届 ──
  const months = new Set<string>()
  for (let iso = today; iso <= until; iso = addDaysIso(iso, 1)) months.add(iso.slice(0, 7).replace('-', ''))
  for (const m of months) {
    const att = await getAttData(m)
    const seen = new Set<string>()
    for (const [key, e] of Object.entries(att.d)) {
      if (!e) continue
      const pk = parseDKey(key)
      const wid = Number(pk.wid)
      if (!workers.has(wid)) continue
      const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
      if (iso < today || iso > until) continue
      const kind = e.p ? 'leave' : e.r ? 'absence' : null
      if (!kind) continue
      // 同じ人・同じ日が2現場にあっても1日
      const k = `${wid}_${iso}_${kind}`
      if (seen.has(k)) continue
      seen.add(k)
      days.push({ kind, stage: kind === 'leave' ? 'approved' : 'reported', workerId: wid, date: iso })
    }
  }

  // 有給は、出面に入った（承認済み）日があれば、同じ日の申請（承認待ち）は出さない
  const approvedLeave = new Set(days.filter(d => d.kind === 'leave' && d.stage === 'approved').map(d => `${d.workerId}_${d.date}`))
  const dayItems = mergeTimeOffDays(days.filter(d => !(d.kind === 'leave' && d.stage === 'pending' && approvedLeave.has(`${d.workerId}_${d.date}`))))
    .map(r => ({ ...r, workerName: nameOf(r.workerId), siteIds: siteIdsOf(r.workerId) }))

  const items = sortTimeOff([...ranges, ...dayItems])
  const sites = (main.sites || []).filter(s => !s.archived).map(s => ({ id: s.id, name: s.name || '' }))
  return { items, sites }
}

export async function GET(request: NextRequest) {
  { const denied = await requireCap(request, 'timeOff.view'); if (denied) return denied }
  try {
    const today = todayJstIso()
    if (!cache || cache.today !== today || Date.now() - cache.at > CACHE_MS) {
      const b = await build(today)
      cache = { at: Date.now(), today, ...b }
    }
    // 職長の「自分の現場」（今月の職長になっている現場）
    const a = await getApiAuthUser(request)
    const me = a.authorized ? (a.actor === 'super-admin' ? OWNER_WORKER_ID : Number(a.actor)) : null
    const main = await getMainData()
    const ym = today.slice(0, 7).replace('-', '')
    const mySiteIds = me === null ? [] : (main.sites || [])
      .filter(s => !s.archived && foremenOfSiteForMonth(s, main.mforeman || {}, ym).includes(me))
      .map(s => s.id)
    return NextResponse.json({ today, items: cache.items, sites: cache.sites, mySiteIds })
  } catch (e) {
    console.error('time-off GET error:', e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

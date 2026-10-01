/**
 * 職長の「承認すること」（2026-10-01 マイページに承認ボタンを置く・代表依頼）
 *
 * 職長のスマホのマイページ（/mypage/[token]）と、職長専用の出面画面（/attendance/foreman/[token]）で
 * 同じ判定を使うためにここへまとめた。
 *   - 出面: 担当現場 × 月 の日ごとの「入力のそろい具合・職長承認・最終承認」
 *   - まとめ承認: 全員入力済み・過去〜今日の日だけ承認（未入力＝欠勤のまま締めに流れるのを防ぐ）
 * 有給・帰国申請の職長承認は既存の /api/leave-request・/api/home-long-leave（token で本人確認）をそのまま使う。
 *
 * サーバ専用（Firestore を読む）。
 */
import { db } from './firebase'
import { doc, getDoc } from './fsdb'
import {
  getAttendanceDoc, getApprovalForDay, setApprovalForDay, getForeignWorkersForSite, getEntryStatus, getStaffSites,
} from './attendance'
import { workTypeFamilyIds, familyEntrySiteId, type HierarchySite, type WorkTypeAssignMap } from './site-hierarchy'
import { computeForemanSites, approvingForemenOfSite, buildAuthUser, isManagerRole } from './auth'
import { todayJstIso, addMonthsSafe, addDaysIso } from './date-utils'
import type { AttendanceEntry, Site } from '@/types'
import { getAssign, parseDKey, getMainData, type MainData } from './compute'
import { getWorkerByToken } from './workers'

/**
 * 工種（鉄骨・仮設など）を持つ現場の「同じ現場」の範囲（親＋工種サイト）と、工種の指定（2026-09-28）。
 * 職長が出面画面で鉄骨へ移したエントリを「未入力」「別現場の入力」と見なさないために使う。
 * 書き込み先の工種を決めるので、main は毎回読み直す（30秒キャッシュを使わない）。
 */
export async function loadSiteFamily(siteId: string): Promise<{ sites: HierarchySite[]; assign?: WorkTypeAssignMap; family: string[] }> {
  const snap = await getDoc(doc(db, 'demmen', 'main'))
  const data = snap.exists() ? snap.data() : {}
  const sites = (data.sites || []) as HierarchySite[]
  return { sites, assign: data.assign as WorkTypeAssignMap | undefined, family: workTypeFamilyIds(sites, siteId) }
}

/** 同じ現場（親＋工種）のどこかに入っているその人・その日のエントリ */
export function familyEntry(att: Record<string, AttendanceEntry>, family: string[], wid: number | string, ym: string, day: number | string): AttendanceEntry | undefined {
  const sid = familyEntrySiteId(att, family, wid, ym, day)
  return sid ? att[`${sid}_${wid}_${ym}_${day}`] : undefined
}

export interface ForemanDay {
  day: number
  /** YYYY-MM-DD */
  dateISO: string
  isWorkDay: boolean
  /** 職長承認済み */
  approved: boolean
  /** 最終承認（事業責任者）済み。職長からは取り消せない */
  final: boolean
  /** 入力済みの人数 / 対象の人数 */
  entered: number
  total: number
  missingNames: string[]
  /** 配置に残っているが、その日は別の現場で入力している人（未入力に数えない・2026-10-01 代表決定） */
  elsewhere: { name: string; siteIds: string[] }[]
}

/**
 * 出面ドキュメントから「その人・その日にどの現場で入力があるか」の索引を作る（入力なし・残骸は数えない）。
 * 1つの出面ドキュメントにつき1回だけ作る（同じリクエスト内で何度も走査しない）。
 */
const entryIndexCache = new WeakMap<object, Map<string, string[]>>()
export function entrySitesIndex(att: Record<string, AttendanceEntry>): Map<string, string[]> {
  const hit = entryIndexCache.get(att)
  if (hit) return hit
  const idx = new Map<string, string[]>()
  for (const [key, e] of Object.entries(att)) {
    if (getEntryStatus(e) === 'none') continue
    const pk = parseDKey(key)
    const k = `${pk.wid}_${pk.ym}_${Number(pk.day)}`
    const list = idx.get(k)
    if (list) list.push(pk.sid); else idx.set(k, [pk.sid])
  }
  entryIndexCache.set(att, idx)
  return idx
}

/**
 * 現場（親＋工種）にとって、その人のその日はどうか。
 *   'here' = この現場で入力あり／'elsewhere' = 別の現場で入力あり（移動・掛け持ち）／'none' = どこにも入力なし
 * 2026-10-01 代表決定: 現場を移動したのに前の現場の配置に残っている人を、前の現場で「未入力」に数えない
 * （数えると前の現場の承認がいつまでも止まる）。本当にどこにも入力が無い人だけが未入力。
 */
export function entryPlace(att: Record<string, AttendanceEntry>, family: string[], wid: number, ym: string, day: number): { place: 'here' | 'elsewhere' | 'none'; siteIds: string[] } {
  if (getEntryStatus(familyEntry(att, family, wid, ym, day)) !== 'none') return { place: 'here', siteIds: [] }
  const others = (entrySitesIndex(att).get(`${wid}_${ym}_${day}`) || []).filter(s => !family.includes(s))
  return others.length > 0 ? { place: 'elsewhere', siteIds: others } : { place: 'none', siteIds: [] }
}

/** 'YYYYMM' → 'YYYY-MM-DD'（その月の day 日） */
const isoOf = (ym: string, day: number) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`

/**
 * 現場 × 月 の日ごとの状態（1日〜今日まで。過ぎた月は月末まで）。
 * 稼働日 = 承認済みの就業カレンダーの「出勤」。カレンダーが未承認なら日曜以外。
 * 非稼働日は未入力を数えない（休みの日に入力が無いのは正常）。
 */
export async function siteMonthDays(siteId: string, ym: string, preloaded?: {
  att?: Record<string, AttendanceEntry>
  family?: string[]
  /** 対象の外国人スタッフ（読むだけの一覧ではキャッシュ済みの main から渡して読み取りを減らす） */
  workers?: { id: number; name: string }[]
}): Promise<ForemanDay[]> {
  const today = todayJstIso()
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const curYm = today.slice(0, 7).replace('-', '')
  const lastDay = ym < curYm ? daysInMonth : ym === curYm ? Number(today.slice(8, 10)) : 0
  if (lastDay === 0) return []

  const [att, family, workers, calSnap] = await Promise.all([
    preloaded?.att ? Promise.resolve(preloaded.att) : getAttendanceDoc(ym),
    preloaded?.family ? Promise.resolve(preloaded.family) : loadSiteFamily(siteId).then(f => f.family),
    preloaded?.workers ? Promise.resolve(preloaded.workers) : getForeignWorkersForSite(siteId, ym),
    getDoc(doc(db, 'siteCalendar', `${siteId}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`)).catch(() => null),
  ])
  const cal = calSnap && calSnap.exists() ? calSnap.data() : null
  const calDays = cal?.status === 'approved' && cal?.days ? cal.days as Record<string, string> : null

  const dayNums = Array.from({ length: lastDay }, (_, i) => i + 1)
  const approvals = await Promise.all(dayNums.map(d => getApprovalForDay(siteId, ym, d)))
  return dayNums.map((d, i) => {
    const isWorkDay = calDays ? calDays[String(d)] === 'work' : new Date(y, m - 1, d).getDay() !== 0
    const missingNames: string[] = []
    const elsewhere: { name: string; siteIds: string[] }[] = []
    let entered = 0
    for (const w of workers) {
      // 判定は職長画面のリストと同じ getEntryStatus（0.6補償=入力済み、残骸のみ=未入力）
      const p = entryPlace(att, family, w.id, ym, d)
      if (p.place === 'here') entered++
      else if (p.place === 'elsewhere') elsewhere.push({ name: w.name, siteIds: p.siteIds })
      else if (isWorkDay) missingNames.push(w.name)
    }
    return {
      day: d,
      dateISO: isoOf(ym, d),
      isWorkDay,
      approved: !!approvals[i]?.foreman,
      final: !!approvals[i]?.final,
      entered,
      // 別の現場で入力している人は、この現場の対象から外す（全員そろったかの判定に使う）
      total: workers.length - elsewhere.length,
      missingNames,
      elsewhere,
    }
  })
}

/**
 * まとめて職長承認する。全員入力済み・今日まで の日だけ承認し、それ以外は理由つきで返す。
 * 誰も入力していない日を承認するとスタッフ入力がロックされる（2026-09-02 大川さんの 9/1 誤承認事故）ため、
 * 未入力が1人でも残る日は承認しない。
 */
export async function approveDaysForSite(siteId: string, ym: string, days: number[], foremanId: number): Promise<{
  approvedDays: number[]
  skipped: { day: number; reason: string }[]
}> {
  const today = todayJstIso()
  const [att, { family }, workers] = await Promise.all([
    getAttendanceDoc(ym), loadSiteFamily(siteId), getForeignWorkersForSite(siteId, ym),
  ])
  const approvedDays: number[] = []
  const skipped: { day: number; reason: string }[] = []
  for (const dd of days) {
    const d = Number(dd)
    if (!Number.isInteger(d) || d < 1 || d > 31) { skipped.push({ day: d, reason: '不正な日付' }); continue }
    if (isoOf(ym, d) > today) { skipped.push({ day: d, reason: '未来日' }); continue }
    // 別の現場で入力している人（移動・掛け持ち）は未入力に数えない（siteMonthDays と同じ決まり）
    const missing = workers.filter(w => entryPlace(att, family, w.id, ym, d).place === 'none')
    if (missing.length > 0) {
      skipped.push({ day: d, reason: `未入力: ${missing.map(w => w.name).join('、')}` })
      continue
    }
    await setApprovalForDay(siteId, ym, d, foremanId)
    approvedDays.push(d)
  }
  return { approvedDays, skipped }
}

/**
 * その人が職長として承認する現場（親現場のみ。工種サイトは親にまとめる）。
 * 月別職長（mforeman）込みで、その月ごとに決める。職種が職長の人だけ（lib/auth.ts approvingForemenOfSite と同じ決まり）。
 */
export function foremanParentSites(worker: { id: number; jobType?: string }, sites: Site[], mforeman: Record<string, { foreman?: number; wid?: number }>, ym: string): Site[] {
  // 職種が職長でない人は、現場の職長に登録されていても承認しない（政仁さんが代行・2026-10-01 代表）
  if (worker.jobType !== 'shokucho') return []
  const ids = new Set(computeForemanSites(worker.id, sites, mforeman, ym))
  return sites.filter(s => ids.has(s.id) && !(s as { parentId?: string }).parentId)
}

/**
 * 申請者（外国人スタッフ）の配置現場を、今月担当する職長の workerId 集合（帰国申請の権限判定・一覧の絞り込み）。
 * 月別職長（mforeman）込み・職種が職長の人だけ（2026-10-01。旧は月別職長を見ずに判定していた）。
 */
export async function getForemenOfWorkerSites(workerId: number): Promise<Set<number>> {
  const result = new Set<number>()
  const staffSites = await getStaffSites(workerId)
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const main = mainSnap.exists() ? mainSnap.data() : {}
  const sites = (main.sites || []) as { id: string; foremen?: number[]; foreman?: number }[]
  const ym = todayJstIso().slice(0, 7).replace('-', '')
  for (const ss of staffSites) {
    const site = sites.find(s => s.id === ss.id)
    if (!site) continue
    for (const f of approvingForemenOfSite(site, main.mforeman || {}, ym, main.workers || [])) result.add(f)
  }
  return result
}

/**
 * キャッシュ済みの main（getMainData・30秒）から、現場×月の外国人スタッフと工種の範囲を作る。
 * getForeignWorkersForSite / loadSiteFamily と同じ決まり（月別配置 massign → 既定配置 assign・在留資格あり）。
 * 一覧（読むだけ）用。承認の書き込み判定は approveDaysForSite が最新の main を読み直す。
 */
export function siteRosterFromMain(main: MainData, siteId: string, ym: string): { workers: { id: number; name: string }[]; family: string[] } {
  const ids = new Set(getAssign(main, siteId, ym).workers)
  return {
    workers: main.workers.filter(w => ids.has(w.id) && w.visa && w.visa !== 'none').map(w => ({ id: w.id, name: w.name })),
    family: workTypeFamilyIds(main.sites as unknown as HierarchySite[], siteId),
  }
}

export interface StaleAssignment {
  siteId: string
  siteName: string
  workerId: number
  workerName: string
  /** 直近に出勤している別の現場（親現場名） */
  workingAt: string[]
}

/** 配置の見直しを出す日数（この日数のあいだ、この現場で入力が無く別の現場で出勤している人） */
export const STALE_ASSIGN_DAYS = 14

/**
 * 配置の見直し（2026-10-01 代表決定）: 今月の配置に残っているのに、直近 {@link STALE_ASSIGN_DAYS} 日
 * この現場（親＋工種）で入力が1件も無く、別の現場で出勤している人。現場を移動したのに前の現場の配置に
 * 残っている人を、政仁さん・事務に知らせる（配置は自動では外さない。掛け持ちの人を外さないため）。
 *
 * 読み取りは増やさない: 呼び出し側がすでに読んだ出面（前月・今月を合わせた d）を渡す。純粋関数。
 */
export function findStaleAssignments(main: MainData, attD: Record<string, AttendanceEntry>, todayIso: string): StaleAssignment[] {
  const curYm = todayIso.slice(0, 7).replace('-', '')
  const hier = main.sites as unknown as HierarchySite[]
  const idx = entrySitesIndex(attD)
  const parentOf = (sid: string) => {
    const s = hier.find(x => x.id === sid)
    return s?.parentId && hier.some(x => x.id === s.parentId) ? s.parentId : sid
  }
  // 直近の日（昨日から STALE_ASSIGN_DAYS 日さかのぼる）
  const dates: { ym: string; day: number }[] = []
  for (let i = 1; i <= STALE_ASSIGN_DAYS; i++) {
    const iso = addDaysIso(todayIso, -i)
    dates.push({ ym: iso.slice(0, 7).replace('-', ''), day: Number(iso.slice(8, 10)) })
  }
  const out: StaleAssignment[] = []
  for (const site of main.sites) {
    if (site.archived || (site as { parentId?: string }).parentId) continue
    const family = workTypeFamilyIds(hier, site.id)
    for (const wid of getAssign(main, site.id, curYm).workers) {
      const w = main.workers.find(x => x.id === wid)
      if (!w || !w.visa || w.visa === 'none') continue
      if (w.retired && w.retired < todayIso) continue
      let here = 0
      const workingAt = new Set<string>()
      for (const { ym, day } of dates) {
        for (const sid of idx.get(`${wid}_${ym}_${day}`) || []) {
          if (family.includes(sid)) { here++; continue }
          const st = getEntryStatus(attD[`${sid}_${wid}_${ym}_${day}`])
          if (st === 'work' || st === 'overtime') workingAt.add(parentOf(sid))
        }
      }
      if (here === 0 && workingAt.size > 0) {
        out.push({
          siteId: site.id, siteName: site.name, workerId: wid, workerName: w.name,
          workingAt: [...workingAt].map(id => main.sites.find(s => s.id === id)?.name || id),
        })
      }
    }
  }
  return out
}

/**
 * マイページの個人URL（トークン）の持ち主が、管理者・事業責任者（最終承認できる人）ならその人を返す。
 * 政仁さん（事業責任者）と代表。判定は buildAuthUser + isManagerRole（ログインしたときと同じ役割）。
 */
export async function managerByToken(token: string | undefined | null): Promise<{ id: number; name: string } | null> {
  if (!token) return null
  const w = await getWorkerByToken(token)
  if (!w) return null
  const main = await getMainData()
  const u = buildAuthUser(w, main.sites as unknown as Site[], main.mforeman || {})
  return isManagerRole(u.role) ? { id: w.id, name: w.name } : null
}

/** 見る月: 今月と前月（前月は締めまでに承認が要る） */
export function foremanTodoMonths(): string[] {
  const today = todayJstIso()
  const cur = today.slice(0, 7).replace('-', '')
  const prev = addMonthsSafe(today.slice(0, 8) + '01', -1).slice(0, 7).replace('-', '')
  return [prev, cur]
}

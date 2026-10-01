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
import { computeForemanSites, approvingForemenOfSite } from './auth'
import { todayJstIso, addMonthsSafe } from './date-utils'
import type { AttendanceEntry, Site } from '@/types'

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
    getForeignWorkersForSite(siteId, ym),
    getDoc(doc(db, 'siteCalendar', `${siteId}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`)).catch(() => null),
  ])
  const cal = calSnap && calSnap.exists() ? calSnap.data() : null
  const calDays = cal?.status === 'approved' && cal?.days ? cal.days as Record<string, string> : null

  const dayNums = Array.from({ length: lastDay }, (_, i) => i + 1)
  const approvals = await Promise.all(dayNums.map(d => getApprovalForDay(siteId, ym, d)))
  return dayNums.map((d, i) => {
    const isWorkDay = calDays ? calDays[String(d)] === 'work' : new Date(y, m - 1, d).getDay() !== 0
    const missingNames: string[] = []
    let entered = 0
    for (const w of workers) {
      // 判定は職長画面のリストと同じ getEntryStatus（0.6補償=入力済み、残骸のみ=未入力）
      if (getEntryStatus(familyEntry(att, family, w.id, ym, d)) !== 'none') entered++
      else if (isWorkDay) missingNames.push(w.name)
    }
    return {
      day: d,
      dateISO: isoOf(ym, d),
      isWorkDay,
      approved: !!approvals[i]?.foreman,
      final: !!approvals[i]?.final,
      entered,
      total: workers.length,
      missingNames,
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
    const missing = workers.filter(w => getEntryStatus(familyEntry(att, family, w.id, ym, d)) === 'none')
    if (workers.length > 0 && missing.length > 0) {
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

/** 見る月: 今月と前月（前月は締めまでに承認が要る） */
export function foremanTodoMonths(): string[] {
  const today = todayJstIso()
  const cur = today.slice(0, 7).replace('-', '')
  const prev = addMonthsSafe(today.slice(0, 8) + '01', -1).slice(0, 7).replace('-', '')
  return [prev, cur]
}

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
import { doc, getDoc, getDocs, collection, query, where } from './fsdb'
import {
  getAttendanceDoc, getApprovalForDay, setApprovalForDay, getEntryStatus, getStaffSites,
} from './attendance'
import { workTypeFamilyIds, familyEntrySiteId, type HierarchySite, type WorkTypeAssignMap } from './site-hierarchy'
import { computeForemanSites, approvingForemenOfSite, buildAuthUser, isManagerRole } from './auth'
import { todayJstIso, addMonthsSafe, addDaysIso } from './date-utils'
import type { AttendanceEntry, AttendanceApproval, Site } from '@/types'
import { getAssign, parseDKey, getMainData, type MainData } from './compute'
import { getWorkerByToken, isEmployedOn, isHiredByMonth, isStillActiveForMonth } from './workers'
import { evaluateDayInputs, isWorkDayOf, isoOfDay } from './attendance-missing'

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
  /** 配置に入っていないのに、この現場に入力がある人（現場の選び間違いの疑い・2026-10-02） */
  offRoster: string[]
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
 * 現場 × 月 の「稼働日か」の判定を作る（siteCalendar を1回だけ読む）。
 * 稼働日 = 承認済みの就業カレンダーの「出勤」。カレンダーが未承認なら日曜以外。
 */
export async function loadSiteWorkDayFn(siteId: string, ym: string): Promise<(day: number) => boolean> {
  const calSnap = await getDoc(doc(db, 'siteCalendar', `${siteId}_${ym.slice(0, 4)}-${ym.slice(4, 6)}`)).catch(() => null)
  const cal = calSnap && calSnap.exists() ? calSnap.data() : null
  return workDayFnOf(cal?.status === 'approved' && cal?.days ? cal.days as Record<string, string> : null, ym)
}
function workDayFnOf(calDays: Record<string, string> | null, ym: string): (day: number) => boolean {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(4, 6))
  return (d: number) => isWorkDayOf(calDays, y, m, d)   // 「仕事の日か」は共通（lib/attendance-missing.ts）
}

/**
 * 現場 × 月 の職長承認・最終承認（attendanceApprovals）をまとめて読む（2026-10-01）。
 * ドキュメントIDは `${siteId}_${ym}_${day}`（lib/attendance.ts setForemanApprovalForDay）なので、
 * ID の範囲クエリ1回で、その現場×月に「存在する」承認だけを読む。
 * 旧: 日数ぶん getDoc（存在しない日も1件ずつ読みに数えられる）。範囲クエリは
 * 「ヒットした件数（0件でも1）」の読みなので、日ごとに読むより増えることはない。
 * クエリが使えない環境では、旧と同じ日ごとの getDoc に戻す。
 */
export async function loadApprovalsForSiteMonth(siteId: string, ym: string, lastDay: number): Promise<Map<number, AttendanceApproval>> {
  const out = new Map<number, AttendanceApproval>()
  if (lastDay <= 0) return out
  const prefix = `${siteId}_${ym}_`
  try {
    const snap = await getDocs(query(
      collection(db, 'attendanceApprovals'),
      where('__name__', '>=', prefix),
      where('__name__', '<', prefix + '\uf8ff'),
    ))
    snap.forEach(d => {
      const rest = d.id.slice(prefix.length)
      // 日付部分がちょうど 1〜lastDay の数字のものだけ（他の現場IDの前方一致などを拾わない）
      if (!/^[1-9]\d?$/.test(rest)) return
      const day = Number(rest)
      if (day >= 1 && day <= lastDay) out.set(day, d.data() as AttendanceApproval)
    })
    return out
  } catch (e) {
    console.warn('[foreman-todo] 承認の範囲読みに失敗。日ごとの読みに戻します:', e)
    const days = Array.from({ length: lastDay }, (_, i) => i + 1)
    const res = await Promise.all(days.map(d => getApprovalForDay(siteId, ym, d)))
    res.forEach((a, i) => { if (a) out.set(days[i], a) })
    return out
  }
}

/**
 * 現場（親＋工種）× 1日 の入力のそろい具合。一覧（siteMonthDays）と承認（approveDaysForSite）の共通の決まり。
 *   - 別の現場で入力している人（移動・掛け持ち）は未入力に数えず、この日の対象からも外す（2026-10-01 代表決定）
 *   - 非稼働日（日曜・カレンダーの休み）は、入力した人だけが対象。入力が無い人は休みとして正常
 *     （旧: 一覧は非稼働日も全員を対象に数え、一部の人だけ出勤した日曜が名前なしの
 *       「入力がそろっていない日」に出続け、承認もできなかった・2026-10-01）
 * 純粋関数。
 */
export function evaluateSiteDay(
  att: Record<string, AttendanceEntry>, family: string[], workers: RosterWorker[],
  ym: string, day: number, isWorkDay: boolean,
): { entered: number; total: number; missingNames: string[]; elsewhere: { name: string; siteIds: string[] }[] } {
  const iso = isoOfDay(ym, day)
  // 判定は職長画面のリストと同じ getEntryStatus（0.6補償=入力済み、残骸のみ=未入力）。
  //   数え方は共通（lib/attendance-missing.ts evaluateDayInputs・2026-10-02 総合点検）。
  //   入社前・退職後の日は対象外（2026-10-02・未入力に数えると承認もできなかった）
  const places = new Map(workers.map(w => [w.id, entryPlace(att, family, w.id, ym, day)]))
  const r = evaluateDayInputs({
    workers,
    isWorkDay,
    placeOf: w => places.get(w.id)!.place,
    expectedOn: w => isEmployedOn(w, iso),
  })
  return {
    entered: r.entered,
    // 稼働日: 配置の全員（別の現場で入力している人・入社前／退職後の人を除く）／非稼働日: 入力した人だけ
    total: r.total,
    missingNames: r.missing.map(w => w.name),
    elsewhere: r.elsewhere.map(w => ({ name: w.name, siteIds: places.get(w.id)!.siteIds })),
  }
}

/**
 * 現場 × 月 の日ごとの状態（1日〜今日まで。過ぎた月は月末まで）。
 * 稼働日 = 承認済みの就業カレンダーの「出勤」。カレンダーが未承認なら日曜以外。
 * 非稼働日は未入力を数えない（休みの日に入力が無いのは正常・evaluateSiteDay）。
 */
export async function siteMonthDays(siteId: string, ym: string, preloaded?: {
  att?: Record<string, AttendanceEntry>
  family?: string[]
  /** 対象の外国人スタッフ（読むだけの一覧ではキャッシュ済みの main から渡して読み取りを減らす） */
  workers?: RosterWorker[]
  /** 配置外の入力の求め方（siteRosterFromMain の offRosterOf） */
  offRosterOf?: SiteRoster['offRosterOf']
  /**
   * 対象の外国人スタッフが0人なら就業カレンダーを読まない（マイページの一覧用。読み取りを減らす）。
   * 0人の現場は稼働日かどうかで一覧の中身が変わらない（承認の有無だけを見る）ため。
   */
  skipCalendarIfNoWorkers?: boolean
}): Promise<ForemanDay[]> {
  const today = todayJstIso()
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const curYm = today.slice(0, 7).replace('-', '')
  const lastDay = ym < curYm ? daysInMonth : ym === curYm ? Number(today.slice(8, 10)) : 0
  if (lastDay === 0) return []

  const roster = preloaded?.workers && preloaded?.family && preloaded?.offRosterOf ? null : await loadSiteRoster(siteId, ym)
  const family = preloaded?.family ?? roster!.family
  const workers = preloaded?.workers ?? roster!.workers
  const offRosterOf = preloaded?.offRosterOf ?? roster!.offRosterOf
  const skipCal = !!preloaded?.skipCalendarIfNoWorkers && workers.length === 0
  const [att, isWorkDayOf, approvals] = await Promise.all([
    preloaded?.att ? Promise.resolve(preloaded.att) : getAttendanceDoc(ym),
    skipCal ? Promise.resolve(workDayFnOf(null, ym)) : loadSiteWorkDayFn(siteId, ym),
    loadApprovalsForSiteMonth(siteId, ym, lastDay),
  ])

  const dayNums = Array.from({ length: lastDay }, (_, i) => i + 1)
  const offByDay = offRosterOf(att)
  return dayNums.map(d => {
    const isWorkDay = isWorkDayOf(d)
    const ev = evaluateSiteDay(att, family, workers, ym, d, isWorkDay)
    const ap = approvals.get(d)
    return {
      day: d,
      dateISO: isoOf(ym, d),
      isWorkDay,
      approved: !!ap?.foreman,
      final: !!ap?.final,
      ...ev,
      offRoster: (offByDay.get(d) || []).map(x => x.name),
    }
  })
}

/**
 * まとめて職長承認する。全員入力済み・今日まで の日だけ承認し、それ以外は理由つきで返す。
 * 誰も入力していない日を承認するとスタッフ入力がロックされる（2026-09-02 大川さんの 9/1 誤承認事故）ため、
 * 未入力が1人でも残る日・誰も入力していない日は承認しない。
 * 名簿・稼働日・そろい具合の判定は一覧（siteMonthDays）と同じ（loadSiteRoster・evaluateSiteDay）。
 * 非稼働日は入力した人だけが対象（入力のある人がそろっていれば承認できる）。
 */
export async function approveDaysForSite(siteId: string, ym: string, days: number[], foremanId: number): Promise<{
  approvedDays: number[]
  skipped: { day: number; reason: string }[]
}> {
  const today = todayJstIso()
  const [att, { family, workers }, isWorkDayOf] = await Promise.all([
    getAttendanceDoc(ym), loadSiteRoster(siteId, ym), loadSiteWorkDayFn(siteId, ym),
  ])
  const approvedDays: number[] = []
  const skipped: { day: number; reason: string }[] = []
  for (const dd of days) {
    const d = Number(dd)
    if (!Number.isInteger(d) || d < 1 || d > 31) { skipped.push({ day: d, reason: '不正な日付' }); continue }
    if (isoOf(ym, d) > today) { skipped.push({ day: d, reason: '未来日' }); continue }
    const ev = evaluateSiteDay(att, family, workers, ym, d, isWorkDayOf(d))
    if (ev.missingNames.length > 0) {
      skipped.push({ day: d, reason: `未入力: ${ev.missingNames.join('、')}` })
      continue
    }
    // 職長画面の1日ずつの承認と同じ: 配置の人がいるのに誰も入力していない日は承認しない
    //   その日に在籍している人で数える（2026-10-02 点検: 配置が入社前の人だけの日を、まとめ承認できなかった）
    if (workers.some(w => isEmployedOn(w, isoOf(ym, d))) && ev.entered === 0) {
      skipped.push({ day: d, reason: 'まだ誰も入力していない' })
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

/** 名簿の1人（入社日・退職日は日ごとの対象判定に使う） */
export interface RosterWorker { id: number; name: string; hireDate?: string; retired?: string }

/** 名簿を決めるのに使う main の部分 */
export type RosterSource = Pick<MainData, 'workers' | 'sites' | 'assign' | 'massign'>

/**
 * 現場×月の外国人スタッフ（名簿）と工種の範囲。**名簿の決まりはここだけ**（2026-10-01 一本化）。
 *   配置 = getAssign（その月の月別配置 massign → なければ過去12か月の月別配置をさかのぼる → 既定配置 assign）。
 *   PC の出面画面・給与計算と同じ決まり。在留資格あり（外国人スタッフ）だけ。
 * マイページの一覧・職長画面の月の俯瞰・まとめ承認・1日ずつの承認がすべてこれを使う。
 * 旧: 承認だけ getForeignWorkersForSite（massign[当月] → assign。さかのぼらない）で数えていて、
 *   一覧で「全員入力済み」の日が承認では「未入力」で弾かれる食い違いがあった。
 */
export interface SiteRoster {
  workers: RosterWorker[]
  family: string[]
  /**
   * 配置外の入力（この現場（親＋工種）に入力があるのに、親・工種どちらの配置にも入っていない人）を日ごとに返す。
   * PC の出面画面の「配置外」の行（app/api/attendance/grid）と同じ考え方。職長画面・マイページで、
   * スマホで現場を選び間違えた打刻に気づけるようにする（2026-10-02 点検: サンさん 9/5〜9 が笹塚に入り、職長のスマホでは見えなかった）
   */
  offRosterOf: (att: Record<string, AttendanceEntry | null | undefined>) => Map<number, { id: number; name: string }[]>
}

export function siteRosterFromMain(main: RosterSource, siteId: string, ym: string): SiteRoster {
  const ids = new Set(getAssign(main as MainData, siteId, ym).workers)
  const family = workTypeFamilyIds(main.sites as unknown as HierarchySite[], siteId)
  return {
    // その月に在籍していない人（入社前の月・退職後の月）は名簿に入れない。月の途中の入社・退職は evaluateSiteDay が日で外す（2026-10-02）
    workers: main.workers
      .filter(w => ids.has(w.id) && w.visa && w.visa !== 'none' && isHiredByMonth(w.hireDate, ym) && isStillActiveForMonth(w.retired, ym))
      .map(w => ({ id: w.id, name: w.name, hireDate: w.hireDate || undefined, retired: w.retired || undefined })),
    family,
    offRosterOf: att => {
      const onRoster = new Set<number>()
      for (const sid of family) for (const wid of getAssign(main as MainData, sid, ym).workers) onRoster.add(wid)
      const nameOf = new Map(main.workers.map(w => [w.id, w.name]))
      const out = new Map<number, { id: number; name: string }[]>()
      for (const [key, e] of Object.entries(att)) {
        if (!e || getEntryStatus(e) === 'none') continue
        const pk = parseDKey(key)   // キーの分解は共通（2026-10-02 総合点検。旧: lastIndexOf で自前に分けていた）
        if (pk.ym !== ym) continue
        const sid = pk.sid
        const wid = Number(pk.wid)
        const day = Number(pk.day)
        if (!family.includes(sid) || onRoster.has(wid) || !Number.isFinite(wid) || !Number.isFinite(day)) continue
        const list = out.get(day) || []
        if (!list.some(x => x.id === wid)) list.push({ id: wid, name: nameOf.get(wid) || `ID${wid}` })
        out.set(day, list)
      }
      return out
    },
  }
}

/**
 * 最新の main（30秒キャッシュを使わない）で名簿を作る。承認の書き込み判定など、
 * 配置を直した直後でも最新で数えたいところで使う。
 */
export async function loadSiteRoster(siteId: string, ym: string): Promise<SiteRoster> {
  return siteRosterFromMain(await getMainData({ fresh: true }), siteId, ym)
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
      if (!isEmployedOn(w, todayIso)) continue   // 入社前・退職後は配置の見直しに出さない
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

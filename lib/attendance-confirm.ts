/**
 * 月末の本人確認（2026-09-30 代表決定）
 *
 * スタッフが自分のスマホで「その月の出勤・休みの数」を見て、正しいか確認する。
 * 8月のグエン（201）のように、本人の入力ミス（出勤日を「休み」、会社都合の休みを
 * 「その他の休み」）が締めまで見つからず、あとで差額精算になるのを防ぐ。
 *
 * ここは画面と API で共有する「数え方」だけを持つ（Firestore を読まない純粋関数）。
 * 給与の計算は lib/compute.ts が正。ここの数字は本人に見せるための目安。
 */
import type { AttendanceEntry } from '@/types'

/**
 * 確認する月 = 前の月（2026-09-30 代表決定で変更）。
 * 旧: 月末3日（その月）と月初1〜10日（前の月）。確認のあとも職長・事業責任者の修正で数が変わり、
 * 再確認が何度も出ていたため、「その月の全部の日に職長承認と最終承認がそろってから」出すことにした。
 * 出すかどうか（承認がそろったか・締めていないか）はサーバ（lib/attendance-confirm-server.ts）で判定する。
 */
export function confirmTargetYm(todayIso: string): string {
  const y = Number(todayIso.slice(0, 4))
  const m = Number(todayIso.slice(5, 7))
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}${String(pm).padStart(2, '0')}`
}

/**
 * 本人確認の前にそろっていなければならない承認（attendanceApprovals のドキュメントID `${siteId}_${ym}_${day}`）。
 *
 * - その人の記録がある日 → 記録がある現場（工種サイトは親現場＝approvalSiteOf）のその日
 * - 記録が無い日でも、主現場のカレンダーで仕事の日なら → 主現場のその日（職長がその日の出面を見て承認したか）
 * - 入社前・退職後の日は対象外。記録が1件も無い月は空（＝確認を出さない）
 */
export function requiredApprovalKeys(args: {
  d: Record<string, AttendanceEntry | null | undefined>
  workerId: number
  ym: string
  calDays: Record<string, string> | null
  approvalSiteOf: (siteId: string) => string
  hireDate?: string
  retired?: string
}): string[] {
  const { d, workerId, ym, calDays, approvalSiteOf, hireDate, retired } = args
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6))
  const dim = new Date(y, m, 0).getDate()
  const suffix = `_${workerId}_${ym}_`
  const sitesByDay = new Map<number, Set<string>>()
  for (const [key, entry] of Object.entries(d)) {
    if (!entry) continue
    const i = key.indexOf(suffix)
    if (i <= 0) continue
    const day = Number(key.slice(i + suffix.length))
    if (!Number.isFinite(day) || day < 1 || day > dim) continue
    if (!sitesByDay.has(day)) sitesByDay.set(day, new Set())
    sitesByDay.get(day)!.add(approvalSiteOf(key.slice(0, i)))
  }
  if (sitesByDay.size === 0) return []
  const main = mainSiteOfMonth(d as Record<string, unknown>, workerId, ym)
  const mainAp = main ? approvalSiteOf(main) : null
  const keys = new Set<string>()
  for (let day = 1; day <= dim; day++) {
    const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
    if (hireDate && iso < hireDate) continue
    if (retired && iso > retired) continue
    const sites = sitesByDay.get(day)
    if (sites) { for (const sid of sites) keys.add(`${sid}_${ym}_${day}`); continue }
    const isWork = calDays ? calDays[String(day)] === 'work' : new Date(y, m - 1, day).getDay() !== 0
    if (isWork && mainAp) keys.add(`${mainAp}_${ym}_${day}`)
  }
  return [...keys]
}

/**
 * 「その他」の休みで、メモが会社都合（現場休み・60%）を指しているもの。
 * スマホに「会社の都合の休み」が無かった頃、本人がこう書いて欠勤扱いになった（201・2026-08-26）。
 */
const COMPANY_NOTE_RE = /60|６０|6割|６割|0\.6|会社|現場|げんば|công ty|cong ty|công trường|cong truong|nghỉ công|nghi cong/i
export function isSuspectCompanyRest(entry: AttendanceEntry | null | undefined): boolean {
  if (!entry || !entry.r) return false
  if (entry.rReason !== 'other') return false
  return COMPANY_NOTE_RE.test(String(entry.rNote || ''))
}

export interface MonthRestItem { day: number; reason?: string; note?: string; suspect?: boolean }

export interface StaffMonthSummary {
  ym: string
  /** 出勤した日数（夜勤のみの日も1日） */
  workDays: number
  /** 残業時間の合計 */
  otHours: number
  /** 有給 */
  plDays: number
  /** 会社の都合の休み（0.6補） */
  compDays: number
  /** 自分の都合の休み（欠） */
  restDays: number
  examDays: number
  homeLeaveDays: number
  /** 休みの日の一覧（本人が理由を見直せるように） */
  restList: MonthRestItem[]
  /** カレンダーの仕事の日なのに、何も入力が無い日（昨日まで） */
  missingDays: number[]
  /**
   * 休憩短縮（旧契約の定例の所定外・毎日20分など・2026-09-30）。設定がある人だけ。
   * 日数は給与計算（lib/compute.ts の actualWorkDays）と同じ数え方＝実際に出勤した日（w>0・現場都合休を除く・1日1回）
   */
  breakShorten?: { minPerDay: number; days: number; minutes: number }
}

type DayKind = 'leave' | 'exam' | 'rest' | 'site_off' | 'home_leave' | 'comp' | 'work' | 'none'
const PRIORITY: DayKind[] = ['leave', 'exam', 'rest', 'home_leave', 'comp', 'work', 'site_off', 'none']

function kindOf(e: AttendanceEntry): DayKind {
  if (e.p) return 'leave'
  if (e.exam) return 'exam'
  if (e.r) return 'rest'
  if (e.hk) return 'home_leave'
  if (e.h) return 'site_off'
  if (e.w === 0.6) return 'comp'
  if ((e.w || 0) > 0 || (e as { nonly?: number }).nonly) return 'work'
  return 'none'
}

/**
 * 1人・1か月の出面を数える。
 * @param d        att_YYYYMM の d マップ（キー: `${siteId}_${workerId}_${ym}_${day}`）
 * @param calDays  主現場の承認済みカレンダー（day → 'work'|'off'|'holiday'）。無ければ日曜以外を仕事の日とみなす
 * @param todayIso 未入力はこの日の前日まで数える（今日と先の日は数えない）
 */
export function summarizeWorkerMonth(args: {
  d: Record<string, AttendanceEntry | null | undefined>
  workerId: number
  ym: string
  calDays: Record<string, string> | null
  hireDate?: string
  retired?: string
  todayIso: string
  /** 休憩短縮（分/日）。この月に適用がある人だけ渡す */
  breakShortenMin?: number
  /** この日より前の日だけ数える（YYYY-MM-DD・確認した日までの範囲で「変わったか」を見るため） */
  beforeIso?: string
}): StaffMonthSummary {
  const { d, workerId, ym, calDays, hireDate, retired, todayIso, breakShortenMin, beforeIso } = args
  const isoOf = (day: number) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(4, 6))
  const dim = new Date(y, m, 0).getDate()
  const perDay = new Map<number, { kind: DayKind; entry: AttendanceEntry }>()
  let otHours = 0
  // 休憩短縮の日数は優先度と別に数える（給与計算 actualWorkDays と同じ: その日に w>0・現場都合休でない記録が1件でもあれば1日）
  const bsDaySet = new Set<number>()
  const suffix = `_${workerId}_${ym}_`
  for (const [key, entry] of Object.entries(d)) {
    if (!entry) continue
    const i = key.indexOf(suffix)
    if (i < 0) continue
    const day = Number(key.slice(i + suffix.length))
    if (!Number.isFinite(day) || day < 1 || day > dim) continue
    if (beforeIso && isoOf(day) >= beforeIso) continue
    const kind = kindOf(entry)
    if (kind === 'work') otHours += Number(entry.o || 0)
    if ((entry.w || 0) > 0 && entry.w !== 0.6) bsDaySet.add(day)
    const cur = perDay.get(day)
    if (!cur || PRIORITY.indexOf(kind) < PRIORITY.indexOf(cur.kind)) perDay.set(day, { kind, entry })
  }
  const s: StaffMonthSummary = {
    ym, workDays: 0, otHours: Math.round(otHours * 10) / 10, plDays: 0, compDays: 0, restDays: 0,
    examDays: 0, homeLeaveDays: 0, restList: [], missingDays: [],
  }
  for (const [day, { kind, entry }] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (kind === 'work') s.workDays++
    else if (kind === 'leave') s.plDays++
    else if (kind === 'comp') s.compDays++
    else if (kind === 'exam') s.examDays++
    else if (kind === 'home_leave') s.homeLeaveDays++
    else if (kind === 'rest') {
      // カレンダーで休みの日に「休み」を入れた日は、自分都合の休み（欠勤）に数えない（給与計算と同じ・2026-09-30）
      const isWork = calDays ? calDays[String(day)] === 'work' : new Date(y, m - 1, day).getDay() !== 0
      if (!isWork) continue
      s.restDays++
      s.restList.push({
        day,
        ...(entry.rReason ? { reason: entry.rReason } : {}),
        ...(entry.rNote ? { note: entry.rNote } : {}),
        ...(isSuspectCompanyRest(entry) ? { suspect: true } : {}),
      })
    }
  }
  if (breakShortenMin && breakShortenMin > 0) {
    const bsDays = bsDaySet.size
    s.breakShorten = { minPerDay: breakShortenMin, days: bsDays, minutes: bsDays * breakShortenMin }
  }
  for (let day = 1; day <= dim; day++) {
    const iso = isoOf(day)
    // 今日はまだ入力する前のことが多いので未入力に数えない（点検 2026-09-30: 毎朝「変わりました」と出ていた）
    if (iso >= todayIso) break
    if (beforeIso && iso >= beforeIso) break
    if (hireDate && iso < hireDate) continue
    if (retired && iso > retired) continue
    const isWork = calDays ? calDays[String(day)] === 'work' : new Date(y, m - 1, day).getDay() !== 0
    if (!isWork) continue
    const k = perDay.get(day)?.kind
    if (!k || k === 'none') s.missingDays.push(day)
  }
  return s
}

/** 確認したあとで出面が変わったかを見分けるための指紋 */
export function summaryFingerprint(s: StaffMonthSummary): string {
  return [s.workDays, s.otHours, s.plDays, s.compDays, s.restDays, s.examDays, s.homeLeaveDays,
    s.restList.map(r => `${r.day}${r.suspect ? 's' : ''}`).join('.'), s.missingDays.join('.')].join('|')
}

/** その月に一番多く記録がある現場（主現場）。カレンダーの判定に使う（lib/compute.ts の未入力警告と同じ考え方） */
export function mainSiteOfMonth(d: Record<string, unknown>, workerId: number, ym: string): string | null {
  const suffix = `_${workerId}_${ym}_`
  const count = new Map<string, number>()
  for (const key of Object.keys(d)) {
    const i = key.indexOf(suffix)
    if (i <= 0) continue
    const sid = key.slice(0, i)
    count.set(sid, (count.get(sid) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
}

/** Firestore attConfirm/{ym}_{workerId} */
export interface AttConfirmDoc {
  ym: string
  workerId: number
  workerName: string
  /** ok = 正しい／issue = まちがいがある */
  status: 'ok' | 'issue'
  note?: string
  summary: StaffMonthSummary
  fingerprint: string
  at: string
  /**
   * 確認した日（日本時間 YYYY-MM-DD）と、その日より前の範囲だけで作った指紋（2026-09-30 点検で追加）。
   * 「確認したあとで変わったか」はこの範囲だけで見る（確認した日以降に入力が増えても再確認にしない）
   */
  asOf?: string
  fpAsOf?: string
  /** 職長承認・最終承認がそろってからの確認か（2026-09-30〜）。無い記録（承認前の確認）は「未確認」と同じに扱う */
  afterApproval?: boolean
}

/** 確認の記録が古くなったか（確認した範囲の出面が変わったか） */
export function isConfirmStale(c: AttConfirmDoc, rangeSummary: StaffMonthSummary): boolean {
  return !!c.fpAsOf && c.fpAsOf !== summaryFingerprint(rangeSummary)
}

/** ISO 時刻 → 日本時間の日付 */
export function jstDateOf(isoTime: string): string {
  return new Date(new Date(isoTime).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

/** その月に休憩短縮（分/日）が適用されるか。人員マスタの breakShortenMin・breakShortenFrom（'YYYYMM'）から */
export function breakShortenMinFor(w: { breakShortenMin?: number; breakShortenFrom?: string }, ym: string): number {
  const min = w.breakShortenMin ?? 0
  const from = w.breakShortenFrom
  return min > 0 && from && ym.replace('-', '') >= from ? min : 0
}

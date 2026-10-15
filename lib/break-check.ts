/**
 * 休憩チェックの点検（2026-10-15 代表「休憩チェックシステム作って。特に、ベトナムスタッフ以外誰も残業ついていない日は打刻ミスの可能性高い」）。
 *
 * ベトナム人スタッフの働いた時間は「始業〜終業 − 本人がチェックした休憩」で決まる（types/index.ts calcDayShiftHours）。
 * 休憩のチェックを付け忘れると、その分が残業になって払いすぎになり、取っていないのに付けると未払いになる。
 * 承認の前に、打刻ミスの疑いがある人を出す（止めはしない。確認してから承認できる）。
 *
 * 疑いの決まり（同じ現場・同じ日で見る。時刻の入った出勤の日だけ・夜勤のみの日は見ない）:
 *   ① 午前・午後の休憩がどちらもチェックなし（その現場で任意の休憩が両方あるとき）
 *   ② 日本人（時刻の無い人）が出勤していて誰も残業が無いのに、ベトナム人に残業がある
 *   ③ 同じ日のほかのベトナム人の半数以上が取った休憩を、この人だけ取っていない
 *
 * 画面（出面入力の「確認すること」・承認の確認窓）とサーバー（承認の API）の両方がこの関数を使う。
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */
import { calcOvertimeHours, DEFAULT_WORK_SCHEDULE, type AttendanceEntry, type SiteWorkSchedule } from '@/types'

export type BreakIssueReason = 'noBreaks' | 'otAlone' | 'missedMorning' | 'missedAfternoon'

export const BREAK_ISSUE_LABEL: Record<BreakIssueReason, string> = {
  noBreaks: '午前・午後の休憩チェックなし',
  otAlone: '日本人は残業なしなのに残業あり',
  missedMorning: 'ほかの人は午前休憩あり',
  missedAfternoon: 'ほかの人は午後休憩あり',
}

export interface BreakCheckWorker {
  workerId: number
  name: string
  visa?: string | null
  entry: AttendanceEntry | undefined | null
}

export interface BreakIssue {
  day: number
  workerId: number
  workerName: string
  reasons: BreakIssueReason[]
  /** その人の残業（h）。②の説明用 */
  overtime: number
}

const isForeign = (visa?: string | null) => !!visa && (visa.startsWith('jisshu') || visa.startsWith('tokutei'))

/** 時刻の入った「出勤」の日か（有給・欠勤・帰国・現場都合休・夜勤のみの日は見ない） */
function isTimedWorkDay(e: AttendanceEntry | undefined | null): e is AttendanceEntry {
  if (!e || !e.st || !e.et || e.nonly) return false
  if (e.p || e.r || e.hk || e.h) return false
  if (e.w === 0.6) return false
  return true
}
/** 日本人などの「出勤」の日か（時刻の無い日給の入力） */
function isPlainWorkDay(e: AttendanceEntry | undefined | null): e is AttendanceEntry {
  if (!e || e.p || e.r || e.hk || e.h) return false
  return !!e.w && e.w !== 0.6
}
/** その休憩を本人が選ぶ（任意）現場か */
const optionalBreak = (b: { enabled?: boolean; mandatory?: boolean } | undefined, fallback: { enabled: boolean; mandatory: boolean }) => {
  const x = b ?? fallback
  return x.enabled !== false && !x.mandatory
}

/** 1つの現場・1日の点検 */
export function checkBreaksForDay(day: number, workers: BreakCheckWorker[], workSchedule?: SiteWorkSchedule): BreakIssue[] {
  const ws = workSchedule
  const morningOpt = optionalBreak(ws?.morningBreak, DEFAULT_WORK_SCHEDULE.morningBreak)
  const afternoonOpt = optionalBreak(ws?.afternoonBreak, DEFAULT_WORK_SCHEDULE.afternoonBreak)

  const vn = workers.filter(w => isForeign(w.visa) && isTimedWorkDay(w.entry))
  if (vn.length === 0) return []
  // 日本人（外国人でない人）で、その日に出勤した人
  const jp = workers.filter(w => !isForeign(w.visa) && isPlainWorkDay(w.entry))
  const jpAnyOt = jp.some(w => calcOvertimeHours(w.entry as AttendanceEntry, ws) > 0)

  const tookMorning = vn.filter(w => w.entry!.b1).length
  const tookAfternoon = vn.filter(w => w.entry!.b3).length

  const out: BreakIssue[] = []
  for (const w of vn) {
    const e = w.entry as AttendanceEntry
    const ot = calcOvertimeHours(e, ws)
    const reasons: BreakIssueReason[] = []
    // ① 任意の休憩が両方あるのに、どちらもチェックなし
    if (morningOpt && afternoonOpt && !e.b1 && !e.b3) reasons.push('noBreaks')
    // ② 日本人が出勤して誰も残業していないのに、この人だけ残業
    if (ot > 0 && jp.length > 0 && !jpAnyOt) reasons.push('otAlone')
    // ③ ほかのベトナム人の半数以上が取った休憩を取っていない（①に当たるときは重ねて出さない）
    if (!reasons.includes('noBreaks') && vn.length >= 2) {
      const others = vn.length - 1
      if (morningOpt && !e.b1 && tookMorning * 2 >= others && tookMorning > 0) reasons.push('missedMorning')
      if (afternoonOpt && !e.b3 && tookAfternoon * 2 >= others && tookAfternoon > 0) reasons.push('missedAfternoon')
    }
    if (reasons.length > 0) out.push({ day, workerId: w.workerId, workerName: w.name, reasons, overtime: ot })
  }
  return out
}

/** 確認窓・帯に出す1行（例: 「10/14 グエン: 午前・午後の休憩チェックなし／日本人は残業なしなのに残業あり（1.5h）」） */
export function formatBreakIssue(i: BreakIssue, month?: number): string {
  const when = month ? `${month}/${i.day}` : `${i.day}日`
  const r = i.reasons.map(x => x === 'otAlone' ? `${BREAK_ISSUE_LABEL[x]}（${i.overtime}h）` : BREAK_ISSUE_LABEL[x]).join('／')
  return `${when} ${i.workerName}: ${r}`
}

/** 確認窓の本文（多いときは先頭だけ） */
export function breakIssuesMessage(issues: BreakIssue[], month?: number, max = 8): string {
  const lines = issues.slice(0, max).map(i => '・' + formatBreakIssue(i, month))
  if (issues.length > max) lines.push(`ほか ${issues.length - max}件`)
  return lines.join('\n')
}

/** 承認の API が「休憩の確認が要る」と返すときの code */
export const BREAK_CHECK_CODE = 'break_check'

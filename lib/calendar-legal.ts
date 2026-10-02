/**
 * 変形労働時間制カレンダーの法令適合チェック（2026-06 追加）
 *
 * 1ヶ月単位の変形労働時間制（労基法32条の2）で、就業カレンダーの「休日設定(days)」が
 * 労基法上の要件を満たすかを判定する純粋関数。編集画面のリアルタイム警告と、
 * 承認API（approve / bulk-confirm）でのブロック判定の**共通ソース**にする。
 *
 * 重大度:
 *   - 'error': 無条件ブロック（月の総労働時間が法定上限超）
 *   - 'warn' : 確認の上で承認可（法定休日のない週）— 4週4日制等の例外があり得るため
 *   - 'info' : 表示のみ・ブロックしない（長時間の連続勤務）
 *
 * 既定: 1出勤日=7h、週は日曜起算、連続勤務上限6日。
 */
import type { DayType } from '@/types'
import { resolveDayType } from './calendar'

export type LegalSeverity = 'error' | 'warn' | 'info'

export interface LegalFinding {
  code: 'monthlyCap' | 'weeklyRest' | 'consecutive'
  severity: LegalSeverity
  message: string
}

export interface CalendarLegalResult {
  findings: LegalFinding[]
  /** 無条件ブロック対象（severity 'error'）が1件以上 */
  hasError: boolean
  /** 確認が必要（severity 'warn'）が1件以上 */
  hasWarn: boolean
  workDays: number
  workHours: number
  monthlyCapHours: number
  maxConsecutive: number
}

export interface CalendarLegalOptions {
  /** 1出勤日の労働時間（既定7h） */
  dailyHours?: number
  /** 週の起算曜日 0=日曜(既定) / 1=月曜 */
  weekStartsOn?: 0 | 1
  /** 連続勤務日数の上限（これを超えると info。既定6=7連勤以上で警告） */
  consecutiveLimit?: number
  /**
   * 前月・翌月の休日設定（あれば）。月をまたぐ週の法定休日と連勤を見るのに使う（2026-10-02 総合点検）。
   *   旧: 月内に収まる週だけを見ていたため、9/27(日)〜10/3(土) が全部出勤でも 9月・10月どちらの検査にも出なかった。
   *   隣の月のカレンダーがまだ無ければ従来どおり月内だけ（その月を承認するときに見る）。
   */
  prevMonthDays?: Record<string, DayType | string> | null
  nextMonthDays?: Record<string, DayType | string> | null
}

/** ym ("YYYY-MM" or "YYYYMM") → [year, month1-12] */
function parseYm(ym: string): [number, number] {
  const compact = ym.replace('-', '')
  return [parseInt(compact.slice(0, 4), 10), parseInt(compact.slice(4, 6), 10)]
}

function fmtMd(y: number, m: number, d: number): string {
  return `${m}/${d}`
}

/** 検査に使う1日（前月の末尾・当月・翌月の先頭をつなげた並び） */
interface TimelineDay { y: number; m: number; d: number; work: boolean; inMonth: boolean }

/**
 * カレンダーの休日設定を労基法要件で検査する。
 * @param days  day(文字列 "1".."31") → 'work' | 'off' | 'holiday'。キーが無い日は resolveDayType（日曜休み・他は出勤）
 * @param ym    "YYYY-MM" or "YYYYMM"
 */
export function checkCalendarLegal(
  days: Record<string, DayType | string> | null | undefined,
  ym: string,
  opts: CalendarLegalOptions = {},
): CalendarLegalResult {
  const dailyHours = opts.dailyHours ?? 7
  const weekStartsOn = opts.weekStartsOn ?? 0
  const consecutiveLimit = opts.consecutiveLimit ?? 6

  const [y, m] = parseYm(ym)
  const daysInMonth = new Date(y, m, 0).getDate()
  const isWork = (d: number) => resolveDayType(days, y, m, d) === 'work'

  const findings: LegalFinding[] = []

  // 集計（当月だけ）
  let workDays = 0
  for (let d = 1; d <= daysInMonth; d++) if (isWork(d)) workDays++
  const workHours = workDays * dailyHours
  const monthlyCapHours = Math.round((daysInMonth * 40 / 7) * 10) / 10

  // ① 月の総労働時間 ≤ 暦日数×40/7（= 週平均40h）— 無条件ブロック
  if (workHours > monthlyCapHours) {
    const maxDays = Math.floor(monthlyCapHours / dailyHours)
    findings.push({
      code: 'monthlyCap',
      severity: 'error',
      message: `所定 ${workHours}h（出勤${workDays}日）が法定上限 ${monthlyCapHours.toFixed(1)}h（暦日${daysInMonth}日×40÷7）を超えています。出勤を${maxDays}日以下にしてください。`,
    })
  }

  // 並び: 前月（あれば）＋当月＋翌月（あれば）。当月に1日もかからない週・連勤は報告しない
  const timeline: TimelineDay[] = []
  if (opts.prevMonthDays) {
    const py = m === 1 ? y - 1 : y
    const pm = m === 1 ? 12 : m - 1
    const pdim = new Date(py, pm, 0).getDate()
    for (let d = 1; d <= pdim; d++) {
      timeline.push({ y: py, m: pm, d, work: resolveDayType(opts.prevMonthDays, py, pm, d) === 'work', inMonth: false })
    }
  }
  for (let d = 1; d <= daysInMonth; d++) timeline.push({ y, m, d, work: isWork(d), inMonth: true })
  if (opts.nextMonthDays) {
    const ny = m === 12 ? y + 1 : y
    const nm = m === 12 ? 1 : m + 1
    const ndim = new Date(ny, nm, 0).getDate()
    for (let d = 1; d <= ndim; d++) {
      timeline.push({ y: ny, m: nm, d, work: resolveDayType(opts.nextMonthDays, ny, nm, d) === 'work', inMonth: false })
    }
  }

  // ② 法定休日（労基法35条）— 起算曜日から7日間に休みが1日もない週を警告。
  //    7日が並びに収まり、当月の日を1日でも含む週だけ（隣の月が無ければ月内に収まる週だけ＝従来どおり）
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i]
    if (new Date(t.y, t.m - 1, t.d).getDay() !== weekStartsOn) continue
    if (i + 6 >= timeline.length) continue
    const week = timeline.slice(i, i + 7)
    if (!week.some(x => x.inMonth)) continue
    if (week.every(x => x.work)) {
      const a = week[0]; const b = week[6]
      findings.push({
        code: 'weeklyRest',
        severity: 'warn',
        message: `${fmtMd(a.y, a.m, a.d)}〜${fmtMd(b.y, b.m, b.d)} の週に休日がありません（法定休日・労基法35条）。週に最低1日の休みが必要です。`,
      })
    }
  }

  // ③ 連続勤務日数（健康配慮）— consecutiveLimit を超える連続出勤を表示のみで通知（当月に1日でもかかる並び）
  let run: TimelineDay[] = []
  let maxConsecutive = 0
  const flush = () => {
    if (run.length > 0 && run.some(x => x.inMonth)) {
      if (run.length > maxConsecutive) maxConsecutive = run.length
      if (run.length > consecutiveLimit) {
        const a = run[0]; const b = run[run.length - 1]
        findings.push({
          code: 'consecutive',
          severity: 'info',
          message: `${fmtMd(a.y, a.m, a.d)}〜${fmtMd(b.y, b.m, b.d)} に${run.length}連勤があります（連続勤務日数の上限超過）。`,
        })
      }
    }
    run = []
  }
  for (const t of timeline) {
    if (t.work) run.push(t)
    else flush()
  }
  flush()

  return {
    findings,
    hasError: findings.some(f => f.severity === 'error'),
    hasWarn: findings.some(f => f.severity === 'warn'),
    workDays,
    workHours,
    monthlyCapHours,
    maxConsecutive,
  }
}

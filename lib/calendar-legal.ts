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
}

/** ym ("YYYY-MM" or "YYYYMM") → [year, month1-12] */
function parseYm(ym: string): [number, number] {
  const compact = ym.replace('-', '')
  return [parseInt(compact.slice(0, 4), 10), parseInt(compact.slice(4, 6), 10)]
}

function fmtMd(y: number, m: number, d: number): string {
  return `${m}/${d}`
}

/**
 * カレンダーの休日設定を労基法要件で検査する。
 * @param days  day(文字列 "1".."31") → 'work' | 'off' | 'holiday'
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
  const isWork = (d: number) => (days?.[String(d)] ?? '') === 'work'

  const findings: LegalFinding[] = []

  // 集計
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

  // ② 法定休日（労基法35条）— 各週（起算曜日基準・月内に収まる7日間）に休みが1日もない週を警告
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow !== weekStartsOn) continue
    if (d + 6 > daysInMonth) continue // 月をまたぐ部分週は判定不能（隣月のカレンダーで判定）
    let allWork = true
    for (let k = 0; k < 7; k++) if (!isWork(d + k)) { allWork = false; break }
    if (allWork) {
      findings.push({
        code: 'weeklyRest',
        severity: 'warn',
        message: `${fmtMd(y, m, d)}〜${fmtMd(y, m, d + 6)} の週に休日がありません（法定休日・労基法35条）。週に最低1日の休みが必要です。`,
      })
    }
  }

  // ③ 連続勤務日数（健康配慮）— consecutiveLimit を超える連続出勤を表示のみで通知
  let run = 0
  let runStart = 0
  let maxConsecutive = 0
  const flush = (endDay: number) => {
    if (run > consecutiveLimit) {
      findings.push({
        code: 'consecutive',
        severity: 'info',
        message: `${fmtMd(y, m, runStart)}〜${fmtMd(y, m, endDay)} に${run}連勤があります（連続勤務日数の上限超過）。`,
      })
    }
  }
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWork(d)) {
      if (run === 0) runStart = d
      run++
      if (run > maxConsecutive) maxConsecutive = run
    } else {
      flush(d - 1)
      run = 0
    }
  }
  flush(daysInMonth)

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

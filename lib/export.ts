import * as XLSX from 'xlsx-js-style'
import { orgKeyOf } from './locks'
import {
  RawWorker,
  RawSite,
  RawSubcon,
  PLRecord,
  parseDKey,
} from './compute'
import {
  WorkerMonthly,
  SubconMonthly,
  SiteSummary,
} from './compute-monthly'
import {
  calculateOvertimeSummary,
} from './compute-overtime'
import { AttendanceEntry, calcActualHours, calcManDays } from '@/types'
import { isWorkingDay } from './attendance'
import { isStillActiveForMonth, isAlreadyRetired, isHiredByMonth, effectiveHourlyRateForYm } from './workers'
import { computeRecordBalance } from './leave-compute'
import { calcLastUsableDayIso, isLeaveExpiredAsOf, addMonthsSafe } from './date-utils'
// 2026-06-XX 追加: 自動検算を Excel にも反映
import { validatePayrolls, type PayrollSnapshot } from './payroll-validator'
import { JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM } from './constants'

// ────────────────────────────────────────
//  共通ヘルパー
// ────────────────────────────────────────

export const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

/**
 * 勤務時間一覧（社労士提出用）の1日分の実労働時間を計算する。
 *   dayHours = その日の総実労働時間（所定＋残業）
 *   dayOT    = うち残業部分
 * 呼び出し側は dayHours をそのまま合計に使う（残業を二重に足さない）。
 *
 * ★ 2026-07-06: 時間ベース入力(st/et)の日に、残業込みの実労働時間へさらに残業を
 *   足していた二重加算バグ（例: 実9.5hが12h表示）を解消。回帰防止のため純粋関数化。
 */
export function timesheetDayHours(
  entry: { st?: string; et?: string; w?: number; o?: number },
  dailyPrescribedForWorker: number,
  // 現場の休憩設定（2026-10-02 総合点検）。旧は渡しておらず既定の 30/60/30 分で引いていたため、
  //   休憩の長さが違う現場では給与計算（calcActualHours に現場の設定を渡す）と実労働時間が合わなかった
  workSchedule?: Parameters<typeof calcActualHours>[1],
): { dayHours: number; dayOT: number } {
  if (entry.st && entry.et) {
    // calcActualHours は残業込みの実労働時間を返す → これがそのまま総労働時間
    const dayHours = calcActualHours(entry as AttendanceEntry, workSchedule)
    const dayOT = Math.max(0, dayHours - dailyPrescribedForWorker)
    return { dayHours, dayOT }
  }
  // レガシー入力: 所定 × w（半日0.5は半分、補償日0.6は0.6按分）＋ 残業 o
  // 2026-08-27 修正（給与総点検）: 半日勤務(w=0.5)が所定フル時間で出て
  //   社労士提出の勤務時間一覧が過大表示になっていた
  const base = Math.round(dailyPrescribedForWorker * (entry.w ?? 1) * 10) / 10
  const dayOT = entry.o || 0
  return { dayHours: base + dayOT, dayOT }
}

export function ymLabel(ym: string): string {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return `${y}年${m}月`
}

export function daysInMonth(ym: string): number {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m, 0).getDate()
}

export function dayLabel(ym: string, day: number): string {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const d = new Date(y, m - 1, day)
  return `${day}(${DOW_SHORT[d.getDay()]})`
}

export function isSunday(ym: string, day: number): boolean {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m - 1, day).getDay() === 0
}

export function isSaturday(ym: string, day: number): boolean {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m - 1, day).getDay() === 6
}

/** Apply column widths to a worksheet */
export function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map(w => ({ wch: w }))
}

/** Apply row heights to header rows */
export function setRowHeight(ws: XLSX.WorkSheet, row: number, height: number) {
  if (!ws['!rows']) ws['!rows'] = []
  ws['!rows'][row] = { hpt: height }
}

// ────────────────────────────────────────
//  5. 有給管理台帳
//  2026-08-04 帳票整理: 旧 generatePLLedger（2シート・サマリー版）は削除した。
//  generateLeaveLedger（4シート・買取/時季指定の記録付き）と同じ法定帳簿の二重実装で、
//  修正が片方にしか入らないドリフトが実際に起きかけていたため
//  （有効期限が1日甘くなるバグを両方で個別に修正した経緯がある）。
//  /api/export?type=pl と /api/leave/export-ledger の両方が generateLeaveLedger を使う。
// ────────────────────────────────────────

// ────────────────────────────────────────
//  Workbook → Buffer
// ────────────────────────────────────────

/**
 * 締める前（未確定）に出した帳票の印（2026-09-30 代表決定）。
 * 先頭に「未確定（締め前）」のシートを差し込み、開いたときに最初に目に入るようにする。
 * キャシュモ・社労士・外注先へ、締める前の数字を提出してしまう事故を防ぐ（出すこと自体は止めない）。
 */
export const UNCONFIRMED_SHEET_NAME = '未確定（締め前）'
export function markUnconfirmedWorkbook(wb: XLSX.WorkBook, info: { ymLabel: string; orgLabel: string; docLabel: string; at: string }): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet([
    ['⚠ この帳票は、月締めの前（未確定）に出したものです'],
    [],
    [`対象: ${info.ymLabel}・${info.orgLabel}（${info.docLabel}）`],
    [`出力日時: ${info.at}`],
    [],
    ['まだ月締めしていないため、出面の修正や承認によって数字が変わることがあります。'],
    ['キャシュモ・社労士・外注先への提出には使わず、月締めのあとに出し直したものを使ってください。'],
    [],
    ['数字は2枚目以降のシートにあります。'],
  ])
  ws['!cols'] = [{ wch: 90 }]
  XLSX.utils.book_append_sheet(wb, ws, UNCONFIRMED_SHEET_NAME)
  wb.SheetNames = [UNCONFIRMED_SHEET_NAME, ...wb.SheetNames.filter(n => n !== UNCONFIRMED_SHEET_NAME)]
  return wb
}

export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
  return Buffer.from(buf)
}

// ────────────────────────────────────────
//  有給管理簿 (Phase 7)
//  労基法施行規則24条の7準拠
// ────────────────────────────────────────

export interface LeaveLedgerWorker {
  id: number
  name: string
  org: string
  visa: string
  hireDate?: string
  // 2026-06-XX 修正: 退職日は string (YYYY-MM-DD) で扱う（旧 boolean から変更）
  retired?: string
}

export interface LeaveLedgerRecord {
  fy: string | number
  grantDate?: string
  grantDays?: number
  carryOver?: number
  adjustment?: number
  /** 旧形式フィールド（移行期データ互換） */
  grant?: number
  carry?: number
  adj?: number
  expiredDays?: number
  expiredAt?: string
  buyoutDays?: number
  buyoutHistory?: Array<{ at: string; days: number; amount?: number; reason?: string }>
  designatedLeaves?: Array<{ date: string; note?: string }>
  method?: string
  grantedAt?: string
  grantedBy?: number | string
  _archived?: boolean
}

export interface LeaveLedgerData {
  workers: LeaveLedgerWorker[]
  plData: Record<string, LeaveLedgerRecord[]>
  allAtt: Record<string, AttendanceEntry>  // 全期間の出面データ
  /** 会社別フィルタ（2026-08-04 追加。省略時は全社）。会社ごとに社労士が異なるため */
  org?: 'hibi' | 'hfu' | 'all'
}

// 管理簿の Excel は lib/leave-ledger.ts（2026-10-05 に「一覧表＋1人1枚の個人票」へ作り直し。ここには型だけ残す）

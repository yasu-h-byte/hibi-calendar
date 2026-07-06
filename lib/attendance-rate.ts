/**
 * 出勤率・出勤指標 算出ユーティリティ
 *
 * これは「正の真理」となる出勤率算出ロジック。評価画面・ダッシュボード等から
 * 共通利用することで、計算結果の不整合を防ぐ。
 *
 * 公式（2026-05-09 改訂）:
 *   出勤率 = (実出勤日 + 有給日 + 試験日) / 期待出勤日 × 100  (上限100%)
 *
 * 実出勤日:
 *   - 日単位で w 値を合算しキャップ 1.0（多現場合算、partial はそのまま honoring）
 *   - ベトナム人スタッフの w=0.6（土曜補償出勤）は分子・分母どちらにも含めない
 *
 * 有給日 / 試験日:
 *   - p / exam フラグが立つ日（出勤扱い）
 *
 * 期待出勤日:
 *   Σ workDays[ym] (フォールバック: 月内の平日数)
 *   ▲ 雇用前の日（入社前は対象外）
 *   ▲ 退職後の日（退職後は対象外）
 *   ▲ 一時帰国期間内の平日（homeLeaves から取得）
 *   ▲ 14日以上の連続無出勤期間内の平日（突発帰国等の自動検出）
 *
 * 過去のバグ（2026-05-09 までの旧ロジック）:
 *   1. workDays 欠損月が 0 扱いで分母が小さくなり 100%超
 *   2. w=0.6 を一律 +1 扱いで分子水増し
 *   3. 多現場で同日が複数カウント
 *   4. 試験日が出勤にカウントされない
 *   5. 一時帰国期間が分母から除外されない
 *   6. 100%キャップなし
 */

import { isWorkingDay } from './attendance'
import { getAttData, getMainData, parseDKey, type MainData } from './compute'
import { getAllActiveHomeLeaves } from './homeLeave'
import { addMonthsSafe } from './date-utils'
import type { AttendanceEntry } from '@/types'

/**
 * periodEnd（ISO日付）から monthsBack ヶ月前までの YYYYMM を最古順で列挙する。
 *   年・月の整数計算で行う。Date.setMonth は periodEnd が29〜31日のとき
 *   対象月が繰り上がって1ヶ月抜け落ちるため使わない（監査⑦）。
 */
export function enumerateYmsBack(periodEndIso: string, monthsBack: number): string[] {
  const [endY, endM] = periodEndIso.slice(0, 7).split('-').map(Number)
  const endM0 = endM - 1  // 0-indexed
  const out: string[] = []
  for (let i = monthsBack; i >= 0; i--) {
    const t = endM0 - i
    const y = endY + Math.floor(t / 12)
    const m0 = ((t % 12) + 12) % 12
    out.push(`${y}${String(m0 + 1).padStart(2, '0')}`)
  }
  return out
}

export interface AttendanceRateResult {
  /** 出勤率 (0〜100、上限100%キャップ済み) */
  attendanceRate: number
  /** キャップ前の生比率（デバッグ用、稀に100%超でも実態把握できる） */
  rawRate: number
  /** 実出勤日（partial 集計、補償日 w=0.6 は除外） */
  workedDays: number
  /** 出勤扱い日数 = workedDays + plDays + examDays */
  presentDays: number
  /** 有給日数 */
  plDays: number
  /** 試験日数 */
  examDays: number
  /** 欠勤日数（参考） */
  restDays: number
  /** 帰国扱い日数（参考） */
  homeLeaveDays: number
  /** 現場休日数（参考） */
  siteOffDays: number
  /** 補償日（w=0.6 ベトナム土曜）日数（分子・分母から除外、参考） */
  compensationDays: number
  /** 残業時間合計 */
  totalOvertime: number
  /** 平均残業（h/月） */
  overtimeAvg: number
  /** 期間中の workDays 合計（フォールバック含む） */
  prescribedTotal: number
  /** 適用可能な期待出勤日数（除外項目を引いた値） */
  applicablePrescribed: number
  /** 各種除外日数の内訳 */
  excludedDays: {
    beforeHire: number
    afterRetire: number
    homeLeave: number
    longAbsence: number
  }
  /** 集計対象月リスト（YYYYMM） */
  ymList: string[]
}

interface CalcAttendanceRateOpts {
  workerId: number
  /** 評価日など、期間の終端日付 (YYYY-MM-DD) */
  periodEnd: string
  /** 期間の月数（デフォルト12ヶ月） */
  monthsBack?: number
  /** main データ（省略時は内部で取得） */
  main?: MainData
}

/**
 * 月内の平日数（土日除く）を計算（workDays フォールバック用）
 * 祝日は考慮しないため概算値だが、データ欠損時の救済策として妥当。
 */
function calcWeekdayCount(ym: string): number {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const lastDay = new Date(y, m, 0).getDate()
  let count = 0
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow !== 0 && dow !== 6) count++
  }
  return count
}

/** ベトナム人スタッフの土曜補償日かどうか */
function isCompensationDay(entry: AttendanceEntry, workerVisa: string, dow: number): boolean {
  return workerVisa !== 'none' && entry.w === 0.6 && dow === 6
}

/** ISO 日付 (YYYY-MM-DD) を Date に */
function isoToDate(iso: string): Date {
  return new Date(iso)
}

/** Date を YYYYMMDD キーに */
function dateKey(y: number, m: number, d: number): string {
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
}

/**
 * 評価対象スタッフの出勤指標を算出する。
 */
export async function calcAttendanceMetrics(
  opts: CalcAttendanceRateOpts,
): Promise<AttendanceRateResult> {
  const { workerId, periodEnd, monthsBack = 12 } = opts
  const main = opts.main ?? (await getMainData())
  const worker = main.workers.find(w => w.id === workerId)
  const workerVisa = worker?.visa || 'none'

  const periodEndDate = isoToDate(periodEnd)
  // 期間始端 = periodEnd の monthsBack ヶ月前の同日
  //   ※ Date.setMonth は月末日(29〜31日)起点だと繰り上がる（例: 5/31 の11ヶ月前が
  //     6/31→7/1 になる）。addMonthsSafe で末日クランプして正しく計算する（監査⑦）。
  const periodStartDate = isoToDate(addMonthsSafe(periodEnd, -monthsBack))

  // 雇用境界
  const hireDate = worker?.hireDate ? isoToDate(worker.hireDate) : null
  const retireDate = worker?.retired ? isoToDate(worker.retired) : null

  // 一時帰国期間（2026-05-13: homeLongLeave コレクションを単一ソースとして取得）
  const allHomeLeaves = await getAllActiveHomeLeaves()
  const homeLeaveRanges = allHomeLeaves
    .filter(hl => hl.workerId === workerId)
    .map(hl => ({
      start: isoToDate(hl.startDate),
      end: isoToDate(hl.endDate),
    }))

  // 期間内の月リスト（最古から）
  const ymList = enumerateYmsBack(periodEnd, monthsBack)
  const uniqYmList = Array.from(new Set(ymList))

  // attData を一括取得
  const attResults = await Promise.all(uniqYmList.map(ym => getAttData(ym)))
  const attByYm: Record<string, Record<string, AttendanceEntry>> = {}
  for (let i = 0; i < uniqYmList.length; i++) {
    attByYm[uniqYmList[i]] = attResults[i].d
  }

  // 当該 worker の全エントリを {dateKey: 状態集約} に変換
  // 多現場の場合は同日複数エントリを集約
  type DayStatus = {
    hasHomeLeaveFlag: boolean
    hasPL: boolean
    hasExam: boolean
    hasSiteOff: boolean
    hasRest: boolean
    workSum: number       // 全現場の w を合算
    isCompensation: boolean // 全エントリ補償日（vietnamese土曜w=0.6）
    overtimeSum: number
  }
  const dayMap: Record<string, DayStatus> = {}

  for (const ym of uniqYmList) {
    const att = attByYm[ym]
    if (!att) continue
    for (const [key, entry] of Object.entries(att)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (pk.wid !== String(workerId)) continue
      if (pk.ym !== ym) continue
      const dayN = parseInt(pk.day, 10)
      if (!Number.isFinite(dayN) || dayN <= 0) continue
      const y = parseInt(ym.slice(0, 4))
      const m = parseInt(ym.slice(4, 6))
      const date = new Date(y, m - 1, dayN)
      const dow = date.getDay()
      const dk = dateKey(y, m, dayN)

      const isComp = isCompensationDay(entry, workerVisa, dow)

      const ds = dayMap[dk] || {
        hasHomeLeaveFlag: false,
        hasPL: false,
        hasExam: false,
        hasSiteOff: false,
        hasRest: false,
        workSum: 0,
        isCompensation: true, // 全現場が補償日のときだけ true
        overtimeSum: 0,
      }
      if ((entry.hk ?? 0) > 0) ds.hasHomeLeaveFlag = true
      if ((entry.p ?? 0) > 0) ds.hasPL = true
      if ((entry.exam ?? 0) > 0) ds.hasExam = true
      if ((entry.h ?? 0) > 0) ds.hasSiteOff = true
      if ((entry.r ?? 0) > 0) ds.hasRest = true
      // 出勤判定 (isWorkingDay は w>0 かつ 非作業フラグなし)
      if (isWorkingDay(entry as AttendanceEntry)) {
        ds.workSum += entry.w || 0
        ds.overtimeSum += entry.o || 0
        if (!isComp) ds.isCompensation = false  // 1つでも非補償ならフラグ折り畳む
      } else {
        ds.isCompensation = false
      }
      dayMap[dk] = ds
    }
  }

  // 集計
  let workedDays = 0
  let plDays = 0
  let examDays = 0
  let restDays = 0
  let homeLeaveDays = 0
  let siteOffDays = 0
  let compensationDays = 0
  let totalOvertime = 0

  for (const [, ds] of Object.entries(dayMap)) {
    // 優先順位: 帰国 > 有給 > 試験 > 現場休 > 欠勤 > 出勤
    if (ds.hasHomeLeaveFlag) {
      homeLeaveDays++
    } else if (ds.hasPL) {
      plDays++
    } else if (ds.hasExam) {
      examDays++
    } else if (ds.hasSiteOff) {
      siteOffDays++
    } else if (ds.hasRest) {
      restDays++
    } else if (ds.workSum > 0) {
      if (ds.isCompensation) {
        compensationDays++
      } else {
        workedDays += Math.min(ds.workSum, 1)
        totalOvertime += ds.overtimeSum
      }
    }
  }

  const presentDays = workedDays + plDays + examDays

  // 期間中の所定日数算出
  let prescribedTotal = 0
  for (const ym of uniqYmList) {
    // workDays が 0 や undefined なら weekday count を fallback
    const wd = main.workDays[ym]
    prescribedTotal += (typeof wd === 'number' && wd > 0) ? wd : calcWeekdayCount(ym)
  }

  // 除外日数を計算（期待出勤から引く）
  // ※ 期間 = monthsBack ヶ月前から periodEnd までの「全営業日（平日）」を走査して
  //   雇用前/退職後/帰国期間/長期不在 を判定する。
  let excBeforeHire = 0
  let excAfterRetire = 0
  let excHomeLeave = 0
  let excLongAbsence = 0

  // 連続無出勤検出用：日次出勤フラグ列を作成
  const periodDays: { date: Date; dk: string; isWeekday: boolean }[] = []
  const tmp = new Date(periodStartDate)
  tmp.setHours(0, 0, 0, 0)
  const endTmp = new Date(periodEndDate)
  endTmp.setHours(23, 59, 59, 999)
  while (tmp <= endTmp) {
    const dow = tmp.getDay()
    periodDays.push({
      date: new Date(tmp),
      dk: dateKey(tmp.getFullYear(), tmp.getMonth() + 1, tmp.getDate()),
      isWeekday: dow !== 0 && dow !== 6,
    })
    tmp.setDate(tmp.getDate() + 1)
  }

  // 14日以上の連続「無記録 or 帰国」期間を検出 → 長期不在として除外
  const noWorkFlags = periodDays.map(({ dk }) => {
    const ds = dayMap[dk]
    if (!ds) return true                                    // 未記録日は無出勤扱い
    if (ds.hasHomeLeaveFlag) return true                    // 帰国日も無出勤扱い
    if (ds.workSum > 0 && !ds.isCompensation) return false  // 真出勤
    if (ds.hasPL || ds.hasExam) return false                // 出勤扱いの休暇
    return true                                              // それ以外は無出勤
  })

  const longAbsenceFlags = new Array(periodDays.length).fill(false)
  let streakStart = 0
  for (let i = 0; i <= noWorkFlags.length; i++) {
    if (i === noWorkFlags.length || !noWorkFlags[i]) {
      const streakLen = i - streakStart
      if (streakLen >= 14) {
        for (let j = streakStart; j < i; j++) longAbsenceFlags[j] = true
      }
      streakStart = i + 1
    }
  }

  // 各日について除外判定（平日のみ分母にカウント）
  for (let i = 0; i < periodDays.length; i++) {
    const { date, isWeekday } = periodDays[i]
    if (!isWeekday) continue
    if (hireDate && date < hireDate) { excBeforeHire++; continue }
    if (retireDate && date > retireDate) { excAfterRetire++; continue }
    if (homeLeaveRanges.some(hl => date >= hl.start && date <= hl.end)) { excHomeLeave++; continue }
    if (longAbsenceFlags[i]) { excLongAbsence++; continue }
  }

  // 期待出勤日 = prescribedTotal - 各種除外
  // ※ excludeAll は重複しない設計（continue で1日1理由のみ計上）
  const totalExclusions = excBeforeHire + excAfterRetire + excHomeLeave + excLongAbsence
  const applicablePrescribed = Math.max(0, prescribedTotal - totalExclusions)

  // 出勤率
  const rawRate = applicablePrescribed > 0
    ? (presentDays / applicablePrescribed) * 100
    : 0
  const attendanceRate = Math.min(100, Math.round(rawRate * 100) / 100)

  // 残業平均（月数で割る）
  const overtimeAvg = uniqYmList.length > 0
    ? Math.round((totalOvertime / uniqYmList.length) * 100) / 100
    : 0

  return {
    attendanceRate,
    rawRate: Math.round(rawRate * 100) / 100,
    workedDays: Math.round(workedDays * 100) / 100,
    presentDays: Math.round(presentDays * 100) / 100,
    plDays,
    examDays,
    restDays,
    homeLeaveDays,
    siteOffDays,
    compensationDays,
    totalOvertime: Math.round(totalOvertime * 100) / 100,
    overtimeAvg,
    prescribedTotal,
    applicablePrescribed,
    excludedDays: {
      beforeHire: excBeforeHire,
      afterRetire: excAfterRetire,
      homeLeave: excHomeLeave,
      longAbsence: excLongAbsence,
    },
    ymList: uniqYmList,
  }
}

/** 出勤率からボーナスポイント算出（既存ルール踏襲） */
export function calcAttendanceBonus(rate: number): number {
  if (rate >= 98) return 3
  if (rate >= 95) return 2
  if (rate >= 90) return 1
  return 0
}

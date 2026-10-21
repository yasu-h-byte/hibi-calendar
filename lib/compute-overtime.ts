/**
 * 3 段階残業判定（1 か月単位の変形労働時間制。キャシュモ向け: 日→週→月の段階的な法定外労働時間）
 * 2026-10-21 総点検で lib/compute.ts から分離。計算の中身は変えていない。
 */
import { AttendanceEntry, calcActualHours, calcNightShiftHours } from '@/types'
import { RawSite, ceilYen } from './compute'
import { isWorkingDay } from './attendance'

// ────────────────────────────────────────
//  3段階残業判定（1ヶ月単位の変形労働時間制）
//  キャシュモ向け: 日→週→月の段階的法定外労働時間計算
// ────────────────────────────────────────

export interface DailyWorkRecord {
  day: number             // 日（1〜31）
  dayOfWeek: number       // 曜日（0=日, 1=月, ..., 6=土）
  weekNum: number         // 週番号（月曜起算）
  prescribed: number      // 所定時間（カレンダー出勤日=7, 休日=0）
  actual: number          // 実労働時間（所定+残業、0なら不在）
  overtime: number        // 出面入力の残業時間（生データ）
  isWorkDay: boolean      // カレンダー上の出勤日か
  isLegalHoliday: boolean // 法定休日（日曜日）か
  isPaidLeave: boolean    // 有給か
  dailyStatutoryOT: number // 第1段階: 日単位の法定外残業
}

export interface WeeklyOTResult {
  weekNum: number
  weekPrescribed: number  // 週の所定時間合計
  weekActual: number      // 週の実労働時間合計
  weeklyStatutoryOT: number // 第2段階: 週単位の法定外残業（日単位分を除く）
}

export interface OvertimeSummary {
  // 所定情報
  prescribedHours: number      // 月の所定労働時間合計
  prescribedDays: number       // 月の所定労働日数
  // 実績
  actualHours: number          // 月の実労働時間合計
  actualDays: number           // 月の実労働日数
  // 残業区分
  nonStatutoryOT: number       // 所定外労働時間（所定を超えるが法定内）
  statutoryOT: number          // 法定外労働時間（3段階判定の合計）
  dailyStatutoryOT: number     // 第1段階: 日単位の法定外
  weeklyStatutoryOT: number    // 第2段階: 週単位の法定外
  monthlyStatutoryOT: number   // 第3段階: 月単位の法定外
  // 休日労働
  legalHolidayHours: number    // 法定休日に働いた時間
  prescribedHolidayHours: number // 所定休日に働いた時間
  // 基本給
  hourlyRate: number           // 時間給
  fixedBasePay: number         // 基本給（固定）= 時給 × ベース日数 × 7h
  // 日次詳細
  dailyRecords: DailyWorkRecord[]
  weeklyResults: WeeklyOTResult[]
}

/**
 * 3段階残業判定を実行
 *
 * @param ym YYYYMM形式
 * @param workerId ワーカーID
 * @param hourlyRate 時間給
 * @param baseDays ベース日数（デフォルト20）
 * @param attD 出面データ
 * @param sites 現場リスト
 * @param calendarDays カレンダー日種別（siteId → { "1": "work", ... }）
 */
export function calculateOvertimeSummary(
  ym: string,
  workerId: number,
  hourlyRate: number,
  baseDays: number,
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string; workSchedule?: RawSite['workSchedule'] }[],
  calendarDays: Record<string, Record<string, string>>,
): OvertimeSummary {
  // ⚠️ 2026-05-09: この関数は「変形労働時間制（5月以降）」専用。
  //   1日所定 7h・法定上限 = 暦日数×40÷7・3段階残業判定 を前提とした計算をする。
  //   4月以前（旧ルール: 6h40min・所定日数ベース）にこの関数を呼ぶと不正な値が出るため、
  //   呼び出し側 (lib/export.ts) では `if (ym >= '202605')` でガード済み。
  //   念のためここでも防御。
  if (ym < '202605') {
    throw new Error(`calculateOvertimeSummary は5月以降の変形労働時間制専用です（受け取った ym=${ym}）`)
  }
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const numDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = numDays * 40 / 7

  // ── 日次データ構築 ──
  const dailyRecords: DailyWorkRecord[] = []

  for (let d = 1; d <= numDays; d++) {
    const dt = new Date(ymY, ymM - 1, d)
    const dow = dt.getDay() // 0=日

    // 週番号（月曜起算: 月=0, 火=1, ..., 日=6）
    const firstDay = new Date(ymY, ymM - 1, 1)
    const firstMondayOffset = (firstDay.getDay() + 6) % 7 // 月初の月曜からの日数
    const dayOffset = (d - 1) + firstMondayOffset
    const weekNum = Math.floor(dayOffset / 7) + 1

    // カレンダーから所定時間を判定（複数現場 → 出勤日があれば出勤）
    // ⚠️ 2026-05-08 修正: 所定時間を「現場の workSchedule から動的計算」に変更。
    //   旧: prescribed = isWorkDay ? 7 : 0 （IHI現場 7:30-16:30 でも 7h 固定だった）
    //   新: 当日に出勤予定の現場の workSchedule から実労働所定を計算
    let isWorkDay = false
    let workSiteIdForDay: string | null = null
    for (const siteId of Object.keys(calendarDays)) {
      const dayType = calendarDays[siteId]?.[String(d)]
      if (dayType === 'work') {
        isWorkDay = true
        workSiteIdForDay = siteId
        break
      }
    }

    const isLegalHoliday = dow === 0 // 日曜日 = 法定休日

    // 現場の workSchedule から所定時間を計算（休憩を引いた実労働相当）
    const calcPrescribedH = (siteId: string | null): number => {
      if (!siteId) return 7
      const site = sites.find(s => s.id === siteId)
      const ws = site?.workSchedule
      if (!ws?.startTime || !ws?.endTime) return 7  // workSchedule 未設定 → デフォルト 7h
      const stParts = ws.startTime.split(':').map(Number)
      const etParts = ws.endTime.split(':').map(Number)
      const startMin = stParts[0] * 60 + (stParts[1] || 0)
      const endMin = etParts[0] * 60 + (etParts[1] || 0)
      let totalMin = endMin - startMin
      // 休憩は mandatory のものを引く（出勤予定の所定時間なので強制休憩のみ控除）
      if (ws.morningBreak?.enabled !== false && ws.morningBreak?.mandatory) totalMin -= ws.morningBreak.minutes ?? 30
      if (ws.lunchBreak?.enabled !== false && ws.lunchBreak?.mandatory) totalMin -= ws.lunchBreak.minutes ?? 60
      if (ws.afternoonBreak?.enabled !== false && ws.afternoonBreak?.mandatory) totalMin -= ws.afternoonBreak.minutes ?? 30
      // 必須休憩のみだと長すぎるので、デフォルトのフル休憩で計算したい場合は全体引く
      // 現状の運用は「全休憩を取る前提」 → 全部引く
      if (ws.morningBreak?.enabled !== false && !ws.morningBreak?.mandatory) totalMin -= ws.morningBreak?.minutes ?? 30
      if (ws.afternoonBreak?.enabled !== false && !ws.afternoonBreak?.mandatory) totalMin -= ws.afternoonBreak?.minutes ?? 30
      return Math.max(0, Math.round(totalMin / 60 * 10) / 10)
    }
    const prescribed = isWorkDay ? calcPrescribedH(workSiteIdForDay) : 0

    // 出面データから実労働時間を取得
    let actual = 0
    let overtime = 0
    let isPaidLeave = false

    for (const site of sites) {
      const key = `${site.id}_${workerId}_${ym}_${d}`
      const entry = attD[key]
      if (!entry) continue
      if (entry.p) { isPaidLeave = true; break }
      // ⚠️ 2026-05-09 修正: 残骸データ対策。
      //   有給/休み/現場休/帰国中/試験 のステータスがある日は実労働を計上しない。
      //   isWorkingDay() で 5 ステータスを一括判定。
      if (!isWorkingDay(entry)) continue
      // 2026-08-27 修正（給与総点検・社労士Excel）: 給与計算(calcVN)との基準統一3点。
      //   ① 同日複数現場は加算（旧: `actual =` の上書きで最後の現場だけになり過少）
      //   ② レガシー入力の半日(w=0.5等)は w×7h（旧: 半日でも 7h 固定で過大）
      //   ③ 夜勤ブロック(ns)の実労働を calcNightShiftHours で加算（旧: 夜勤月が過少）
      if (entry.w && entry.w > 0) {
        if (entry.st && entry.et) {
          // 時間ベース入力（202605〜）: calcActualHours で実時間（休憩控除済み）を取得
          actual += calcActualHours(entry, site.workSchedule as Parameters<typeof calcActualHours>[1])
        } else {
          // レガシー入力: 出勤 = w×7h + 残業h
          actual += entry.w === 0.6 ? Math.round(7 * 0.6 * 10) / 10 : entry.w * 7
          actual += entry.o || 0
        }
      }
      if ((entry as { ns?: number }).ns) {
        actual += calcNightShiftHours(entry)
      }
    }
    if (!isPaidLeave && actual > 0) {
      actual = Math.round(actual * 10) / 10
      overtime = Math.max(0, Math.round((actual - 7) * 10) / 10)
    }

    // 第1段階: 日単位の法定外
    let dailyStatutoryOT = 0
    if (!isPaidLeave && actual > 0 && !isLegalHoliday) {
      if (prescribed <= 8) {
        // 所定8h以下の日 → 8hを超えた分
        dailyStatutoryOT = Math.max(0, actual - 8)
      } else {
        // 所定8h超の日 → その所定を超えた分
        dailyStatutoryOT = Math.max(0, actual - prescribed)
      }
    }

    dailyRecords.push({
      day: d, dayOfWeek: dow, weekNum, prescribed, actual, overtime,
      isWorkDay, isLegalHoliday, isPaidLeave, dailyStatutoryOT,
    })
  }

  // ── 第2段階: 週単位 ──
  const weekNums = [...new Set(dailyRecords.map(r => r.weekNum))].sort((a, b) => a - b)
  const weeklyResults: WeeklyOTResult[] = []

  for (const wn of weekNums) {
    const weekDays = dailyRecords.filter(r => r.weekNum === wn)
    // 法定休日労働は週の実労働から除外（別枠）
    const weekPrescribed = weekDays.reduce((s, r) => s + r.prescribed, 0)
    const weekActual = weekDays.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.actual, 0)
    const weekDailyOT = weekDays.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.dailyStatutoryOT, 0)

    let weeklyStatutoryOT = 0
    if (weekPrescribed <= 40) {
      // 所定40h以下の週 → 40hを超えた分（日単位分を除く）
      weeklyStatutoryOT = Math.max(0, weekActual - 40 - weekDailyOT)
    } else {
      // 所定40h超の週 → その所定を超えた分（日単位分を除く）
      weeklyStatutoryOT = Math.max(0, weekActual - weekPrescribed - weekDailyOT)
    }

    weeklyResults.push({ weekNum: wn, weekPrescribed, weekActual, weeklyStatutoryOT })
  }

  // ── 第3段階: 月単位 ──
  const totalActual = dailyRecords.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.actual, 0)
  const totalDailyOT = dailyRecords.filter(r => !r.isLegalHoliday).reduce((s, r) => s + r.dailyStatutoryOT, 0)
  const totalWeeklyOT = weeklyResults.reduce((s, w) => s + w.weeklyStatutoryOT, 0)
  const monthlyStatutoryOT = Math.max(0, totalActual - legalLimit - totalDailyOT - totalWeeklyOT)

  // ── 集計 ──
  const prescribedHours = dailyRecords.reduce((s, r) => s + r.prescribed, 0)
  const prescribedDays = dailyRecords.filter(r => r.isWorkDay).length
  const actualHours = dailyRecords.reduce((s, r) => s + r.actual, 0) // 法定休日含む
  const actualDays = dailyRecords.filter(r => r.actual > 0 && !r.isPaidLeave).length

  // 法定休日労働
  const legalHolidayHours = dailyRecords
    .filter(r => r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + r.actual, 0)

  // 所定休日労働（法定休日以外で、カレンダー上休日だが出勤した日）
  const prescribedHolidayHours = dailyRecords
    .filter(r => !r.isWorkDay && !r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + r.actual, 0)

  // 所定外労働（所定時間を超えた全時間。法定内・法定外の両方を含む）
  const nonStatutoryOT = dailyRecords
    .filter(r => !r.isLegalHoliday && r.actual > 0)
    .reduce((s, r) => s + Math.max(0, r.actual - r.prescribed), 0)

  const statutoryOT = Math.round((totalDailyOT + totalWeeklyOT + monthlyStatutoryOT) * 10) / 10
  const fixedBasePay = ceilYen(hourlyRate * baseDays * 7)  // 支給: 切り上げ

  return {
    prescribedHours: Math.round(prescribedHours * 10) / 10,
    prescribedDays,
    actualHours: Math.round(actualHours * 10) / 10,
    actualDays,
    nonStatutoryOT: Math.round(nonStatutoryOT * 10) / 10,
    statutoryOT,
    dailyStatutoryOT: Math.round(totalDailyOT * 10) / 10,
    weeklyStatutoryOT: Math.round(totalWeeklyOT * 10) / 10,
    monthlyStatutoryOT: Math.round(monthlyStatutoryOT * 10) / 10,
    legalHolidayHours: Math.round(legalHolidayHours * 10) / 10,
    prescribedHolidayHours: Math.round(prescribedHolidayHours * 10) / 10,
    hourlyRate,
    fixedBasePay,
    dailyRecords,
    weeklyResults,
  }
}

import * as XLSX from 'xlsx'
import {
  RawWorker,
  RawSubcon,
  WorkerMonthly,
  SubconMonthly,
  SiteSummary,
  PLRecord,
  parseDKey,
  calculateOvertimeSummary,
} from './compute'
import { AttendanceEntry, calcActualHours } from '@/types'
import { isWorkingDay } from './attendance'
import { isStillActiveForMonth, isAlreadyRetired, isHiredByMonth } from './workers'
import { computePeriodUsed } from './leave-compute'
import { calcExpiryIso, todayJstIso } from './date-utils'
// 2026-06-XX 追加: 自動検算を Excel にも反映
import { validatePayrolls, type PayrollSnapshot } from './payroll-validator'

// ────────────────────────────────────────
//  共通ヘルパー
// ────────────────────────────────────────

const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

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
): { dayHours: number; dayOT: number } {
  if (entry.st && entry.et) {
    // calcActualHours は残業込みの実労働時間を返す → これがそのまま総労働時間
    const dayHours = calcActualHours(entry as AttendanceEntry, undefined as unknown as Parameters<typeof calcActualHours>[1])
    const dayOT = Math.max(0, dayHours - dailyPrescribedForWorker)
    return { dayHours, dayOT }
  }
  // レガシー入力: 所定（補償日は0.6按分）＋ 残業 o を足して総労働時間にする
  const base = entry.w === 0.6 ? Math.round(dailyPrescribedForWorker * 0.6 * 10) / 10 : dailyPrescribedForWorker
  const dayOT = entry.o || 0
  return { dayHours: base + dayOT, dayOT }
}

function ymLabel(ym: string): string {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return `${y}年${m}月`
}

function daysInMonth(ym: string): number {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m, 0).getDate()
}

function dayLabel(ym: string, day: number): string {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const d = new Date(y, m - 1, day)
  return `${day}(${DOW_SHORT[d.getDay()]})`
}

function isSunday(ym: string, day: number): boolean {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m - 1, day).getDay() === 0
}

function isSaturday(ym: string, day: number): boolean {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  return new Date(y, m - 1, day).getDay() === 6
}

/** Apply column widths to a worksheet */
function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map(w => ({ wch: w }))
}

/** Apply row heights to header rows */
function setRowHeight(ws: XLSX.WorkSheet, row: number, height: number) {
  if (!ws['!rows']) ws['!rows'] = []
  ws['!rows'][row] = { hpt: height }
}

// ────────────────────────────────────────
//  1. 日比建設向け出面一覧
// ────────────────────────────────────────

export interface HibiAttendanceData {
  ym: string
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  sites: { id: string; name: string }[]
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
  /** カレンダーの日ごとの種別（siteId → { "1": "work", "2": "off", ... }）*/
  calendarDays?: Record<string, Record<string, string>>
}

/**
 * 勤務時間一覧シートを生成（変形労働時間制の外国人スタッフ用、共通ロジック）
 * HFU向け・日比建設向けの両方で使用
 */
function appendTimeSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  titlePrefix: string,
  ym: string,
  foreignWorkers: RawWorker[],
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string }[],
  calendarDays?: Record<string, Record<string, string>>,
) {
  const numDays = daysInMonth(ym)
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const calDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = Math.round(calDays * 40 / 7 * 10) / 10

  // 4月/5月の境界で1日の所定時間が違う。
  //   4月以前 (旧ルール): 6時間40分 = 20/3h（休憩140分）
  //   5月以降 (変形労働時間制): 7時間（休憩120分）
  const useNewRules = ym >= '202605'
  const dailyPrescribed = useNewRules ? 7 : 20 / 3
  const dailyPrescribedDisplay = Math.round(dailyPrescribed * 100) / 100  // 6.67 / 7
  const ruleLabel = useNewRules ? '変形労働時間制' : '旧ルール'

  // 週番号: 月の1日を含む週をW1とし、日曜始まりで区切る
  const weekNums: number[] = []
  for (let d = 1; d <= numDays; d++) {
    const firstDay = new Date(ymY, ymM - 1, 1)
    const firstDow = firstDay.getDay()
    const dayOffset = (d - 1) + firstDow
    weekNums.push(Math.floor(dayOffset / 7) + 1)
  }

  // 所定時間: カレンダーから取得
  const prescribedHours: number[] = []
  for (let d = 1; d <= numDays; d++) {
    let isWorkDay = false
    if (calendarDays) {
      for (const siteId of Object.keys(calendarDays)) {
        const dayType = calendarDays[siteId]?.[String(d)]
        if (dayType === 'work') { isWorkDay = true; break }
      }
    }
    prescribedHours.push(isWorkDay ? dailyPrescribed : 0)
  }
  const totalPrescribed = Math.round(prescribedHours.reduce((s, h) => s + h, 0) * 10) / 10

  const headers = ['名前', '区分']
  for (let d = 1; d <= numDays; d++) headers.push(dayLabel(ym, d))
  headers.push('合計', '法定上限')

  const titleRow = [`${titlePrefix} 勤務時間一覧 ${ymLabel(ym)}（${ruleLabel}）`]
  const rows: (string | number)[][] = [titleRow, headers]

  // 所定時間行
  const prescRow: (string | number)[] = ['', '所定(h)']
  for (let d = 0; d < numDays; d++) prescRow.push(prescribedHours[d] > 0 ? dailyPrescribedDisplay : '')
  prescRow.push(totalPrescribed, legalLimit)
  rows.push(prescRow)

  // 週番号行
  const weekRow: (string | number)[] = ['', '週']
  for (let d = 0; d < numDays; d++) weekRow.push(`W${weekNums[d]}`)
  weekRow.push('', '')
  rows.push(weekRow)

  rows.push([])

  // 各ワーカー
  for (const w of foreignWorkers) {
    const hoursRow: (string | number)[] = [w.name, '実労働(h)']
    const otRow: (string | number)[] = ['', 'うち残業(h)']
    const statusRow: (string | number)[] = ['', '出欠']

    let totalHours = 0, totalOT = 0, plCount = 0

    for (let d = 1; d <= numDays; d++) {
      const dd = String(d)
      let dayHours = 0, dayOT = 0, status = ''
      let isPL = false

      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${dd}`
        const entry = attD[key]
        if (!entry) continue
        if (entry.p) { isPL = true; break }
        // ⚠️ 2026-05-09: 残骸データ対策。休み/現場休/帰国中/試験 のステータスがある日は実労働を計上しない
        if (!isWorkingDay(entry)) continue
        if (entry.w && entry.w > 0) {
          // 2026-06-XX 修正 (I-11/I-12): 時間ベース入力(st/et)があれば実労働時間を採用
          //   - 旧: 一律 dailyPrescribed (7h or 6h40m) で固定 → 実労働が短い場合に過大表示
          //   - 新: st/et から実労働時間を計算 (休憩控除済み)、無ければ従来通り
          // 2026-06-XX 追加 (I-12): w に旧ルール継続フラグがあれば 6h40m を採用
          // 注: appendTimeSheet の sites 型は最小限 {id, name} のため workSchedule を持たない
          //     → workSchedule なしで calcActualHours を呼ぶと「休憩控除なし」になる可能性
          //     現状は最低限の整合性として実労働時間を直接計算
          const dailyPrescribedForWorker = w.useOldRules ? 20 / 3 : dailyPrescribed
          ;({ dayHours, dayOT } = timesheetDayHours(entry, dailyPrescribedForWorker))
          status = entry.w === 0.6 ? '補' : dayOT > 0 ? '出+残' : '出'
        }
      }

      if (isPL) {
        status = '有給'; plCount++
        hoursRow.push(''); otRow.push('')
      } else if (dayHours > 0) {
        // dayHours は既に総実労働時間（所定＋残業）。dayOT を再度足さない。
        const actualH = Math.round(dayHours * 10) / 10
        hoursRow.push(actualH); otRow.push(dayOT > 0 ? dayOT : '')
        totalHours += actualH; totalOT += dayOT
      } else {
        hoursRow.push(''); otRow.push('')
      }
      statusRow.push(status)
    }

    hoursRow.push(Math.round(totalHours * 10) / 10, '')
    otRow.push(totalOT > 0 ? Math.round(totalOT * 10) / 10 : '', '')
    statusRow.push(plCount > 0 ? `有給${plCount}日` : '', '')

    rows.push(hoursRow); rows.push(otRow); rows.push(statusRow); rows.push([])
  }

  // 備考行
  rows.push([])
  rows.push(['【計算方法】'])
  if (useNewRules) {
    rows.push(['', '1日の所定: 7時間（8:00-17:00、休憩2時間）'])
    rows.push(['', '法定上限: 暦日数 × 40 ÷ 7 =', legalLimit, 'h'])
    rows.push(['', '残業判定: 1日単位(8h超) → 1週単位(40h超) → 1ヶ月単位(法定上限超) の3段階'])
    rows.push(['', '※ 「実労働(h)」= 所定7h + 残業h で変換済み。「うち残業(h)」は出面入力の残業欄の値。'])
    // 2026-06-XX: 個別に旧ルール継続のスタッフがいる場合の注意書き
    const oldRulesNames = foreignWorkers.filter(w => w.useOldRules).map(w => w.name)
    if (oldRulesNames.length > 0) {
      rows.push(['', `⚠️ 旧ルール継続スタッフ: ${oldRulesNames.join(', ')}`])
      rows.push(['', '　　上記スタッフは1日所定 6時間40分（合計表示の7h/日は参考値、実際の所定時間は ×6.667 で計算）'])
      rows.push(['', '　　月所定時間 = 月所定日数 × 6時間40分 で別途算出されます'])
    }
  } else {
    rows.push(['', '1日の所定: 6時間40分（8:00-17:00、休憩140分）'])
    rows.push(['', '法定上限: 暦日数 × 40 ÷ 7 =', legalLimit, 'h（参考表示）'])
    rows.push(['', '残業判定（旧ルール）: 月の実労働 > 月の所定時間（=所定日数×6時間40分）の超過分'])
    rows.push(['', '※ 「実労働(h)」= 所定6h40min + 残業h で変換済み。「うち残業(h)」は出面入力の残業欄の値。'])
    rows.push(['', '※ 週6日×6h40min = 40h で法定上限ぴったり。土曜出勤は追加割増なし。'])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 3 } }]
  const colWidths = [14, 10]; for (let d = 0; d < numDays; d++) colWidths.push(7); colWidths.push(8, 8)
  setColWidths(ws, colWidths)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
}

/**
 * 勤怠サマリーシートを追加（キャシュモ向け: 3段階残業判定の結果）
 * 個人別に月次の所定時間/実労働/法定外/休日労働/基本給を出力
 */
function appendOvertimeSummarySheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  titlePrefix: string,
  ym: string,
  foreignWorkers: RawWorker[],
  attD: Record<string, AttendanceEntry>,
  sites: { id: string; name: string }[],
  calendarDays: Record<string, Record<string, string>>,
  baseDays: number = 20,
) {
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const calDays = new Date(ymY, ymM, 0).getDate()
  const legalLimit = Math.round(calDays * 40 / 7 * 10) / 10

  const titleRow = [`${titlePrefix} 勤怠サマリー ${ymLabel(ym)}（1か月単位の変形労働時間制）`]
  const headers = [
    '名前', '時間給',
    '所定労働時間', '所定労働日数',
    '実労働時間', '実労働日数',
    '所定外労働時間', '法定外労働時間',
    '(内訳)日単位', '(内訳)週単位', '(内訳)月単位',
    '法定休日労働時間', '所定休日労働時間',
    '基本給(固定)',
  ]
  const rows: (string | number)[][] = [titleRow, headers]

  for (const w of foreignWorkers) {
    const hr = w.hourlyRate || 0
    const summary = calculateOvertimeSummary(ym, w.id, hr, baseDays, attD, sites, calendarDays)

    rows.push([
      w.name,
      hr,
      summary.prescribedHours,
      summary.prescribedDays,
      summary.actualHours,
      summary.actualDays,
      summary.nonStatutoryOT,
      summary.statutoryOT,
      summary.dailyStatutoryOT,
      summary.weeklyStatutoryOT,
      summary.monthlyStatutoryOT,
      summary.legalHolidayHours,
      summary.prescribedHolidayHours,
      summary.fixedBasePay,
    ])
  }

  // 空行 + 説明
  rows.push([])
  rows.push(['【算出根拠】'])
  rows.push(['', `法定上限: ${calDays}日 × 40 ÷ 7 = ${legalLimit}h`])
  rows.push(['', '法定休日: 日曜日'])
  rows.push(['', `ベース日数: ${baseDays}日`])
  rows.push(['', `基本給(固定) = 時間給 × ${baseDays}日 × 7h`])
  rows.push([])
  rows.push(['【残業3段階判定】'])
  rows.push(['', '第1段階（日単位）: 所定8h以下の日は8hを超えた分、所定8h超の日はその所定を超えた分'])
  rows.push(['', '第2段階（週単位）: 所定40h以下の週は40hを超えた分（第1段階分を除く）'])
  rows.push(['', `第3段階（月単位）: 法定上限(${legalLimit}h)を超えた分（第1・2段階分を除く）`])
  rows.push(['', '法定外労働時間 = 第1段階 + 第2段階 + 第3段階'])
  rows.push(['', '所定外労働時間 = 所定時間を超えた全ての時間（法定内・法定外の両方を含む）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 13 } }]
  setColWidths(ws, [14, 8, 10, 10, 10, 10, 10, 10, 8, 8, 8, 10, 10, 12])
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
}

export function generateHibiAttendance(data: HibiAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // 退職月の在籍スタッフ（例: 6/30 退職予定）も当月分は集計対象に含める
  const hibiWorkers = workers.filter(w => (w.org === '日比' || w.org === 'hibi') && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym))

  // Header rows
  const headers = ['名前', '区分']
  for (let d = 1; d <= numDays; d++) {
    headers.push(dayLabel(ym, d))
  }
  headers.push('合計')

  const titleRow = [`日比建設 出面一覧 ${ymLabel(ym)}`]
  const rows: (string | number)[][] = [titleRow, headers]

  let totalWork = 0
  let totalOT = 0
  let totalPL = 0
  const dailyWorkTotals: number[] = new Array(numDays).fill(0)
  const dailyOTTotals: number[] = new Array(numDays).fill(0)

  for (const w of hibiWorkers) {
    const workRow: (string | number)[] = [w.name, '出勤']
    const otRow: (string | number)[] = ['', '残業h']

    let wWork = 0
    let wOT = 0
    let wPL = 0

    for (let d = 1; d <= numDays; d++) {
      const dd = String(d)
      let dayWork: string | number = ''
      let dayOT: number = 0
      let isPL = false

      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${dd}`
        const entry = attD[key]
        if (!entry) continue

        if (entry.p) {
          isPL = true
          break
        }
        // ⚠️ 2026-05-09: 残骸データ対策。休み/現場休/帰国中/試験 では実労働を計上しない
        if (!isWorkingDay(entry)) continue
        if (entry.w && entry.w > 0) {
          dayWork = entry.w // 1, 0.5, 0.6 をそのまま数値で表示
          if (entry.o && entry.o > 0) dayOT += entry.o
        }
      }

      if (isPL) {
        dayWork = '有'
        wPL += 1
      } else if (typeof dayWork === 'number' && dayWork > 0) {
        wWork += dayWork
      }

      if (typeof dayWork === 'number' && dayWork > 0) {
        dailyWorkTotals[d - 1] += dayWork
      }
      dailyOTTotals[d - 1] += dayOT

      wOT += dayOT
      workRow.push(dayWork || '')
      otRow.push(dayOT > 0 ? dayOT : '')
    }

    workRow.push(wWork > 0 ? Math.round(wWork * 10) / 10 : '')
    otRow.push(wOT > 0 ? Math.round(wOT * 10) / 10 : '')

    totalWork += wWork
    totalOT += wOT
    totalPL += wPL

    rows.push(workRow)
    rows.push(otRow)
  }

  // Footer: 日ごとの縦計
  const footerWork: (string | number)[] = ['合計', '出勤']
  const footerOT: (string | number)[] = ['', '残業h']
  for (let d = 0; d < numDays; d++) {
    footerWork.push(dailyWorkTotals[d] > 0 ? Math.round(dailyWorkTotals[d] * 10) / 10 : '')
    footerOT.push(dailyOTTotals[d] > 0 ? Math.round(dailyOTTotals[d] * 10) / 10 : '')
  }
  footerWork.push(Math.round(totalWork * 10) / 10)
  footerOT.push(Math.round(totalOT * 10) / 10)
  rows.push(footerWork)
  rows.push(footerOT)

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Merge title row
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 2 } }]

  // Column widths
  const colWidths = [14, 6]
  for (let d = 0; d < numDays; d++) colWidths.push(7)
  colWidths.push(6)
  setColWidths(ws, colWidths)

  XLSX.utils.book_append_sheet(wb, ws, '出面一覧')

  // ── Sheet 2: 勤務時間一覧（日比建設所属の外国人スタッフのみ） ──
  // 4月以前は1日6h40min、5月以降は1日7h で時間変換（appendTimeSheet 内で自動切替）
  const hibiForeignWorkers = hibiWorkers.filter(w => w.visa && w.visa !== 'none' && w.visa !== '')
  if (hibiForeignWorkers.length > 0 && data.calendarDays) {
    appendTimeSheet(wb, '勤務時間一覧', '日比建設', ym, hibiForeignWorkers, attD, sites, data.calendarDays)
    // ── Sheet 3: 勤怠サマリー（変形労働時間制専用、4月以前はスキップ） ──
    if (ym >= '202605') {
      const bd = (data as { baseDays?: number }).baseDays || 20
      // 2026-06-12 修正 (監査): 旧ルール継続者(フン等)は変形労働の3層計算対象外のため除外。
      //   含めると「基本給=時給×20日×7h」等、実際の給与（固定月給）と矛盾する行が社労士提出物に載る
      const newRuleWorkers = hibiForeignWorkers.filter(w => !(w as { useOldRules?: boolean }).useOldRules)
      if (newRuleWorkers.length > 0) {
        appendOvertimeSummarySheet(wb, '勤怠サマリー', '日比建設', ym, newRuleWorkers, attD, sites, data.calendarDays, bd)
      }
    }
  }

  return wb
}

// ────────────────────────────────────────
//  2. HFU向け出面一覧
// ────────────────────────────────────────

/**
 * HFU向け出面一覧（キャシュモ向け: 時間ベース変換付き）
 *
 * Sheet 1: 出面一覧（従来形式: 出勤1/残業h — 入力確認用）
 * Sheet 2: 勤務時間一覧（時間変換済み: 実労働h/所定h/週番号/法定上限 — 給与計算用）
 */
export interface HfuAttendanceExportData extends HibiAttendanceData {
  /** カレンダーの日ごとの種別（siteId → { "1": "work", "2": "off", ... }） */
  calendarDays?: Record<string, Record<string, string>>
  /** ベース日数（3層構造の基本給計算用、デフォルト20） */
  baseDays?: number
}

export function generateHfuAttendance(data: HfuAttendanceExportData): XLSX.WorkBook {
  const { ym, workers, attD, sites, calendarDays } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // 退職月の在籍スタッフも当月分は集計対象に含める
  const hfuWorkers = workers.filter(w => (w.org === 'HFU' || w.org === 'hfu') && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym))

  // ── Sheet 1: 従来形式（出面確認用） ──
  {
    const headers = ['名前', '区分']
    for (let d = 1; d <= numDays; d++) headers.push(dayLabel(ym, d))
    headers.push('合計')

    const titleRow = [`HFU 出面一覧 ${ymLabel(ym)}`]
    const rows: (string | number)[][] = [titleRow, headers]

    let totalWork = 0, totalOT = 0
    const dailyWorkTotals: number[] = new Array(numDays).fill(0)
    const dailyOTTotals: number[] = new Array(numDays).fill(0)

    for (const w of hfuWorkers) {
      const workRow: (string | number)[] = [w.name, '出勤']
      const otRow: (string | number)[] = ['', '残業h']
      let wWork = 0, wOT = 0

      for (let d = 1; d <= numDays; d++) {
        const dd = String(d)
        let dayWork: string | number = ''
        let dayOT = 0
        let isPL = false

        for (const site of sites) {
          const key = `${site.id}_${w.id}_${ym}_${dd}`
          const entry = attD[key]
          if (!entry) continue
          if (entry.p) { isPL = true; break }
          // ⚠️ 2026-05-09: 残骸データ対策
          if (!isWorkingDay(entry)) continue
          if (entry.w && entry.w > 0) {
            dayWork = entry.w
            if (entry.o && entry.o > 0) dayOT += entry.o
          }
        }

        if (isPL) { dayWork = '有' }
        else if (typeof dayWork === 'number' && dayWork > 0) { wWork += dayWork; dailyWorkTotals[d - 1] += dayWork }
        dailyOTTotals[d - 1] += dayOT; wOT += dayOT
        workRow.push(dayWork || ''); otRow.push(dayOT > 0 ? dayOT : '')
      }

      workRow.push(wWork > 0 ? Math.round(wWork * 10) / 10 : '')
      otRow.push(wOT > 0 ? Math.round(wOT * 10) / 10 : '')
      totalWork += wWork; totalOT += wOT
      rows.push(workRow); rows.push(otRow)
    }

    const footerWork: (string | number)[] = ['合計', '出勤']
    const footerOT: (string | number)[] = ['', '残業h']
    for (let d = 0; d < numDays; d++) {
      footerWork.push(dailyWorkTotals[d] > 0 ? Math.round(dailyWorkTotals[d] * 10) / 10 : '')
      footerOT.push(dailyOTTotals[d] > 0 ? Math.round(dailyOTTotals[d] * 10) / 10 : '')
    }
    footerWork.push(Math.round(totalWork * 10) / 10)
    footerOT.push(Math.round(totalOT * 10) / 10)
    rows.push(footerWork); rows.push(footerOT)

    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 2 } }]
    const colWidths = [14, 6]; for (let d = 0; d < numDays; d++) colWidths.push(7); colWidths.push(6)
    setColWidths(ws, colWidths)
    XLSX.utils.book_append_sheet(wb, ws, '出面一覧')
  }

  // ── Sheet 2: 勤務時間一覧（キャシュモ向け: 時間変換済み） ──
  // 4月以前は1日6h40min、5月以降は1日7h で時間変換（appendTimeSheet 内で自動切替）
  appendTimeSheet(wb, '勤務時間一覧', 'HFU', ym, hfuWorkers, attD, sites, calendarDays)

  // ── Sheet 3: 勤怠サマリー（キャシュモ向け: 3段階残業判定の結果） ──
  // ⚠️ このシートは「1か月単位の変形労働時間制」専用の3段階残業分析。
  //    4月以前（旧ルール）には適用されないため出力しない。
  //    旧ルール継続者(useOldRules)も対象外（2026-06-12 監査: 固定月給と矛盾する行が載るため除外）
  if (calendarDays && ym >= '202605') {
    const bd = (data as { baseDays?: number }).baseDays || 20
    const newRuleHfu = hfuWorkers.filter(w => !(w as { useOldRules?: boolean }).useOldRules)
    if (newRuleHfu.length > 0) {
      appendOvertimeSummarySheet(wb, '勤怠サマリー', 'HFU', ym, newRuleHfu, attD, sites, calendarDays, bd)
    }
  }

  return wb
}

// ────────────────────────────────────────
//  3. 外注先向け出面確認書
// ────────────────────────────────────────

export interface SubconConfirmationData {
  ym: string
  subcon: RawSubcon
  attSD: Record<string, { n: number; on: number }>
  sites: { id: string; name: string }[]
  /** 2026-06-12 (監査): 現場別の実効単価（getSubconRate の結果）。
   *  未指定なら基本単価で計算（後方互換）。指定すると金額が現場別単価で積算され、
   *  compute.ts の site.subCost / SubconMonthly.cost と一致する */
  siteRates?: Record<string, { rate: number; otRate: number }>
}

export function generateSubconConfirmation(data: SubconConfirmationData): XLSX.WorkBook {
  const { ym, subcon, attSD, sites, siteRates } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  const titleRow = [`外注先確認書 ${ymLabel(ym)}`]
  const infoRow = [`外注先: ${subcon.name}`, '', `区分: ${subcon.type}`]
  const headers = ['日付', '人数', '残業人数', '備考']

  const rows: (string | number)[][] = [titleRow, infoRow, [], headers]

  let totalN = 0
  let totalON = 0
  let totalAmount = 0
  let hasOverride = false

  const rateFor = (siteId: string) => {
    const ov = siteRates?.[siteId]
    if (ov && (ov.rate !== subcon.rate || ov.otRate !== subcon.otRate)) hasOverride = true
    return ov || { rate: subcon.rate, otRate: subcon.otRate }
  }

  for (let d = 1; d <= numDays; d++) {
    const dd = String(d)
    let dayN = 0
    let dayON = 0
    const siteNames: string[] = []

    for (const site of sites) {
      const key = `${site.id}_${subcon.id}_${ym}_${dd}`
      const entry = attSD[key]
      if (!entry) continue
      if (entry.n > 0) {
        dayN += entry.n
        dayON += entry.on || 0
        siteNames.push(site.name)
        const r = rateFor(site.id)
        totalAmount += entry.n * r.rate + (entry.on || 0) * r.otRate
      }
    }

    const sunSat = isSunday(ym, d) ? '(休)' : isSaturday(ym, d) ? '(土)' : ''
    const row: (string | number)[] = [
      `${dayLabel(ym, d)} ${sunSat}`.trim(),
      dayN || '',
      dayON || '',
      siteNames.join(', '),
    ]
    rows.push(row)

    totalN += dayN
    totalON += dayON
  }

  // Totals
  rows.push([])
  rows.push(['合計', totalN, totalON, ''])
  rows.push(['単価', `${subcon.rate.toLocaleString()}円`, `${subcon.otRate.toLocaleString()}円`, hasOverride ? '※現場別単価あり（金額は現場別単価で積算）' : ''])
  rows.push(['金額', `${totalAmount.toLocaleString()}円`, '', ''])

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Merge title
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
  ]

  setColWidths(ws, [14, 10, 10, 20])

  XLSX.utils.book_append_sheet(wb, ws, subcon.name.slice(0, 31))
  return wb
}

// ────────────────────────────────────────
//  4. 歩掛管理表
// ────────────────────────────────────────

export interface BukakeData {
  ym: string
  sites: SiteSummary[]
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  siteNames: Record<string, string>
  defaultRates: { tobiRate?: number; dokoRate?: number }
  rawSites: { id: string; name: string; tobiRate?: number; dokoRate?: number }[]
}

export function generateBukakeReport(data: BukakeData): XLSX.WorkBook {
  const { ym, sites, workers, subcons, siteNames, defaultRates, rawSites } = data
  const wb = XLSX.utils.book_new()

  const titleRow = [`歩掛管理表 ${ymLabel(ym)}`]
  const headers = [
    '現場名', '自社人工', '外注人工', '合計人工',
    '鳶単価', '土工単価', '自社原価', '外注原価',
    '合計原価', '請求額', '粗利', '粗利率',
  ]

  const rows: (string | number)[][] = [titleRow, headers]

  let tSelfDays = 0, tSubDays = 0, tSelfCost = 0, tSubCost = 0, tBilling = 0, tProfit = 0

  for (const site of sites) {
    const raw = rawSites.find(r => r.id === site.id)
    const tobiRate = raw?.tobiRate || defaultRates.tobiRate || 0
    const dokoRate = raw?.dokoRate || defaultRates.dokoRate || 0
    const totalDays = site.workDays + site.subWorkDays
    const totalCost = site.cost + site.subCost
    const profitRateStr = site.billing > 0 ? `${site.profitRate.toFixed(1)}%` : '-'

    rows.push([
      site.name,
      site.workDays,
      site.subWorkDays,
      totalDays,
      tobiRate,
      dokoRate,
      site.cost,
      site.subCost,
      totalCost,
      site.billing,
      site.profit,
      profitRateStr,
    ])

    tSelfDays += site.workDays
    tSubDays += site.subWorkDays
    tSelfCost += site.cost
    tSubCost += site.subCost
    tBilling += site.billing
    tProfit += site.profit
  }

  const totalProfitRate = tBilling > 0 ? `${((tProfit / tBilling) * 100).toFixed(1)}%` : '-'
  rows.push([
    '合計',
    tSelfDays,
    tSubDays,
    tSelfDays + tSubDays,
    '', '',
    tSelfCost,
    tSubCost,
    tSelfCost + tSubCost,
    tBilling,
    tProfit,
    totalProfitRate,
  ])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }]
  setColWidths(ws, [16, 8, 8, 8, 10, 10, 12, 12, 12, 12, 12, 8])

  XLSX.utils.book_append_sheet(wb, ws, '歩掛管理表')
  return wb
}

// ────────────────────────────────────────
//  5. 有給管理台帳
// ────────────────────────────────────────

export interface PLLedgerData {
  workers: RawWorker[]
  plData: Record<string, PLRecord[]>
  attData?: Record<string, Record<string, unknown>>
  org?: string // 'hibi' | 'hfu' | 'all'
}

export function generatePLLedger(data: PLLedgerData): XLSX.WorkBook {
  const { workers, plData, attData, org } = data
  const wb = XLSX.utils.book_new()

  // 会社フィルタ
  const orgFilter = org || 'all'
  const orgLabel = orgFilter === 'hfu' ? 'HFU' : orgFilter === 'hibi' ? '日比建設' : '全社'

  // ── シート1: 有給管理台帳（サマリー） ──
  const titleRow = [`年次有給休暇管理簿（${orgLabel}）`]
  const headers = [
    '名前', '所属', '入社日',
    '基準日（付与日）', '付与日数', '繰越日数',
    '取得日数', '残日数', '有効期限',
  ]

  const rows: (string | number)[][] = [titleRow, headers]
  // 2026-06-XX 修正: 「今日時点で退職済み」のみ除外。未来日退職予定者は ledger 管理対象
  const todayIso = todayJstIso()
  const activeWorkers = workers.filter(w => {
    if (isAlreadyRetired(w.retired, todayIso)) return false
    if (orgFilter === 'hibi') return w.org === 'hibi' || w.org === '日比'
    if (orgFilter === 'hfu') return w.org === 'hfu' || w.org === 'HFU'
    return true
  })

  // 出面データからPL取得日を集計
  const plDates: Record<number, string[]> = {} // workerId -> ['2025/04/15', ...]
  if (attData) {
    for (const [key, entry] of Object.entries(attData)) {
      if (!entry) continue
      const e = entry as { p?: number }
      if (e.p === 1) {
        const pk = parseDKey(key)
        const wid = parseInt(pk.wid)
        const dateStr = `${pk.ym.slice(0, 4)}/${pk.ym.slice(4, 6)}/${pk.day.padStart(2, '0')}`
        if (!plDates[wid]) plDates[wid] = []
        plDates[wid].push(dateStr)
      }
    }
    // 2026-06-12 修正 (監査): 同一日に複数現場で p:1 残骸がある場合の二重カウントを排除
    //   （generateLeaveLedger は computePeriodUsed で dedup 済み。本帳票への横展開）
    for (const wid of Object.keys(plDates)) {
      plDates[Number(wid)] = [...new Set(plDates[Number(wid)])].sort()
    }
  }

  // ⚠️ 2026-05-18 修正:
  //   今日が含まれる「アクティブなレコード」を選ぶ（未来年度のレコードを誤選択しないため）
  //   ※ 残日数は申請ベース（未来日付の p:1 も使用済みカウント）— 全画面・全帳票で統一
  const todayPL = new Date()
  todayPL.setHours(0, 0, 0, 0)

  for (const w of activeWorkers) {
    const records = (plData[String(w.id)] || []).filter(rec => !(rec as { _archived?: boolean })._archived)
    if (records.length === 0) {
      rows.push([w.name, w.org, w.hireDate || '', '-', 0, 0, 0, 0, '-'])
      continue
    }

    // 最新のアクティブレコードを選択（grantDate <= 今日 < grantDate+1y）
    const recordsWithGrant = records.filter(rec =>
      (rec.grantDays && rec.grantDays > 0) || (rec.grant && rec.grant > 0)
    )
    const activeRec = recordsWithGrant.find(rec => {
      if (!rec.grantDate) return false
      const gd = new Date(rec.grantDate)
      if (isNaN(gd.getTime())) return false
      const end = new Date(gd); end.setFullYear(end.getFullYear() + 1)
      return todayPL >= gd && todayPL < end
    })
    const r = activeRec
      ?? (recordsWithGrant.length > 0 ? recordsWithGrant[recordsWithGrant.length - 1] : records[records.length - 1])

    const grantDays = r.grantDays ?? r.grant ?? 0
    const carryOver = r.carryOver ?? r.carry ?? 0
    const adjustment = Math.max(r.adjustment ?? 0, r.adj ?? 0)
    const total = grantDays + carryOver

    // 出面からの取得日数（申請ベース：未来日付の p:1 も含む）
    let periodUsed = 0
    if (r.grantDate) {
      const gd = new Date(r.grantDate)
      const gdEnd = new Date(gd)
      gdEnd.setFullYear(gdEnd.getFullYear() + 1)
      const wDates = plDates[w.id] || []
      periodUsed = wDates.filter(d => {
        const pd = new Date(d.replace(/\//g, '-'))
        return pd >= gd && pd < gdEnd
      }).length
    }

    const used = adjustment + periodUsed
    const remaining = Math.max(0, total - used)

    // 有効期限
    let expiry = '-'
    if (r.grantDate) {
      const gd = new Date(r.grantDate)
      const exp = new Date(gd)
      exp.setFullYear(exp.getFullYear() + 2)
      exp.setDate(exp.getDate() - 1)
      expiry = `${exp.getFullYear()}/${String(exp.getMonth() + 1).padStart(2, '0')}/${String(exp.getDate()).padStart(2, '0')}`
    }

    rows.push([
      w.name, w.org, w.hireDate || '',
      r.grantDate || '-', grantDays, carryOver,
      used, remaining, expiry,
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }]
  setColWidths(ws, [14, 6, 12, 12, 8, 8, 8, 8, 12])
  XLSX.utils.book_append_sheet(wb, ws, '管理簿')

  // ── シート2: 取得日一覧 ──
  const dateHeaders = ['名前', '所属', '取得日']
  const dateRows: (string | number)[][] = [['取得日一覧'], dateHeaders]

  for (const w of activeWorkers) {
    const wDates = plDates[w.id] || []
    if (wDates.length === 0) continue
    for (let i = 0; i < wDates.length; i++) {
      dateRows.push([
        i === 0 ? w.name : '',
        i === 0 ? w.org : '',
        wDates[i],
      ])
    }
  }

  const ws2 = XLSX.utils.aoa_to_sheet(dateRows)
  ws2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]
  setColWidths(ws2, [14, 6, 12])
  XLSX.utils.book_append_sheet(wb, ws2, '取得日一覧')

  return wb
}

// ────────────────────────────────────────
//  6. 月次集計Excel
// ────────────────────────────────────────

export interface MonthlyExcelData {
  ym: string
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  siteNames: Record<string, string>
  prescribedDays: number
}

/**
 * 月次集計 Excel（2026-05-12 改訂: 1シート統合）
 *
 * 旧構成（〜2026-05-12）: Sheet 1「月次集計」+ Sheet 2「給与計算詳細」で
 *   ほぼ同じデータを2回出力していたため、列の食い違いが頻発していた。
 *
 * 新構成: 1シート、4ブロック構造で重複ゼロ。給与計算担当者が1枚で完結。
 *   ベトナム人と日本人で給与計算方式が根本的に違う（特に5月以降は3層構造化）ため、
 *   会社 × 雇用区分の組み合わせでブロックを分ける。
 *
 * 構成:
 *   【日比建設・ベトナム人】 [外国人テーブル（給与関連17列）]
 *   【日比建設・日本人】     [日本人テーブル（日額系8列）]
 *   【HFU・ベトナム人】      [外国人テーブル]
 *   【HFU・日本人】          [日本人テーブル]
 *   【協力業者】             [外注テーブル]
 *
 * 月による列名切替（同じフィールドだが意味が違うため）:
 *   4月以前（旧ルール）: 所定日数 / 所定時間(h) / 基本給     / 休業補償
 *   5月以降（新ルール）: ベース日数 / 法定上限(h) / 基本給(固定) / 追加所定手当
 */
export function generateMonthlyExcel(data: MonthlyExcelData): XLSX.WorkBook {
  const { ym, workers, subcons, siteNames, prescribedDays } = data
  const wb = XLSX.utils.book_new()

  // 2026-06-XX 全面リライト:
  //   旧: 1シート内に5ブロック縦並び
  //   新: タブ別シート構成（給与計算者の作業効率向上）
  //     - 日比建設・日本人
  //     - 日比建設・ベトナム人(新ルール)
  //     - 日比建設・ベトナム人(旧ルール)  ← フン (104) 等
  //     - HFU・ベトナム人(新ルール)
  //     - HFU・日本人 (該当者がいれば)
  //     - 協力業者(外注)
  //   加えて以下を同時修正:
  //     A. legalHolidayDays を compute.ts 出力 (w.legalHolidayDays) から取得
  //        （旧: actualWorkDays - regularWorkDays で独自計算 → 補償日があるとズレ）
  //     B. 所定日数列を workerPrescribedDays (スタッフ個別) で表示
  //        （旧: prescribedDays = UI入力の全社値で固定）
  //     C. validatePayrolls の検算結果を各シート末尾に追加

  const useNewRulesByMonth = ym >= '202605'
  const isWorkerOldRules = (w: WorkerMonthly): boolean => {
    if (!useNewRulesByMonth) return true  // 月全体が旧ルール
    return (w as { useOldRules?: boolean }).useOldRules === true
  }

  // 雇用区分 × 会社 でグルーピング
  const isHibi = (w: WorkerMonthly) => w.org === '日比' || w.org === 'hibi'
  const isHfu = (w: WorkerMonthly) => w.org === 'HFU' || w.org === 'hfu'
  const isForeign = (w: WorkerMonthly) => w.visa !== 'none'
  const isJapanese = (w: WorkerMonthly) => w.visa === 'none'

  // 外国人を新旧ルールに分割
  const hibiForeignNew = workers.filter(w => isHibi(w) && isForeign(w) && !isWorkerOldRules(w))
  const hibiForeignOld = workers.filter(w => isHibi(w) && isForeign(w) && isWorkerOldRules(w))
  const hibiJapanese = workers.filter(w => isHibi(w) && isJapanese(w))
  const hfuForeignNew = workers.filter(w => isHfu(w) && isForeign(w) && !isWorkerOldRules(w))
  const hfuForeignOld = workers.filter(w => isHfu(w) && isForeign(w) && isWorkerOldRules(w))
  const hfuJapanese = workers.filter(w => isHfu(w) && isJapanese(w))

  // ── 列定義 ──
  // 新ルール: 25列（法定休日日数 と 法定休日労働h を別列で持つ詳細版）
  const foreignHeadersNew = ['名前', '現場', '単価種別', '単価', '所定日数', '法定上限(h)',
    '通常出勤', '法休出勤', '補償日', '有給日数',
    '実労働h', '所定外労働h', '法定残業h', '法休労働h', '深夜労働h',
    '基本給(固定)', '追加所定手当', '有給日給', '所定外労働手当', '法定外残業手当', '法定休日手当', '深夜手当', '休業手当',
    '欠勤日数', '欠勤控除', '支給額合計']
  // 旧ルール: 18列（補償日控除を欠勤控除と分離）
  const foreignHeadersOld = ['名前', '現場', '単価種別', '単価', '所定日数', '所定時間(h)',
    '実出勤日数', '補償日', '有給日数', '実労働時間', '残業時間',
    '基本給', '休業補償', '残業手当', '欠勤日数', '欠勤控除', '補償日控除', '支給額合計']
  // 日本人: 8列
  const japaneseHeaders = ['名前', '現場', '雇用形態', '日額/月給', '出勤日数', '有給日数', '残業時間(h)', '基本給', '有給手当', '残業手当', '支給額合計']

  // ── 検算結果のシート末尾追加（共通ヘルパー） ──
  function appendValidation(rows: (string | number | null)[][], targets: WorkerMonthly[], colCount: number) {
    // 検算対象は新ルール外国人のみ (validatePayroll の内部で判定)
    const snapshots = targets as unknown as PayrollSnapshot[]
    const result = validatePayrolls(snapshots)
    rows.push([])
    const headerCell: (string | number | null)[] = [
      result.total === 0
        ? '✓ 自動検算: 全項目 OK（法定外残業 0.25倍 / 所定外労働 / 法休 1.35倍 / 深夜 0.25倍 / 休業 60%）'
        : `⚠ 自動検算: ${result.affectedWorkerIds.length}名で${result.total}件の違反検出（critical ${result.critical} / warning ${result.warning}）`
    ]
    for (let i = 1; i < colCount; i++) headerCell.push(null)
    rows.push(headerCell)
    if (result.total > 0) {
      for (const iss of result.issues) {
        const expected = iss.expected !== undefined ? `想定 ¥${iss.expected.toLocaleString()}` : ''
        const actual = iss.actual !== undefined ? `/ 実額 ¥${iss.actual.toLocaleString()}` : ''
        const detail = [`[${iss.severity}]`, iss.workerName, ':', iss.message, expected, actual].filter(Boolean).join(' ')
        const row: (string | number | null)[] = [detail]
        for (let i = 1; i < colCount; i++) row.push(null)
        rows.push(row)
      }
    }
  }

  // ── 外国人シート生成 ──
  function buildForeignSheet(sheetName: string, ws: WorkerMonthly[], forceOldRules: boolean): XLSX.WorkSheet | null {
    if (ws.length === 0) return null
    const useNewRules = !forceOldRules
    const headers = useNewRules ? foreignHeadersNew : foreignHeadersOld
    const rows: (string | number | null)[][] = []
    // タイトル
    const ruleTag = useNewRules ? '新ルール' : '旧ルール'
    rows.push([`${sheetName}（${ruleTag}） ${ymLabel(ym)}`])
    rows.push([])
    rows.push(headers)
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      // 2026-06-12 修正 (監査): salary を優先（フン等の固定月給者は salary が計算の正。
      //   旧: hourlyRate 優先のため、計算に使われない旧時給が単価列に出ていた）
      const rateKind = w.salary ? '月給' : (w.hourlyRate ? '時給' : '—')
      const rateValue = w.salary || w.hourlyRate || 0
      // 2026-06-XX 修正B: スタッフ個別の所定日数を使用（旧: 全社の prescribedDays 固定）
      const workerDays = w.workerPrescribedDays ?? prescribedDays
      const limitOrPrescribedH = useNewRules ? (w.legalLimit || 0) : (w.prescribedHours || 0)
      if (useNewRules) {
        // 2026-06-XX 修正A: legalHolidayDays を compute.ts の値から直接取得
        //   旧: const legalHolidayDays = (w.actualWorkDays || 0) - (w.regularWorkDays || 0)
        //       → 補償日(w=0.6)がある場合に不正確
        //   新: w.legalHolidayDays (calculateVietnameseSalary で計算済み)
        const legalHolidayDays = w.legalHolidayDays ?? 0
        const wext = w as WorkerMonthly & { nonStatutoryOTHours?: number; nonStatutoryOTAllowance?: number }
        rows.push([
          nameWithDispatch, siteList, rateKind, rateValue, workerDays, limitOrPrescribedH,
          w.regularWorkDays || 0, legalHolidayDays, w.compDays || 0, w.plDays || 0,
          w.actualWorkHours || 0, wext.nonStatutoryOTHours || 0, w.legalOtHours || 0,
          w.legalHolidayHours || 0, w.nightHours || 0,
          w.fixedBasePay || w.basePay || 0, w.additionalAllowance || 0, w.paidLeaveAllowance || 0,
          wext.nonStatutoryOTAllowance || 0, w.otAllowance || 0,
          w.legalHolidayAllowance || 0, w.nightAllowance || 0, w.compAllowance || 0,
          w.absence || 0, w.absentDeduction || 0, w.salaryNetPay || 0,
        ])
      } else {
        rows.push([
          nameWithDispatch, siteList, rateKind, rateValue, workerDays, limitOrPrescribedH,
          w.actualWorkDays || 0, w.compDays || 0, w.plDays || 0,
          w.actualWorkHours || 0, w.legalOtHours || 0,
          w.fixedBasePay || w.basePay || 0,
          w.additionalAllowance || 0,  // 旧ルールでは休業補償（会社都合休の60%還元分）
          w.otAllowance || 0,
          w.absence || 0, w.absentDeduction || 0,
          w.compBaseDeduction || 0,    // 補償日控除（会社都合休の通常分・固定給は満額前提のため一旦控除）
          w.salaryNetPay || 0,
        ])
      }
    }
    // 小計
    if (useNewRules) {
      const wsExt = ws as (WorkerMonthly & { nonStatutoryOTHours?: number; nonStatutoryOTAllowance?: number })[]
      rows.push([
        '小計', null, null, null, null, null,
        ws.reduce((s, w) => s + (w.regularWorkDays || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayDays || 0), 0),
        ws.reduce((s, w) => s + (w.compDays || 0), 0),
        ws.reduce((s, w) => s + w.plDays, 0),
        null,
        wsExt.reduce((s, w) => s + (w.nonStatutoryOTHours || 0), 0),
        ws.reduce((s, w) => s + (w.legalOtHours || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayHours || 0), 0),
        ws.reduce((s, w) => s + (w.nightHours || 0), 0),
        ws.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
        ws.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.paidLeaveAllowance || 0), 0),
        wsExt.reduce((s, w) => s + (w.nonStatutoryOTAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.nightAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.compAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.absence || 0), 0),
        ws.reduce((s, w) => s + (w.absentDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
      ])
    } else {
      rows.push([
        '小計', null, null, null, null, null,
        ws.reduce((s, w) => s + (w.actualWorkDays || 0), 0),
        ws.reduce((s, w) => s + (w.compDays || 0), 0),
        ws.reduce((s, w) => s + w.plDays, 0),
        null,
        ws.reduce((s, w) => s + (w.legalOtHours || 0), 0),
        ws.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
        ws.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.absence || 0), 0),
        ws.reduce((s, w) => s + (w.absentDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.compBaseDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
      ])
    }
    // 2026-06-XX 追加C: 自動検算結果（新ルール対象スタッフのみチェック）
    if (useNewRules) appendValidation(rows, ws, headers.length)
    // ── シート生成 ──
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }]
    if (useNewRules) {
      // 2026-06-12 修正 (監査): 26列に対し25要素で列幅が1列ずつズレていたのを修正
      setColWidths(sheet, [
        14, 14, 8, 10, 10, 10,
        8, 8, 8, 8,
        9, 10, 9, 9, 9,
        11, 11, 11, 12, 12, 11, 10, 10,
        8, 11, 14,
      ])
    } else {
      setColWidths(sheet, [14, 16, 8, 10, 10, 10, 10, 8, 8, 10, 10, 12, 12, 10, 8, 12, 12, 14])
    }
    return sheet
  }

  // ── 日本人シート生成 ──
  function buildJapaneseSheet(sheetName: string, ws: WorkerMonthly[]): XLSX.WorkSheet | null {
    if (ws.length === 0) return null
    const rows: (string | number | null)[][] = []
    rows.push([`${sheetName} ${ymLabel(ym)}`])
    rows.push([])
    rows.push(japaneseHeaders)
    let hasFullMonthly = false
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      const isFullMonthly = (w.salary || 0) > 0
      if (isFullMonthly) hasFullMonthly = true
      rows.push([
        nameWithDispatch, siteList,
        isFullMonthly ? '完全月給' : '日給月給',
        isFullMonthly ? (w.salary || 0) : w.rate,
        w.workDays,
        w.plDays || 0,
        w.dailyOtHours || w.otHours || 0,
        w.basePay || 0, w.paidLeaveAllowance || 0, w.otAllowance || 0, w.salaryNetPay || 0,
      ])
    }
    rows.push([
      '小計', null, null, null,
      ws.reduce((s, w) => s + w.workDays, 0),
      ws.reduce((s, w) => s + (w.plDays || 0), 0),
      ws.reduce((s, w) => s + (w.dailyOtHours || w.otHours || 0), 0),
      ws.reduce((s, w) => s + (w.basePay || 0), 0),
      ws.reduce((s, w) => s + (w.paidLeaveAllowance || 0), 0),
      ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
      ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])
    if (hasFullMonthly) {
      rows.push([])
      rows.push(['※ 完全月給者は出勤日数に関わらず基本給（=月給）を固定支給。「日額/月給」列は月給額。'])
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    const merges: XLSX.Range[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: japaneseHeaders.length - 1 } }]
    if (hasFullMonthly) {
      const noteRow = rows.length - 1
      merges.push({ s: { r: noteRow, c: 0 }, e: { r: noteRow, c: japaneseHeaders.length - 1 } })
    }
    sheet['!merges'] = merges
    setColWidths(sheet, [14, 16, 10, 12, 8, 8, 10, 12, 12, 12, 14])
    return sheet
  }

  // ── 協力業者シート生成 ──
  function buildSubconSheet(): XLSX.WorkSheet | null {
    if (subcons.length === 0) return null
    const rows: (string | number | null)[][] = []
    const headers = ['外注先', '区分', '現場', '人工', '残業', '単価', '金額']
    rows.push([`協力業者（外注） ${ymLabel(ym)}`])
    rows.push([])
    rows.push(headers)
    for (const sc of subcons) {
      const siteList = sc.sites.map(sid => siteNames[sid] || sid).join(', ')
      rows.push([sc.name, sc.type, siteList, sc.workDays, sc.otCount, sc.rate, sc.cost])
    }
    rows.push([
      '小計', null, null,
      subcons.reduce((s, sc) => s + sc.workDays, 0),
      subcons.reduce((s, sc) => s + sc.otCount, 0),
      null,
      subcons.reduce((s, sc) => s + sc.cost, 0),
    ])
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }]
    setColWidths(sheet, [18, 8, 18, 8, 8, 10, 14])
    return sheet
  }

  // ── シート登録（順序固定: 日比 → HFU → 外注） ──
  // Excel のシートタブには 31文字制限あり。日本語短めなら問題なし
  const sheetDefs: { name: string; sheet: XLSX.WorkSheet | null }[] = [
    { name: '日比建設・日本人', sheet: buildJapaneseSheet('日比建設・日本人', hibiJapanese) },
    { name: '日比建設・ベトナム人', sheet: buildForeignSheet('日比建設・ベトナム人', hibiForeignNew, false) },
    { name: '日比建設・ベトナム人(旧)', sheet: buildForeignSheet('日比建設・ベトナム人', hibiForeignOld, true) },
    { name: 'HFU・日本人', sheet: buildJapaneseSheet('HFU・日本人', hfuJapanese) },
    { name: 'HFU・ベトナム人', sheet: buildForeignSheet('HFU・ベトナム人', hfuForeignNew, false) },
    { name: 'HFU・ベトナム人(旧)', sheet: buildForeignSheet('HFU・ベトナム人', hfuForeignOld, true) },
    { name: '協力業者', sheet: buildSubconSheet() },
  ]
  for (const d of sheetDefs) {
    if (d.sheet) XLSX.utils.book_append_sheet(wb, d.sheet, d.name)
  }

  // フォールバック: 1シートも作られていない場合は空のサマリーシートを追加
  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`月次集計 ${ymLabel(ym)} — 該当データなし`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '月次集計')
  }
  return wb
}

// ────────────────────────────────────────
//  現場別出面一覧
// ────────────────────────────────────────

export interface PerSiteAttendanceData {
  ym: string
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  sites: { id: string; name: string; archived?: boolean }[]
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
}

export function generatePerSiteAttendance(data: PerSiteAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // 日付ヘッダー
  const dayHeaders: string[] = []
  for (let d = 1; d <= numDays; d++) {
    dayHeaders.push(dayLabel(ym, d))
  }

  // ワーカーマップ
  const workerMap = new Map(workers.map(w => [w.id, w]))

  // 各現場の出勤データを集計
  const siteWorkerData = new Map<string, Set<number>>()
  for (const key of Object.keys(attD)) {
    const pk = parseDKey(key)
    if (!pk || pk.ym !== ym) continue
    const entry = attD[key]
    if (!entry) continue
    if (!siteWorkerData.has(pk.sid)) siteWorkerData.set(pk.sid, new Set())
    siteWorkerData.get(pk.sid)!.add(Number(pk.wid))
  }

  // アクティブな現場のみ（出勤データがある現場のみシートを生成）
  const activeSites = sites.filter(s => siteWorkerData.has(s.id))

  for (const site of activeSites) {
    const siteWorkerIds = siteWorkerData.get(site.id) || new Set()

    // 日比建設ワーカーとHFUワーカーに分ける（退職月の在籍スタッフは含める）
    const hibiWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym) && (w.org === '日比' || w.org === 'hibi'))
    const hfuWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym) && (w.org === 'HFU' || w.org === 'hfu'))

    if (hibiWorkers.length === 0 && hfuWorkers.length === 0) continue

    const rows: (string | number)[][] = []

    // タイトル行
    rows.push([`${site.name}　出面一覧　${ymLabel(ym)}`])

    // セクション出力関数
    const appendSection = (sectionLabel: string, sectionWorkers: RawWorker[]) => {
      if (sectionWorkers.length === 0) return

      // 空行 + セクション見出し
      rows.push([])
      rows.push([`【${sectionLabel}】${sectionWorkers.length}名`])

      // ヘッダー
      const headerRow = ['名前', '区分', ...dayHeaders, '合計']
      rows.push(headerRow)

      let secWork = 0
      let secOT = 0
      const secDailyWork: number[] = new Array(numDays).fill(0)
      const secDailyOT: number[] = new Array(numDays).fill(0)

      for (const w of sectionWorkers) {
        const workRow: (string | number)[] = [w.name, '出勤']
        const otRow: (string | number)[] = ['', '残業h']

        let wWork = 0
        let wOT = 0

        for (let d = 1; d <= numDays; d++) {
          const dd = String(d)
          const key = `${site.id}_${w.id}_${ym}_${dd}`
          const entry = attD[key]

          let dayWork: string | number = ''
          let dayOT = 0

          if (entry) {
            if (entry.p) {
              dayWork = '有'
              // 有給日は残業を計上しない（旧コードは entry.o があれば加算していたバグ）
            } else if (isWorkingDay(entry) && entry.w && entry.w > 0) {
              // ⚠️ 2026-05-09: 残骸データ対策。isWorkingDay で休み/現場休/帰国中/試験 を除外
              dayWork = entry.w
              wWork += entry.w
              secDailyWork[d - 1] += entry.w
              if (entry.o && entry.o > 0) {
                dayOT = entry.o
                wOT += dayOT
                secDailyOT[d - 1] += dayOT
              }
            }
          }

          workRow.push(dayWork || '')
          otRow.push(dayOT > 0 ? dayOT : '')
        }

        workRow.push(wWork > 0 ? Math.round(wWork * 10) / 10 : '')
        otRow.push(wOT > 0 ? Math.round(wOT * 10) / 10 : '')

        secWork += wWork
        secOT += wOT

        rows.push(workRow)
        rows.push(otRow)
      }

      // セクション小計
      const footerWork: (string | number)[] = ['小計', '出勤']
      const footerOT: (string | number)[] = ['', '残業h']
      for (let d = 0; d < numDays; d++) {
        footerWork.push(secDailyWork[d] > 0 ? Math.round(secDailyWork[d] * 10) / 10 : '')
        footerOT.push(secDailyOT[d] > 0 ? Math.round(secDailyOT[d] * 10) / 10 : '')
      }
      footerWork.push(Math.round(secWork * 10) / 10)
      footerOT.push(Math.round(secOT * 10) / 10)
      rows.push(footerWork)
      rows.push(footerOT)
    }

    appendSection('日比建設', hibiWorkers)
    appendSection('HFU', hfuWorkers)

    const ws = XLSX.utils.aoa_to_sheet(rows)

    // タイトル行マージ
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 2 } }]

    // 列幅
    const colWidths = [14, 6]
    for (let d = 0; d < numDays; d++) colWidths.push(7)
    colWidths.push(6)
    setColWidths(ws, colWidths)

    // シート名（31文字制限）
    const sheetName = site.name.slice(0, 31)
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }

  return wb
}

// ────────────────────────────────────────
//  Workbook → Buffer
// ────────────────────────────────────────

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
}

export function generateLeaveLedger(data: LeaveLedgerData): XLSX.WorkBook {
  const { workers, plData, allAtt } = data
  const wb = XLSX.utils.book_new()

  const fmtDate = (iso?: string): string => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  }

  const fmtExpiry = (grantDate?: string): string => {
    if (!grantDate) return ''
    const gd = new Date(grantDate)
    if (isNaN(gd.getTime())) return ''
    // 2026-06-XX 修正 (MI-7): calcExpiryIso で正確な+2年計算（うるう年対応）
    //   旧: setFullYear(+2) は 2024-02-29 → 2026-02-28 になるが、
    //       内部的に setDate(-1) で 2026-02-27 になる微妙なズレあり
    //   新: addMonthsSafe(grantDate, 24) で常に同じ日付（応当日無ければ末日）
    const expIso = calcExpiryIso(grantDate)
    return fmtDate(expIso + 'T00:00:00Z')
  }

  // periodUsed 計算（grantDate..+1年 のPエントリ、申請ベース）
  // 2026-06-XX 修正 (IM-6): 共通ヘルパー computePeriodUsed に統一
  //   - multi-site dedup を内蔵（旧実装は dup count バグあり）
  //   - 残日数表示は申請ベース (requestedPeriodUsed) を採用
  const countPeriodUsed = (workerId: number, grantDate?: string): number => {
    if (!grantDate) return 0
    const result = computePeriodUsed(workerId, grantDate, allAtt as Record<string, unknown>)
    return result.requestedPeriodUsed  // 残日数計算は申請ベース
  }

  // ─── シート1: 管理簿 ───
  const ledgerRows: unknown[][] = []
  ledgerRows.push(['有給休暇管理簿'])
  ledgerRows.push([`作成日: ${fmtDate(new Date().toISOString())}`])
  ledgerRows.push([])
  ledgerRows.push([
    'ID', '氏名', '区分', 'ビザ', '入社日',
    'FY', '基準日(付与日)', '付与日数', '繰越日数', '調整',
    '取得日数', '残日数', '失効日数', '買取日数',
    '有効期限', 'ステータス', '付与方法',
  ])

  const visaLabel = (v: string): string => {
    if (!v || v === 'none') return '日本人'
    if (v === 'jisshu1') return '実習1号'
    if (v === 'jisshu2') return '実習2号'
    if (v === 'tokutei1') return '特定1号'
    if (v === 'tokutei2') return '特定2号'
    return v
  }

  const methodLabel = (m?: string): string => {
    if (!m) return ''
    if (m === 'manual') return '手動'
    if (m === 'auto-pending') return '半自動'
    if (m === 'migration') return 'マイグレ'
    if (m === 'legacy') return '旧データ'
    return m
  }

  // 2026-06-XX 修正: PL ledger は「今日時点で退職済み」のみ除外
  //   未来日退職予定者は5日義務監視対象として ledger に必要
  const todayIsoForLedger = todayJstIso()
  for (const w of workers) {
    if (isAlreadyRetired(w.retired, todayIsoForLedger)) continue
    const records = plData[String(w.id)] || []
    // 付与日でソート
    const sorted = records.slice().sort((a, b) => {
      const da = a.grantDate ? new Date(a.grantDate).getTime() : 0
      const db = b.grantDate ? new Date(b.grantDate).getTime() : 0
      return da - db
    })
    for (const r of sorted) {
      const periodUsed = countPeriodUsed(w.id, r.grantDate)
      const grantDays = r.grantDays ?? 0
      const carryOver = r.carryOver ?? 0
      const adjustment = r.adjustment ?? 0
      const used = adjustment + periodUsed
      const remaining = Math.max(0, grantDays + carryOver - used)
      // 2026-06-12 修正 (監査): 期限判定を 2×365日近似 → calcExpiryIso（うるう年対応）に統一。
      //   有効期限列(fmtExpiry)と判定基準がズレて境界日で「期限切れ/有効」が矛盾していた
      const expiredByDate = !!(r.grantDate && calcExpiryIso(r.grantDate) < todayJstIso())
      const status = r._archived ? 'アーカイブ' : (r.expiredAt ? '失効済' : (expiredByDate ? '期限切れ' : '有効'))
      ledgerRows.push([
        w.id, w.name, w.org || '', visaLabel(w.visa), w.hireDate || '',
        String(r.fy ?? ''), r.grantDate || '', grantDays, carryOver, adjustment,
        used, remaining, r.expiredDays ?? '', r.buyoutDays ?? '',
        fmtExpiry(r.grantDate), status, methodLabel(r.method),
      ])
    }
  }

  const ws1 = XLSX.utils.aoa_to_sheet(ledgerRows)
  setColWidths(ws1, [5, 14, 6, 8, 11, 6, 12, 8, 8, 6, 8, 7, 8, 8, 12, 10, 8])
  XLSX.utils.book_append_sheet(wb, ws1, '管理簿')

  // ─── シート2: 取得日一覧 ───
  const consumptionRows: unknown[][] = []
  consumptionRows.push(['有給取得日一覧'])
  consumptionRows.push([`作成日: ${fmtDate(new Date().toISOString())}`])
  consumptionRows.push([])
  consumptionRows.push(['ID', '氏名', '取得日', 'ビザ', '備考'])

  type Entry = { workerId: number; name: string; visa: string; date: string; note: string }
  const entries: Entry[] = []
  for (const [key, entry] of Object.entries(allAtt)) {
    if (!entry) continue
    const e = entry as { p?: number | boolean }
    if (!e.p) continue
    const pk = parseDKey(key)
    const wid = parseInt(pk.wid)
    const w = workers.find(x => x.id === wid)
    if (!w) continue
    const dateStr = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`

    // designatedLeaves に該当するか判定
    let note = ''
    for (const r of (plData[String(wid)] || [])) {
      const designated = r.designatedLeaves || []
      const found = designated.find(d => d.date === dateStr)
      if (found) {
        note = `時季指定${found.note ? `: ${found.note}` : ''}`
        break
      }
    }
    entries.push({ workerId: wid, name: w.name, visa: w.visa, date: dateStr, note })
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.workerId - b.workerId)
  for (const e of entries) {
    consumptionRows.push([e.workerId, e.name, e.date, visaLabel(e.visa), e.note])
  }

  const ws2 = XLSX.utils.aoa_to_sheet(consumptionRows)
  setColWidths(ws2, [5, 14, 12, 8, 20])
  XLSX.utils.book_append_sheet(wb, ws2, '取得日一覧')

  // ─── シート3: 買取記録 ───
  const buyoutRows: unknown[][] = []
  buyoutRows.push(['有給買取記録'])
  buyoutRows.push([`作成日: ${fmtDate(new Date().toISOString())}`])
  buyoutRows.push([])
  buyoutRows.push(['ID', '氏名', 'FY', '買取日', '日数', '金額(¥)', '理由'])

  for (const w of workers) {
    const records = plData[String(w.id)] || []
    for (const r of records) {
      const history = r.buyoutHistory || []
      for (const h of history) {
        const reasonLabel = h.reason === 'year-end' ? '期末買取' : h.reason === 'retirement' ? '退職時清算' : h.reason || ''
        buyoutRows.push([
          w.id, w.name, String(r.fy ?? ''), fmtDate(h.at),
          h.days, h.amount ?? '', reasonLabel,
        ])
      }
    }
  }

  const ws3 = XLSX.utils.aoa_to_sheet(buyoutRows)
  setColWidths(ws3, [5, 14, 6, 12, 6, 10, 14])
  XLSX.utils.book_append_sheet(wb, ws3, '買取記録')

  // ─── シート4: 時季指定記録 ───
  const designRows: unknown[][] = []
  designRows.push(['時季指定記録 (年5日取得義務対応)'])
  designRows.push([`作成日: ${fmtDate(new Date().toISOString())}`])
  designRows.push([])
  designRows.push(['ID', '氏名', 'FY', '指定日', '指定日時', '備考'])

  for (const w of workers) {
    const records = plData[String(w.id)] || []
    for (const r of records) {
      const designated = r.designatedLeaves || []
      for (const d of designated) {
        designRows.push([
          w.id, w.name, String(r.fy ?? ''), d.date, '', d.note || '',
        ])
      }
    }
  }

  const ws4 = XLSX.utils.aoa_to_sheet(designRows)
  setColWidths(ws4, [5, 14, 6, 12, 20, 20])
  XLSX.utils.book_append_sheet(wb, ws4, '時季指定')

  return wb
}

// ────────────────────────────────────────
//  社労士提出用: 勤務予定シフト表 / 実労働時間明細 (2026-06-XX 追加)
//
//  変形労働時間制（1ヶ月単位）の遵守を社労士が確認するための法定保存書類。
//  - 勤務予定シフト: 月の労働日と所定時間の事前計画
//  - 実労働時間明細: 実際の始業・終業・残業の記録
//
//  どちらもベトナム人スタッフ(変形労働制対象者)のみ対象、スタッフ1名1シート。
// ────────────────────────────────────────

interface ShiftCalendarDay {
  /** 'work' | 'off' | 'holiday' (DayType) */
  type: string
}

export interface PlannedShiftData {
  ym: string  // YYYYMM
  workers: RawWorker[]  // 全ワーカー（フィルタは関数内で実施）
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
  sites: { id: string; name: string; archived?: boolean; workSchedule?: SiteWorkSchedule }[]
  /** siteId -> days map (key='1'..'31', value DayType). siteCalendar から取得 */
  siteCalendars: Record<string, Record<string, ShiftCalendarDay | string>>
  /** 2026-06-XX 追加: 会社別フィルタ (社労士が会社ごとに違うため) */
  org?: 'hibi' | 'hfu' | 'all'
}

interface SiteWorkSchedule {
  startTime?: string
  endTime?: string
  morningBreak?: { enabled?: boolean; minutes?: number }
  lunchBreak?: { enabled?: boolean; minutes?: number }
  afternoonBreak?: { enabled?: boolean; minutes?: number }
}

/**
 * workSchedule から「始業/終業/休憩(分)/所定労働時間(h)」を計算
 */
function computePrescribedFromSchedule(ws: SiteWorkSchedule | undefined): {
  start: string
  end: string
  breakMin: number
  workH: number
} {
  if (!ws?.startTime || !ws?.endTime) {
    // 標準値（システムデフォルト 8:00-17:00, 休憩 2h, 7h）
    return { start: '08:00', end: '17:00', breakMin: 120, workH: 7.0 }
  }
  const [sh, sm] = ws.startTime.split(':').map(Number)
  const [eh, em] = ws.endTime.split(':').map(Number)
  const startMin = sh * 60 + (sm || 0)
  const endMin = eh * 60 + (em || 0)
  let totalMin = endMin - startMin
  let breakMin = 0
  if (ws.morningBreak?.enabled !== false) breakMin += ws.morningBreak?.minutes ?? 30
  if (ws.lunchBreak?.enabled !== false) breakMin += ws.lunchBreak?.minutes ?? 60
  if (ws.afternoonBreak?.enabled !== false) breakMin += ws.afternoonBreak?.minutes ?? 30
  totalMin -= breakMin
  return {
    start: ws.startTime,
    end: ws.endTime,
    breakMin,
    workH: Math.max(0, Math.round(totalMin / 60 * 10) / 10),
  }
}

/**
 * 1スタッフの月の配置先（assign + massign）から主要現場を判定
 */
function inferPrimarySiteId(workerId: number, ym: string, assign: PlannedShiftData['assign'], massign: PlannedShiftData['massign']): string | null {
  // 2026-06-XX 修正 (社労士監査): massign のキー形式は `${siteId}_${ym}` (例: ihi_202605)
  //   旧バグ: massign[ym] (例: massign['202605']) を参照 → 常に undefined → 月次配置替えが効かず
  //           デフォルト assign にフォールバックし、別現場のカレンダーを表示していた
  //   新: 全現場について massign[`${siteId}_${ym}`] を走査し、当月配置現場を特定。
  //       月次オーバーライドがあればそれを優先、なければデフォルト assign。
  const allSiteIds = new Set<string>([
    ...Object.keys(assign),
    ...Object.keys(massign).map(k => k.replace(new RegExp(`_${ym}$`), '')).filter(k => massign[`${k}_${ym}`]),
  ])

  // 月次オーバーライド (massign) を優先
  for (const sid of allSiteIds) {
    const mOver = massign[`${sid}_${ym}`]
    if (mOver?.workers?.includes(workerId)) return sid
  }
  // デフォルト assign にフォールバック
  for (const [sid, sa] of Object.entries(assign)) {
    if (sa.workers?.includes(workerId)) return sid
  }
  return null
}

/**
 * #1: 勤務予定シフト表 Excel を生成
 */
export function generatePlannedShiftExcel(data: PlannedShiftData): XLSX.WorkBook {
  const { ym, workers, assign, massign, sites, siteCalendars, org } = data
  const wb = XLSX.utils.book_new()

  // 対象: ベトナム人スタッフ + 当月在籍 + (org フィルタ指定があれば該当会社のみ)
  // 2026-06-12 修正 (監査): isHiredByMonth を追加（入社前月のスタッフが社労士提出書類に載る横展開漏れ）
  const foreignWorkers = workers.filter(w => {
    if (!(w.visa && w.visa !== 'none' && w.visa !== '')) return false
    if (!isStillActiveForMonth(w.retired, ym)) return false
    if (!isHiredByMonth(w.hireDate, ym)) return false
    if (org === 'hibi' && w.org !== 'hibi') return false
    if (org === 'hfu' && w.org !== 'hfu') return false
    return true
  })

  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const legalLimit = Math.round((daysInMonth * 40 / 7) * 10) / 10

  for (const w of foreignWorkers) {
    const siteId = inferPrimarySiteId(w.id, ym, assign, massign)
    const site = siteId ? sites.find(s => s.id === siteId) : undefined
    const schedule = computePrescribedFromSchedule(site?.workSchedule)
    const dayMap = siteId ? (siteCalendars[siteId] || {}) : {}

    // 月曜起算の週番号（変形労働の週所定を示すため）
    const firstDow = new Date(y, m - 1, 1).getDay()
    const firstMondayOffset = (firstDow + 6) % 7
    const weekOf = (d: number) => Math.floor((d - 1 + firstMondayOffset) / 7) + 1

    const rows: unknown[][] = []
    // ヘッダー
    rows.push([`勤務予定シフト表 ${ymLabel(ym)} - ${w.name}`])
    rows.push([`スタッフ ID: ${w.id}  /  雇用区分: ${w.visa}`])
    rows.push([`配置現場: ${site?.name || '未確定'}`])
    rows.push([`勤務時間 (標準): ${schedule.start}-${schedule.end} / 休憩 ${schedule.breakMin}分 / 所定 ${schedule.workH}h`])
    rows.push([`制度: 1ヶ月単位の変形労働時間制 / 月の所定総枠 ${legalLimit}h (暦日数${daysInMonth}÷7×40)`])
    rows.push([])
    rows.push(['週', '日', '曜', '予定', '始業', '終業', '休憩(分)', '所定労働時間(h)', '備考'])

    let totalWork = 0
    let totalH = 0
    // 週別所定: weekNum -> { days, hours }
    const weekly: Record<number, { days: number; hours: number }> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay()
      const dowLabel = ['日', '月', '火', '水', '木', '金', '土'][dow]
      const wn = weekOf(d)
      const dayEntry = dayMap[String(d)]
      // dayEntry が文字列 ('work'/'off'/'holiday') or オブジェクト
      const dayType = typeof dayEntry === 'string' ? dayEntry : (dayEntry?.type || (dow === 0 ? 'off' : 'work'))
      const isWork = dayType === 'work'

      const note = dayType === 'holiday' ? '祝日' : (dayType === 'off' && dow === 0 ? '法定休日' : (dayType === 'off' ? '所定休日' : ''))

      if (!weekly[wn]) weekly[wn] = { days: 0, hours: 0 }
      if (isWork) {
        totalWork++
        totalH += schedule.workH
        weekly[wn].days++
        weekly[wn].hours += schedule.workH
        rows.push([
          `第${wn}週`, d, dowLabel, '出勤',
          schedule.start, schedule.end, schedule.breakMin, schedule.workH, note,
        ])
      } else {
        rows.push([`第${wn}週`, d, dowLabel, '休', '-', '-', '-', '-', note])
      }
    }
    // 合計
    rows.push([])
    rows.push(['', '', '', '所定出勤日数', '', '', '', totalWork + '日', ''])
    rows.push(['', '', '', '所定労働時間 合計', '', '', '', Math.round(totalH * 10) / 10 + 'h', `月の所定総枠 ${legalLimit}h ${totalH <= legalLimit ? '✓ 枠内' : '⚠ 超過'}`])
    // 週別の所定（変形労働：週40h超の週は「週所定」が残業判定の基準になる）
    rows.push([])
    const weeklyTitle = '【週別 所定労働時間】変形労働時間制では、この週所定を超えた分が時間外労働になります'
    rows.push([weeklyTitle])
    rows.push(['週', '所定出勤日数', '週所定労働時間', '残業判定の基準', '', '', '', '', ''])
    for (const wn of Object.keys(weekly).map(Number).sort((a, b) => a - b)) {
      const wk = weekly[wn]
      if (wk.days === 0) continue
      const wh = Math.round(wk.hours * 10) / 10
      const basis = wh > 40
        ? `週所定 ${wh}h 超で時間外（40hではない）`
        : `週40h 超で時間外`
      rows.push([`第${wn}週`, wk.days + '日', wh + 'h', basis, '', '', '', '', ''])
    }

    // シート名: 30文字以内（Excel制限31文字、安全マージン）
    const sheetName = w.name.slice(0, 28) + (w.name.length > 28 ? '..' : '')
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    const weeklyHeaderRow = rows.findIndex(r => r[0] === weeklyTitle)
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 8 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 8 } },
      ...(weeklyHeaderRow >= 0 ? [{ s: { r: weeklyHeaderRow, c: 0 }, e: { r: weeklyHeaderRow, c: 8 } }] : []),
    ]
    setColWidths(sheet, [8, 6, 6, 8, 8, 8, 10, 16, 30])
    XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  }

  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`勤務予定シフト ${ymLabel(ym)} — 対象スタッフがいません`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '対象なし')
  }
  return wb
}

// ────────────────────────────────────────

export interface ActualHoursData {
  ym: string  // YYYYMM
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  sites: { id: string; name: string; workSchedule?: SiteWorkSchedule }[]
  /** 2026-06-XX 追加: 会社別フィルタ (社労士が会社ごとに違うため) */
  org?: 'hibi' | 'hfu' | 'all'
}

/**
 * #2: 実労働時間明細 Excel を生成
 */
export function generateActualHoursExcel(data: ActualHoursData): XLSX.WorkBook {
  const { ym, workers, attD, sites, org } = data
  const wb = XLSX.utils.book_new()

  const foreignWorkers = workers.filter(w => {
    if (!(w.visa && w.visa !== 'none' && w.visa !== '')) return false
    if (!isStillActiveForMonth(w.retired, ym)) return false
    if (!isHiredByMonth(w.hireDate, ym)) return false  // 2026-06-12 (監査): 入社前月除外の横展開
    if (org === 'hibi' && w.org !== 'hibi') return false
    if (org === 'hfu' && w.org !== 'hfu') return false
    return true
  })

  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()

  const siteMap = new Map(sites.map(s => [s.id, s]))

  for (const w of foreignWorkers) {
    const rows: unknown[][] = []
    rows.push([`実労働時間明細 ${ymLabel(ym)} - ${w.name}`])
    rows.push([`スタッフ ID: ${w.id}  /  雇用区分: ${w.visa}`])
    rows.push([`※ 実労働(h) = 始業〜終業 − 実際に取得した休憩。給与計算と完全に同一の算出方法です`])
    rows.push([`※ 休憩(分)は実際に取得した分のみ。現場・作業内容により休憩を取れなかった場合は労働時間に算入されます`])
    rows.push([`※ 所定外(h) = 実労働 − 当日所定時間。始業/終業に「(推定)」がある日は時刻未記録のため標準時刻で推定`])
    rows.push([])
    rows.push(['日', '曜', '状態', '現場', '始業', '終業', '休憩(分)', '実労働(h)', '所定外(h)', '備考'])

    let totalActual = 0
    let totalOT = 0
    let workDays = 0
    let pDays = 0
    let rDays = 0

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay()
      const dowLabel = ['日', '月', '火', '水', '木', '金', '土'][dow]

      // 該当スタッフのその日のエントリを全現場分検索
      const entriesForDay: { siteId: string; entry: AttendanceEntry }[] = []
      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${d}`
        if (attD[key]) entriesForDay.push({ siteId: site.id, entry: attD[key] })
      }

      if (entriesForDay.length === 0) {
        rows.push([d, dowLabel, '-', '', '', '', '', '', '', ''])
        continue
      }

      // 各エントリを別行で出力（同日複数現場対応）
      for (const { siteId, entry } of entriesForDay) {
        const site = siteMap.get(siteId)
        const e = entry as { w?: number; o?: number; p?: number; r?: number; h?: number; hk?: number; exam?: number; st?: string; et?: string; b1?: number; b2?: number; b3?: number }

        // 状態判定
        let status = ''
        if (e.p) { status = '有給'; pDays++ }
        else if (e.hk) status = '帰国中'
        else if (e.exam) status = '試験'
        else if (e.r) { status = '欠勤'; rDays++ }
        else if (e.h) status = '現場休'
        else if (e.w === 0.6) status = '補償日'
        else if ((e.w || 0) > 0) { status = e.w === 0.5 ? '半日' : '出勤'; workDays++ }
        else status = '-'

        // 始業/終業 (st/et が無ければ workSchedule 標準時刻 + 推定マーク)
        // 2026-06-XX 修正 (社労士監査): 給与計算 (calcActualHours) と完全に同一ロジックに統一
        //   旧バグ: computePrescribedFromSchedule で「所定休憩を全部固定控除」していた
        //     → 休憩を実際は取っていない日 (b1/b3未設定) でも7hと表示し、給与計算の8hと食い違う
        //     → 社労士が「実労働明細7h なのに残業1hが別途出る」と照合不能になった
        //   新: calcActualHours(entry, workSchedule) を使用。休憩フラグ b1/b2/b3 が立っている
        //       分のみ控除 = 給与計算と同じ実労働時間になる
        const ws = site?.workSchedule
        const schedule = computePrescribedFromSchedule(ws)
        let startTime = ''
        let endTime = ''
        let breakMin = 0
        let actualH = 0
        let prescribedH = schedule.workH  // 所定労働時間 (この日)
        let nonStatOT = 0                 // 所定外 (実労働 − 所定、当日分)
        let isEstimated = false
        if ((e.w || 0) > 0 && e.w !== 0.6) {
          if (e.st && e.et) {
            startTime = e.st
            endTime = e.et
            // 実際に取得した休憩のみ集計 (フラグ連動・給与計算と同じ)
            const wsTyped = ws as SiteWorkSchedule | undefined
            const mMin = wsTyped?.morningBreak?.enabled === false ? 0 : (wsTyped?.morningBreak?.minutes ?? 30)
            const lMin = wsTyped?.lunchBreak?.enabled === false ? 0 : (wsTyped?.lunchBreak?.minutes ?? 60)
            const aMin = wsTyped?.afternoonBreak?.enabled === false ? 0 : (wsTyped?.afternoonBreak?.minutes ?? 30)
            breakMin = (e.b1 ? mMin : 0) + (e.b2 ? lMin : 0) + (e.b3 ? aMin : 0)
            // 給与計算と同一の calcActualHours で実労働を算出
            actualH = calcActualHours(entry, ws as Parameters<typeof calcActualHours>[1])
            // 所定外 = 実労働 − 所定 (当日。負なら0)
            nonStatOT = Math.max(0, Math.round((actualH - prescribedH) * 10) / 10)
          } else {
            // レガシー入力: 標準時刻 + o で推定
            startTime = schedule.start + ' (推定)'
            endTime = schedule.end + ' (推定)'
            breakMin = schedule.breakMin
            actualH = schedule.workH + (e.o || 0)
            nonStatOT = e.o || 0
            isEstimated = true
          }
          totalActual += actualH
          totalOT += nonStatOT
        }

        rows.push([
          d, dowLabel, status,
          site?.name || siteId,
          startTime || '-',
          endTime || '-',
          breakMin || '-',
          actualH > 0 ? actualH : '-',
          nonStatOT > 0 ? nonStatOT : '-',
          isEstimated ? '時刻未記録（標準時刻で推定）'
            : (breakMin < schedule.breakMin && actualH > prescribedH ? '休憩未取得分を労働時間に算入' : ''),
        ])
      }
    }

    // 合計
    rows.push([])
    rows.push(['', '', '出勤実日数', '', '', '', '', '', workDays + '日', ''])
    rows.push(['', '', '有給日数', '', '', '', '', '', pDays + '日', ''])
    if (rDays > 0) rows.push(['', '', '欠勤日数', '', '', '', '', '', rDays + '日', ''])
    rows.push(['', '', '実労働時間 合計', '', '', '', '', Math.round(totalActual * 10) / 10 + 'h', '', ''])
    rows.push(['', '', '所定外 合計', '', '', '', '', '', Math.round(totalOT * 10) / 10 + 'h', ''])

    const sheetName = w.name.slice(0, 28) + (w.name.length > 28 ? '..' : '')
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 9 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 9 } },
    ]
    setColWidths(sheet, [5, 5, 8, 14, 12, 12, 8, 9, 8, 22])
    XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  }

  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`実労働時間明細 ${ymLabel(ym)} — 対象スタッフがいません`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '対象なし')
  }
  return wb
}

// ────────────────────────────────────────
// 変形労働時間制 カレンダー周知・同意台帳（2026-06 追加）
//   1ヶ月単位の変形労働時間制では「事前に確定した休日カレンダーを各スタッフへ周知し
//   本人の同意を得た」記録が法的に重要。calendarSign の電子署名を台帳化して
//   社労士・労基署提出に使える形で出力する。
// ────────────────────────────────────────

/** UTC ISO → JST 表示 "YYYY/MM/DD HH:mm"（サーバTZに依存しない） */
function isoToJst(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const j = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`
}

/** 承認方法コード → 表示ラベル */
function signMethodLabel(method?: string): string {
  if (method === 'self_tap') return '本人認証(個人リンク)'
  if (method === 'tap') return '名前選択(旧方式)'
  return method || '—'
}

export interface ConsentLedgerData {
  ym: string                 // YYYYMM
  generatedAt?: string       // 出力日時(ISO)。サーバ側で new Date().toISOString()
  approvedSites: { siteId: string; siteName: string; approvedAt: string | null; approvedBy: number | null }[]
  workers: { id: number; name: string }[]   // 署名対象の外国人スタッフ
  /** key: `${workerId}_${siteId}` → 署名レコード（calendarSignLog の最新イベント） */
  signs: Record<string, { signedAt?: string; method?: string; ipHash?: string; resignCount?: number; workCount?: number | null; consentName?: string }>
}

/**
 * 変形労働時間制 カレンダー周知・同意台帳 Excel を生成。
 *  Sheet1「同意台帳」: 承認済みカレンダー一覧 + スタッフ×現場の署名日時マトリクス
 *  Sheet2「署名明細」: 1署名=1行の監査ログ（方法・再署名履歴・端末ハッシュ）
 */
export function generateConsentLedger(data: ConsentLedgerData): XLSX.WorkBook {
  const { ym, generatedAt, approvedSites, workers, signs } = data
  const wb = XLSX.utils.book_new()
  const sitesSorted = [...approvedSites].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ja'))
  const workersSorted = [...workers].sort((a, b) => a.id - b.id)

  // ── Sheet1: 同意台帳（サマリー + マトリクス） ──
  const s1: unknown[][] = []
  s1.push([`変形労働時間制 カレンダー周知・同意台帳　${ymLabel(ym)}`])
  s1.push(['1ヶ月単位の変形労働時間制において、事前に確定した休日カレンダーを各スタッフへ周知し、本人の電子署名で同意を得た記録です。'])
  s1.push([`出力日時: ${isoToJst(generatedAt) || '—'}（JST）`])
  s1.push([])
  s1.push(['【承認（確定）済みカレンダー】'])
  s1.push(['現場', 'カレンダー確定（承認）日時', '承認者ID'])
  if (sitesSorted.length === 0) {
    s1.push(['（承認済みの現場がありません）', '', ''])
  } else {
    for (const st of sitesSorted) {
      s1.push([st.siteName, isoToJst(st.approvedAt) || '未記録', st.approvedBy ?? '—'])
    }
  }
  s1.push([])
  s1.push(['【署名状況マトリクス】セル＝署名日時（JST）／空欄＝未署名'])
  const matrixHeaderRowIdx = s1.length
  s1.push(['スタッフID', '氏名', ...sitesSorted.map(s => s.siteName), '署名済 / 対象'])
  for (const w of workersSorted) {
    const cells: unknown[] = [w.id, w.name]
    let signed = 0
    for (const st of sitesSorted) {
      const rec = signs[`${w.id}_${st.siteId}`]
      if (rec?.signedAt) { signed++; cells.push(isoToJst(rec.signedAt)) }
      else cells.push('未署名')
    }
    cells.push(`${signed} / ${sitesSorted.length}`)
    s1.push(cells)
  }
  const sheet1 = XLSX.utils.aoa_to_sheet(s1)
  const lastCol = Math.max(2, 2 + sitesSorted.length) // 氏名列以降
  sheet1['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ]
  setColWidths(sheet1, [10, 20, ...sitesSorted.map(() => 18), 12])
  XLSX.utils.book_append_sheet(wb, sheet1, '同意台帳')
  void matrixHeaderRowIdx

  // ── Sheet2: 署名明細（1署名=1行の監査ログ） ──
  const s2: unknown[][] = []
  s2.push([`署名明細（監査ログ）　${ymLabel(ym)}`])
  s2.push(['スタッフID', '氏名', '現場', '対象月', '署名状況', '署名日時(JST)', '承認方法', '本人記入氏名', '署名回数', '同意した稼働日数', '端末ハッシュ'])
  for (const w of workersSorted) {
    for (const st of sitesSorted) {
      const rec = signs[`${w.id}_${st.siteId}`]
      if (rec?.signedAt) {
        s2.push([
          w.id, w.name, st.siteName, ymLabel(ym), '署名済',
          isoToJst(rec.signedAt), signMethodLabel(rec.method),
          rec.consentName || '—',
          (rec.resignCount ?? 0) + 1,
          rec.workCount != null ? `${rec.workCount}日` : '—',
          rec.ipHash || '',
        ])
      } else {
        s2.push([w.id, w.name, st.siteName, ymLabel(ym), '未署名', '', '', '', '', '', ''])
      }
    }
  }
  const sheet2 = XLSX.utils.aoa_to_sheet(s2)
  sheet2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }]
  setColWidths(sheet2, [10, 20, 18, 10, 10, 18, 20, 18, 10, 16, 12])
  XLSX.utils.book_append_sheet(wb, sheet2, '署名明細')

  return wb
}

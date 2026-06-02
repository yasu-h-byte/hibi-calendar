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
import { AttendanceEntry } from '@/types'
import { isWorkingDay } from './attendance'
import { isStillActiveForMonth, isAlreadyRetired } from './workers'

// ────────────────────────────────────────
//  共通ヘルパー
// ────────────────────────────────────────

const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

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
          dayHours = entry.w === 0.6 ? Math.round(dailyPrescribed * 0.6 * 10) / 10 : dailyPrescribed
          dayOT = entry.o || 0
          status = entry.w === 0.6 ? '補' : dayOT > 0 ? '出+残' : '出'
        }
      }

      if (isPL) {
        status = '有給'; plCount++
        hoursRow.push(''); otRow.push('')
      } else if (dayHours > 0) {
        const actualH = Math.round((dayHours + dayOT) * 10) / 10
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
  const hibiWorkers = workers.filter(w => (w.org === '日比' || w.org === 'hibi') && isStillActiveForMonth(w.retired, ym))

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
      appendOvertimeSummarySheet(wb, '勤怠サマリー', '日比建設', ym, hibiForeignWorkers, attD, sites, data.calendarDays, bd)
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
  const hfuWorkers = workers.filter(w => (w.org === 'HFU' || w.org === 'hfu') && isStillActiveForMonth(w.retired, ym))

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
  if (calendarDays && ym >= '202605') {
    const bd = (data as { baseDays?: number }).baseDays || 20
    appendOvertimeSummarySheet(wb, '勤怠サマリー', 'HFU', ym, hfuWorkers, attD, sites, calendarDays, bd)
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
}

export function generateSubconConfirmation(data: SubconConfirmationData): XLSX.WorkBook {
  const { ym, subcon, attSD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  const titleRow = [`外注先確認書 ${ymLabel(ym)}`]
  const infoRow = [`外注先: ${subcon.name}`, '', `区分: ${subcon.type}`]
  const headers = ['日付', '人数', '残業人数', '備考']

  const rows: (string | number)[][] = [titleRow, infoRow, [], headers]

  let totalN = 0
  let totalON = 0

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
  rows.push(['単価', `${subcon.rate.toLocaleString()}円`, `${subcon.otRate.toLocaleString()}円`, ''])
  const totalAmount = totalN * subcon.rate + totalON * subcon.otRate
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
  const todayIso = new Date().toISOString().slice(0, 10)
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
    // 日付順にソート
    for (const wid of Object.keys(plDates)) {
      plDates[Number(wid)].sort()
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

  const useNewRules = ym >= '202605'
  const ruleLabel = useNewRules ? '新ルール: 3層構造' : '旧ルール: 月所定時間ベース'

  // 雇用区分 × 会社 でグルーピング
  const isHibi = (w: WorkerMonthly) => w.org === '日比' || w.org === 'hibi'
  const isHfu = (w: WorkerMonthly) => w.org === 'HFU' || w.org === 'hfu'
  const isForeign = (w: WorkerMonthly) => w.visa !== 'none'
  const isJapanese = (w: WorkerMonthly) => w.visa === 'none'

  const hibiForeign = workers.filter(w => isHibi(w) && isForeign(w))
  const hibiJapanese = workers.filter(w => isHibi(w) && isJapanese(w))
  const hfuForeign = workers.filter(w => isHfu(w) && isForeign(w))
  const hfuJapanese = workers.filter(w => isHfu(w) && isJapanese(w))

  // 外国人テーブル ヘッダー
  //   新ルール(5月以降): 法令準拠の詳細支給（22列）
  //   旧ルール(4月以前): 月所定時間ベースのシンプル構成（17列）
  const foreignHeaders = useNewRules
    ? ['名前', '現場', '単価種別', '単価', 'ベース日数', '法定上限(h)',
       '通常出勤', '法休出勤', '補償日', '有給日数',
       '実労働h', '法定残業h', '法休労働h', '深夜労働h',
       '基本給(固定)', '追加所定手当', '法定外残業手当', '法定休日手当', '深夜手当', '休業手当',
       '欠勤日数', '欠勤控除', '支給額合計']
    : ['名前', '現場', '単価種別', '単価', '所定日数', '所定時間(h)',
       '実出勤日数', '補償日', '有給日数', '実労働時間', '残業時間',
       '基本給', '休業補償', '残業手当', '欠勤日数', '欠勤控除', '支給額合計']

  // 日本人テーブル ヘッダー（8列）
  const japaneseHeaders = ['名前', '現場', '日額', '出勤日数', '残業時間(h)', '基本給', '残業手当', '支給額合計']

  const rows: (string | number | null)[][] = []

  // タイトル
  rows.push([`月次集計 ${ymLabel(ym)}（${ruleLabel}）`])

  // ── ブロックレンダラ ──

  function renderForeignBlock(label: string, ws: WorkerMonthly[]) {
    if (ws.length === 0) return
    rows.push([])
    const groupRow: (string | number | null)[] = [label]
    for (let i = 1; i < foreignHeaders.length; i++) groupRow.push(null)
    rows.push(groupRow)
    rows.push(foreignHeaders)
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      const rateKind = w.hourlyRate ? '時給' : (w.salary ? '月給' : '—')
      const rateValue = w.hourlyRate || w.salary || 0
      const baseDaysOrPrescribed = useNewRules ? prescribedDays : prescribedDays
      const limitOrPrescribedH = useNewRules ? (w.legalLimit || 0) : (w.prescribedHours || 0)
      if (useNewRules) {
        // 法令準拠版（22列）
        const legalHolidayDays = (w.actualWorkDays || 0) - (w.regularWorkDays || 0)
        rows.push([
          nameWithDispatch,
          siteList,
          rateKind,
          rateValue,
          baseDaysOrPrescribed,
          limitOrPrescribedH,
          w.regularWorkDays || 0,
          legalHolidayDays > 0 ? legalHolidayDays : 0,
          w.compDays || 0,
          w.plDays || 0,
          w.actualWorkHours || 0,
          w.legalOtHours || 0,           // = statutoryOT 合計
          w.legalHolidayHours || 0,
          w.nightHours || 0,
          w.fixedBasePay || w.basePay || 0,
          w.additionalAllowance || 0,
          w.otAllowance || 0,
          w.legalHolidayAllowance || 0,
          w.nightAllowance || 0,
          w.compAllowance || 0,
          w.absence || 0,
          w.absentDeduction || 0,
          w.salaryNetPay || 0,
        ])
      } else {
        // 旧ルール版（17列）— additionalAllowance を「休業補償」として表示
        rows.push([
          nameWithDispatch,
          siteList,
          rateKind,
          rateValue,
          baseDaysOrPrescribed,
          limitOrPrescribedH,
          w.actualWorkDays || 0,
          w.compDays || 0,
          w.plDays || 0,
          w.actualWorkHours || 0,
          w.legalOtHours || 0,
          w.fixedBasePay || w.basePay || 0,
          w.additionalAllowance || 0,    // 旧ルールでは休業補償
          w.otAllowance || 0,
          w.absence || 0,
          w.absentDeduction || 0,
          w.salaryNetPay || 0,
        ])
      }
    }
    // 小計
    if (useNewRules) {
      const sumLegalHolidayDays = ws.reduce((s, w) => s + Math.max(0, (w.actualWorkDays || 0) - (w.regularWorkDays || 0)), 0)
      rows.push([
        '小計', null, null, null, null, null,
        ws.reduce((s, w) => s + (w.regularWorkDays || 0), 0),
        sumLegalHolidayDays,
        ws.reduce((s, w) => s + (w.compDays || 0), 0),
        ws.reduce((s, w) => s + w.plDays, 0),
        null,
        ws.reduce((s, w) => s + (w.legalOtHours || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayHours || 0), 0),
        ws.reduce((s, w) => s + (w.nightHours || 0), 0),
        ws.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
        ws.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
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
        ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
      ])
    }
  }

  function renderJapaneseBlock(label: string, ws: WorkerMonthly[]) {
    if (ws.length === 0) return
    rows.push([])
    const groupRow: (string | number | null)[] = [label]
    for (let i = 1; i < japaneseHeaders.length; i++) groupRow.push(null)
    rows.push(groupRow)
    rows.push(japaneseHeaders)
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      rows.push([
        nameWithDispatch,
        siteList,
        w.rate,
        w.workDays,
        w.dailyOtHours || w.otHours || 0,
        w.basePay || 0,
        w.otAllowance || 0,
        w.salaryNetPay || 0,
      ])
    }
    rows.push([
      '小計', null, null,
      ws.reduce((s, w) => s + w.workDays, 0),
      ws.reduce((s, w) => s + (w.dailyOtHours || w.otHours || 0), 0),
      ws.reduce((s, w) => s + (w.basePay || 0), 0),
      ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
      ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])
  }

  // ── 4 ブロック + 協力業者 ──
  renderForeignBlock('【日比建設・ベトナム人】', hibiForeign)
  renderJapaneseBlock('【日比建設・日本人】', hibiJapanese)
  renderForeignBlock('【HFU・ベトナム人】', hfuForeign)
  renderJapaneseBlock('【HFU・日本人】', hfuJapanese)

  // 協力業者
  if (subcons.length > 0) {
    rows.push([])
    const groupRow: (string | number | null)[] = ['【協力業者】']
    for (let i = 1; i < 7; i++) groupRow.push(null)
    rows.push(groupRow)
    rows.push(['外注先', '区分', '現場', '人工', '残業', '単価', '金額'])
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
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: foreignHeaders.length - 1 } }]
  // 列幅: 新ルール(23列) / 旧ルール(17列) で切替
  if (useNewRules) {
    setColWidths(ws, [
      14, 14, 8, 10, 10, 10,       // 名前/現場/単価種別/単価/ベース日数/法定上限
      8, 8, 8, 8,                  // 通常出勤/法休出勤/補償日/有給日数
      9, 9, 9, 9,                  // 実労働h/法定残業h/法休労働h/深夜労働h
      11, 11, 12, 12, 10, 10,      // 基本給/追加所定/法定外残業/法休手当/深夜手当/休業手当
      8, 11, 14,                   // 欠勤日数/欠勤控除/支給額合計
    ])
  } else {
    setColWidths(ws, [14, 16, 8, 10, 10, 10, 10, 8, 8, 10, 10, 12, 12, 10, 8, 12, 14])
  }

  XLSX.utils.book_append_sheet(wb, ws, '月次集計')
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
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && (w.org === '日比' || w.org === 'hibi'))
    const hfuWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && (w.org === 'HFU' || w.org === 'hfu'))

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
    const exp = new Date(gd)
    exp.setFullYear(exp.getFullYear() + 2)
    exp.setDate(exp.getDate() - 1)
    return fmtDate(exp.toISOString())
  }

  // periodUsed 計算（grantDate..+1年 のPエントリ、申請ベース）
  // ※ 2026-05-18: 申請ベースで統一（未来日付の p:1 も使用済みとして含める）
  const countPeriodUsed = (workerId: number, grantDate?: string): number => {
    if (!grantDate) return 0
    const gd = new Date(grantDate)
    if (isNaN(gd.getTime())) return 0
    const end = new Date(gd); end.setFullYear(end.getFullYear() + 1)
    let count = 0
    for (const [key, entry] of Object.entries(allAtt)) {
      if (!entry) continue
      const e = entry as { p?: number | boolean }
      if (!e.p) continue
      const pk = parseDKey(key)
      if (parseInt(pk.wid) !== workerId) continue
      const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
      if (d >= gd && d < end) count++
    }
    return count
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
  const todayIsoForLedger = new Date().toISOString().slice(0, 10)
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
      const status = r._archived ? 'アーカイブ' : (r.expiredAt ? '失効済' : (r.grantDate && new Date(r.grantDate).getTime() + 2 * 365 * 86400000 < Date.now() ? '期限切れ' : '有効'))
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

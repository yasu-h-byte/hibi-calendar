import * as XLSX from 'xlsx'
import {
  RawWorker,
  RawSubcon,
  WorkerMonthly,
  SubconMonthly,
  SiteSummary,
  PLRecord,
  parseDKey,
} from './compute'
import { AttendanceEntry } from '@/types'

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
    prescribedHours.push(isWorkDay ? 7 : 0)
  }
  const totalPrescribed = prescribedHours.reduce((s, h) => s + h, 0)

  const headers = ['名前', '区分']
  for (let d = 1; d <= numDays; d++) headers.push(dayLabel(ym, d))
  headers.push('合計', '法定上限')

  const titleRow = [`${titlePrefix} 勤務時間一覧 ${ymLabel(ym)}（変形労働時間制）`]
  const rows: (string | number)[][] = [titleRow, headers]

  // 所定時間行
  const prescRow: (string | number)[] = ['', '所定(h)']
  for (let d = 0; d < numDays; d++) prescRow.push(prescribedHours[d] > 0 ? prescribedHours[d] : '')
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
        if (entry.w && entry.w > 0) {
          dayHours = entry.w === 0.6 ? Math.round(7 * 0.6 * 10) / 10 : 7
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
  rows.push(['', '1日の所定: 7時間（8:00-17:00、休憩2時間）'])
  rows.push(['', '法定上限: 暦日数 × 40 ÷ 7 =', legalLimit, 'h'])
  rows.push(['', '残業判定: 1日単位(8h超) → 1週単位(40h超) → 1ヶ月単位(法定上限超) の3段階'])
  rows.push(['', '※ 「実労働(h)」= 所定7h + 残業h で変換済み。「うち残業(h)」は出面入力の残業欄の値。'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 3 } }]
  const colWidths = [14, 10]; for (let d = 0; d < numDays; d++) colWidths.push(7); colWidths.push(8, 8)
  setColWidths(ws, colWidths)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
}

export function generateHibiAttendance(data: HibiAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  const hibiWorkers = workers.filter(w => (w.org === '日比' || w.org === 'hibi') && !w.retired)

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
  const hibiForeignWorkers = hibiWorkers.filter(w => w.visa && w.visa !== 'none' && w.visa !== '')
  if (hibiForeignWorkers.length > 0) {
    appendTimeSheet(wb, '勤務時間一覧', '日比建設', ym, hibiForeignWorkers, attD, sites, data.calendarDays)
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
}

export function generateHfuAttendance(data: HfuAttendanceExportData): XLSX.WorkBook {
  const { ym, workers, attD, sites, calendarDays } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  const hfuWorkers = workers.filter(w => (w.org === 'HFU' || w.org === 'hfu') && !w.retired)

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
  appendTimeSheet(wb, '勤務時間一覧', 'HFU', ym, hfuWorkers, attD, sites, calendarDays)

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
  const activeWorkers = workers.filter(w => {
    if (w.retired) return false
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

  for (const w of activeWorkers) {
    const records = plData[String(w.id)] || []
    if (records.length === 0) {
      rows.push([w.name, w.org, w.hireDate || '', '-', 0, 0, 0, 0, '-'])
      continue
    }

    // 最新のレコードを使用
    const recordsWithGrant = records.filter(r =>
      (r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0)
    )
    const r = recordsWithGrant.length > 0 ? recordsWithGrant[recordsWithGrant.length - 1] : records[records.length - 1]

    const grantDays = r.grantDays ?? r.grant ?? 0
    const carryOver = r.carryOver ?? r.carry ?? 0
    const adjustment = Math.max(r.adjustment ?? 0, r.adj ?? 0)
    const total = grantDays + carryOver

    // 出面からの取得日数
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

export function generateMonthlyExcel(data: MonthlyExcelData): XLSX.WorkBook {
  const { ym, workers, subcons, siteNames, prescribedDays } = data
  const wb = XLSX.utils.book_new()

  // ── Sheet 1: 月次集計一覧 ──

  const hibiWorkers = workers.filter(w => w.org === '日比' || w.org === 'hibi')
  const hfuWorkers = workers.filter(w => w.org === 'HFU' || w.org === 'hfu')
  const showAbsence = prescribedDays > 0

  const s1Title = [`月次集計一覧 ${ymLabel(ym)}`]
  const s1Rows: (string | number | null)[][] = [s1Title]

  // -- Workers section --
  const wHeaders: string[] = [
    '名前', '所属', '現場', '出勤日数', '有給', '残業(h)', '日額単価', '概算労務費',
  ]
  if (showAbsence) {
    wHeaders.push('欠勤日数', '欠勤控除', '差引支給')
  }
  wHeaders.push('基本給', '追加所定手当', '残業手当', '欠勤控除', '支給額合計')
  s1Rows.push(wHeaders)

  // Group: 日比建設
  if (hibiWorkers.length > 0) {
    const groupRow: (string | number | null)[] = ['【日比建設】']
    for (let i = 1; i < wHeaders.length; i++) groupRow.push(null)
    s1Rows.push(groupRow)
    for (const w of hibiWorkers) {
      s1Rows.push(buildWorkerRow(w, siteNames, showAbsence))
    }
  }

  // Group: HFU
  if (hfuWorkers.length > 0) {
    const groupRow: (string | number | null)[] = ['【HFU】']
    for (let i = 1; i < wHeaders.length; i++) groupRow.push(null)
    s1Rows.push(groupRow)
    for (const w of hfuWorkers) {
      s1Rows.push(buildWorkerRow(w, siteNames, showAbsence))
    }
  }

  // Worker totals（出向控除済みの労務費を集計）
  const totalDispatchDeduction = workers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
  const wTotals: (string | number | null)[] = [
    totalDispatchDeduction > 0 ? `合計（出向控除 -${totalDispatchDeduction.toLocaleString()}円含む）` : '合計', '', '',
    workers.reduce((s, w) => s + (w.workAll || w.workDays), 0),
    workers.reduce((s, w) => s + w.plDays, 0),
    workers.reduce((s, w) => s + w.otHours, 0),
    null,
    workers.reduce((s, w) => s + w.totalCost, 0) - totalDispatchDeduction,
  ]
  if (showAbsence) {
    wTotals.push(
      workers.reduce((s, w) => s + (w.absence || 0), 0),
      workers.reduce((s, w) => s + (w.absentCost || 0), 0),
      workers.reduce((s, w) => s + (w.netPay || 0), 0),
    )
  }
  wTotals.push(
    workers.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
    workers.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
    workers.reduce((s, w) => s + (w.otAllowance || 0), 0),
    workers.reduce((s, w) => s + (w.absentDeduction || 0), 0),
    workers.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
  )
  s1Rows.push(wTotals)

  // -- Blank row --
  s1Rows.push([])

  // -- Subcon section --
  const scHeaders = ['外注先', '区分', '現場', '人工', '残業', '単価', '金額']
  s1Rows.push(scHeaders)

  for (const sc of subcons) {
    const siteList = sc.sites.map(sid => siteNames[sid] || sid).join(', ')
    s1Rows.push([
      sc.name, sc.type, siteList,
      sc.workDays, sc.otCount, sc.rate, sc.cost,
    ])
  }

  const scTotals: (string | number | null)[] = [
    '合計', '', '',
    subcons.reduce((s, sc) => s + sc.workDays, 0),
    subcons.reduce((s, sc) => s + sc.otCount, 0),
    null,
    subcons.reduce((s, sc) => s + sc.cost, 0),
  ]
  s1Rows.push(scTotals)

  const ws1 = XLSX.utils.aoa_to_sheet(s1Rows)

  // Merge title row
  ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: wHeaders.length - 1 } }]

  // Column widths for sheet 1
  const s1Widths = [12, 8, 16, 10, 6, 10, 12, 14]
  if (showAbsence) s1Widths.push(10, 12, 14)
  s1Widths.push(12, 12, 12, 14)
  setColWidths(ws1, s1Widths)

  XLSX.utils.book_append_sheet(wb, ws1, '月次集計')

  // ── Sheet 2: 給与計算詳細 ──

  const s2Title = [`給与計算詳細 ${ymLabel(ym)}`]
  const s2Rows: (string | number | null)[][] = [s2Title]

  // Foreign workers (hourlyRate-based)
  const foreignWorkers = workers.filter(w => w.visa !== 'none' && w.hourlyRate && w.hourlyRate > 0)
  if (foreignWorkers.length > 0) {
    s2Rows.push([])
    const fHeaders = [
      '名前', '時給', 'ベース日数', '法定上限(h)',
      '実出勤日数', '実労働時間', '法定残業時間',
      '基本給（固定）', '追加所定手当', '残業手当', '欠勤日数', '欠勤控除', '支給額合計',
    ]
    s2Rows.push(fHeaders)

    for (const w of foreignWorkers) {
      s2Rows.push([
        w.name,
        w.hourlyRate || 0,
        prescribedDays,
        w.legalLimit || 0,
        w.actualWorkDays || 0,
        w.actualWorkHours || 0,
        w.legalOtHours || 0,
        w.fixedBasePay || w.basePay || 0,
        w.additionalAllowance || 0,
        w.otAllowance || 0,
        w.absence || 0,
        w.absentDeduction || 0,
        w.salaryNetPay || 0,
      ])
    }

    // Foreign worker totals
    s2Rows.push([
      '合計', null, null, null,
      foreignWorkers.reduce((s, w) => s + (w.actualWorkDays || 0), 0),
      null,
      foreignWorkers.reduce((s, w) => s + (w.legalOtHours || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.absence || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.absentDeduction || 0), 0),
      foreignWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])

  }

  // Salary-based foreign workers (salary field, no hourlyRate)
  const salaryForeignWorkers = workers.filter(w => w.visa !== 'none' && !w.hourlyRate && w.salary && w.salary > 0)
  if (salaryForeignWorkers.length > 0) {
    s2Rows.push([])
    const sfHeaders = [
      '名前', '月給', 'ベース日数', '法定上限(h)',
      '実出勤日数', '実労働時間', '法定残業時間',
      '基本給（固定）', '追加所定手当', '残業手当', '欠勤日数', '欠勤控除', '支給額合計',
    ]
    s2Rows.push(sfHeaders)

    for (const w of salaryForeignWorkers) {
      s2Rows.push([
        w.name,
        w.salary || 0,
        prescribedDays,
        w.legalLimit || 0,
        w.actualWorkDays || 0,
        w.actualWorkHours || 0,
        w.legalOtHours || 0,
        w.fixedBasePay || w.basePay || 0,
        w.additionalAllowance || 0,
        w.otAllowance || 0,
        w.absence || 0,
        w.absentDeduction || 0,
        w.salaryNetPay || 0,
      ])
    }

    s2Rows.push([
      '合計', null, null, null,
      salaryForeignWorkers.reduce((s, w) => s + (w.actualWorkDays || 0), 0),
      null,
      salaryForeignWorkers.reduce((s, w) => s + (w.legalOtHours || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.absence || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.absentDeduction || 0), 0),
      salaryForeignWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])
  }

  // Japanese workers (daily-rate based)
  const japaneseWorkers = workers.filter(w => w.visa === 'none')
  if (japaneseWorkers.length > 0) {
    s2Rows.push([])
    const jHeaders = [
      '名前', '日額', '実出勤日数', '基本給', '残業時間', '残業手当', '支給額合計',
    ]
    s2Rows.push(jHeaders)

    for (const w of japaneseWorkers) {
      s2Rows.push([
        w.name,
        w.rate,
        w.workDays,
        w.basePay || 0,
        w.dailyOtHours || w.otHours || 0,
        w.otAllowance || 0,
        w.salaryNetPay || 0,
      ])
    }

    s2Rows.push([
      '合計', null,
      japaneseWorkers.reduce((s, w) => s + w.workDays, 0),
      japaneseWorkers.reduce((s, w) => s + (w.basePay || 0), 0),
      japaneseWorkers.reduce((s, w) => s + (w.dailyOtHours || w.otHours || 0), 0),
      japaneseWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0),
      japaneseWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])
  }

  const ws2 = XLSX.utils.aoa_to_sheet(s2Rows)

  // Merge title
  ws2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }]

  // Column widths for sheet 2
  setColWidths(ws2, [12, 10, 10, 10, 10, 10, 10, 12, 12, 10, 12, 14])

  XLSX.utils.book_append_sheet(wb, ws2, '給与計算詳細')

  return wb
}

function buildWorkerRow(
  w: WorkerMonthly,
  siteNames: Record<string, string>,
  showAbsence: boolean,
): (string | number | null)[] {
  const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
  // 出向中スタッフは名前に🔁マークを付け、概算労務費は出向控除額（マイナス）として表示
  const nameWithDispatch = w.isDispatched
    ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
    : w.name
  const row: (string | number | null)[] = [
    nameWithDispatch,
    w.org === 'hfu' || w.org === 'HFU' ? 'HFU' : '日比',
    siteList,
    w.workAll || w.workDays,
    w.plDays || 0,
    w.otHours || 0,
    w.rate,
    w.isDispatched ? -Math.round(w.dispatchDeduction || w.totalCost) : Math.round(w.totalCost),
  ]
  if (showAbsence) {
    row.push(
      w.absence || 0,
      w.absentCost || 0,
      w.netPay || 0,
    )
  }
  row.push(
    w.fixedBasePay || w.basePay || 0,
    w.additionalAllowance || 0,
    w.otAllowance || 0,
    w.absentDeduction || 0,
    w.salaryNetPay || 0,
  )
  return row
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

    // 日比建設ワーカーとHFUワーカーに分ける（退職者除く）
    const hibiWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && !w.retired && (w.org === '日比' || w.org === 'hibi'))
    const hfuWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && !w.retired && (w.org === 'HFU' || w.org === 'hfu'))

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
            } else if (entry.w && entry.w > 0) {
              dayWork = entry.w
              wWork += entry.w
              secDailyWork[d - 1] += entry.w
              if (entry.o && entry.o > 0) {
                dayOT = entry.o
              }
            }
            if (entry.o && entry.o > 0) {
              dayOT = entry.o
              wOT += dayOT
              secDailyOT[d - 1] += dayOT
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

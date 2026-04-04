import * as XLSX from 'xlsx'
import {
  RawWorker,
  RawSubcon,
  WorkerMonthly,
  SubconMonthly,
  SiteSummary,
  PLRecord,
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
  return `${day}日(${DOW_SHORT[d.getDay()]})`
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
}

export function generateHibiAttendance(data: HibiAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites, assign, massign } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // Filter to 日比 workers only (non-retired)
  const hibiWorkers = workers.filter(w => w.org === '日比' && !w.retired)

  // Build header row
  const headers = ['名前', '所属']
  for (let d = 1; d <= numDays; d++) {
    headers.push(dayLabel(ym, d))
  }
  headers.push('合計', '残業(h)', '有給')

  // Title row
  const titleRow = [`日比建設 出面一覧 ${ymLabel(ym)}`]

  const rows: (string | number)[][] = [titleRow, headers]

  let totalWork = 0
  let totalOT = 0
  let totalPL = 0

  for (const w of hibiWorkers) {
    const row: (string | number)[] = [w.name, w.org]
    let wWork = 0
    let wOT = 0
    let wPL = 0

    for (let d = 1; d <= numDays; d++) {
      const dd = String(d)
      // Check all sites for this worker on this day
      let dayVal = '-'
      let dayOT = 0
      let isPL = false

      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${dd}`
        const entry = attD[key]
        if (!entry) continue

        if (entry.p) {
          isPL = true
          break
        }
        if (entry.w === 1) {
          dayVal = '\u25CF' // ●
          if (entry.o && entry.o > 0) dayOT += entry.o
        } else if (entry.w === 0.5) {
          dayVal = '\u25B3' // △
        } else if (entry.w === 0.6) {
          dayVal = '\u25B3' // △ for compressed day
        }
      }

      if (isPL) {
        dayVal = '\u6709' // 有
        wPL += 1
      }

      if (dayVal === '\u25CF') wWork += 1
      else if (dayVal === '\u25B3') wWork += 0.5

      wOT += dayOT
      row.push(dayVal)
    }

    row.push(wWork || '-')
    row.push(wOT || '-')
    row.push(wPL || '-')

    totalWork += wWork
    totalOT += wOT
    totalPL += wPL

    rows.push(row)
  }

  // Footer totals row
  const footerRow: (string | number)[] = ['合計', '']
  for (let d = 1; d <= numDays; d++) {
    footerRow.push('')
  }
  footerRow.push(totalWork, totalOT, totalPL)
  rows.push(footerRow)

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Merge title row
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 4 } }]

  // Column widths
  const colWidths = [12, 6]
  for (let d = 0; d < numDays; d++) colWidths.push(7)
  colWidths.push(6, 8, 5)
  setColWidths(ws, colWidths)

  XLSX.utils.book_append_sheet(wb, ws, '出面一覧')
  return wb
}

// ────────────────────────────────────────
//  2. HFU向け出面一覧
// ────────────────────────────────────────

export function generateHfuAttendance(data: HibiAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // Filter to HFU workers only
  const hfuWorkers = workers.filter(w => w.org === 'HFU' && !w.retired)

  const headers = ['名前', 'ビザ']
  for (let d = 1; d <= numDays; d++) {
    headers.push(dayLabel(ym, d))
  }
  headers.push('合計', '残業(h)', '有給')

  const titleRow = [`HFU 出面一覧 ${ymLabel(ym)}`]
  const rows: (string | number)[][] = [titleRow, headers]

  let totalWork = 0
  let totalOT = 0
  let totalPL = 0

  for (const w of hfuWorkers) {
    const row: (string | number)[] = [w.name, w.visa]
    let wWork = 0
    let wOT = 0
    let wPL = 0

    for (let d = 1; d <= numDays; d++) {
      const dd = String(d)
      let dayVal = '-'
      let dayOT = 0
      let isPL = false

      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${dd}`
        const entry = attD[key]
        if (!entry) continue

        if (entry.p) { isPL = true; break }
        if (entry.w === 1) {
          dayVal = '\u25CF'
          if (entry.o && entry.o > 0) dayOT += entry.o
        } else if (entry.w === 0.5 || entry.w === 0.6) {
          dayVal = '\u25B3'
        }
      }

      if (isPL) { dayVal = '\u6709'; wPL += 1 }
      if (dayVal === '\u25CF') wWork += 1
      else if (dayVal === '\u25B3') wWork += 0.5
      wOT += dayOT
      row.push(dayVal)
    }

    row.push(wWork || '-')
    row.push(wOT || '-')
    row.push(wPL || '-')
    totalWork += wWork
    totalOT += wOT
    totalPL += wPL
    rows.push(row)
  }

  const footerRow: (string | number)[] = ['合計', '']
  for (let d = 1; d <= numDays; d++) footerRow.push('')
  footerRow.push(totalWork, totalOT, totalPL)
  rows.push(footerRow)

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 4 } }]

  const colWidths = [12, 8]
  for (let d = 0; d < numDays; d++) colWidths.push(7)
  colWidths.push(6, 8, 5)
  setColWidths(ws, colWidths)

  XLSX.utils.book_append_sheet(wb, ws, '出面一覧')
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
}

export function generatePLLedger(data: PLLedgerData): XLSX.WorkBook {
  const { workers, plData } = data
  const wb = XLSX.utils.book_new()

  const titleRow = ['有給管理台帳']
  const headers = [
    '名前', '所属', '入社日', '年度',
    '付与日', '付与日数', '繰越日数', '調整',
    '使用日数', '残日数',
  ]

  const rows: (string | number)[][] = [titleRow, headers]

  const activeWorkers = workers.filter(w => !w.retired)

  for (const w of activeWorkers) {
    const records = plData[String(w.id)] || []
    if (records.length === 0) {
      rows.push([w.name, w.org, w.hireDate || '', '-', '-', 0, 0, 0, 0, 0])
      continue
    }

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      // 旧フィールド対応
      const grantDays = (r.grant != null || r.adj != null || r.carry != null)
        ? (r.grant ?? r.grantDays ?? 0) : (r.grantDays ?? 0)
      const carryOver = (r.grant != null || r.adj != null || r.carry != null)
        ? (r.carry ?? 0) : (r.carryOver ?? 0)
      const adjustment = Math.max(r.adjustment ?? 0, r.adj ?? 0)
      const total = grantDays + carryOver
      const used = adjustment + (r.used || 0)
      const remaining = Math.max(0, total - used)
      rows.push([
        i === 0 ? w.name : '',
        i === 0 ? w.org : '',
        i === 0 ? (w.hireDate || '') : '',
        r.fy,
        r.grantDate || '',
        grantDays,
        carryOver,
        adjustment,
        used,
        remaining,
      ])
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }]
  setColWidths(ws, [12, 6, 12, 8, 12, 8, 8, 6, 8, 8])

  XLSX.utils.book_append_sheet(wb, ws, '有給管理台帳')
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
  wHeaders.push('基本給', '残業手当', '欠勤控除', '支給額合計')
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

  // Worker totals
  const wTotals: (string | number | null)[] = [
    '合計', '', '',
    workers.reduce((s, w) => s + (w.workAll || w.workDays), 0),
    workers.reduce((s, w) => s + w.plDays, 0),
    workers.reduce((s, w) => s + w.otHours, 0),
    null,
    workers.reduce((s, w) => s + w.totalCost, 0),
  ]
  if (showAbsence) {
    wTotals.push(
      workers.reduce((s, w) => s + (w.absence || 0), 0),
      workers.reduce((s, w) => s + (w.absentCost || 0), 0),
      workers.reduce((s, w) => s + (w.netPay || 0), 0),
    )
  }
  wTotals.push(
    workers.reduce((s, w) => s + (w.basePay || 0), 0),
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
      '名前', '時給', '所定日数', '所定時間',
      '実出勤日数', '実労働時間', '法定残業時間',
      '基本給', '残業手当', '欠勤日数', '欠勤控除', '支給額合計',
    ]
    s2Rows.push(fHeaders)

    for (const w of foreignWorkers) {
      s2Rows.push([
        w.name,
        w.hourlyRate || 0,
        prescribedDays,
        w.prescribedHours || (prescribedDays * 7),
        w.actualWorkDays || 0,
        w.actualWorkHours || 0,
        w.legalOtHours || 0,
        w.basePay || 0,
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
      foreignWorkers.reduce((s, w) => s + (w.basePay || 0), 0),
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
      '名前', '月給', '所定日数', '所定時間',
      '実出勤日数', '実労働時間', '法定残業時間',
      '基本給', '残業手当', '欠勤日数', '欠勤控除', '支給額合計',
    ]
    s2Rows.push(sfHeaders)

    for (const w of salaryForeignWorkers) {
      s2Rows.push([
        w.name,
        w.salary || 0,
        prescribedDays,
        w.prescribedHours || (prescribedDays * 7),
        w.actualWorkDays || 0,
        w.actualWorkHours || 0,
        w.legalOtHours || 0,
        w.basePay || 0,
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
      salaryForeignWorkers.reduce((s, w) => s + (w.basePay || 0), 0),
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
  const row: (string | number | null)[] = [
    w.name,
    w.org === 'hfu' || w.org === 'HFU' ? 'HFU' : '日比',
    siteList,
    w.workAll || w.workDays,
    w.plDays || 0,
    w.otHours || 0,
    w.rate,
    Math.round(w.totalCost),
  ]
  if (showAbsence) {
    row.push(
      w.absence || 0,
      w.absentCost || 0,
      w.netPay || 0,
    )
  }
  row.push(
    w.basePay || 0,
    w.otAllowance || 0,
    w.absentDeduction || 0,
    w.salaryNetPay || 0,
  )
  return row
}

// ────────────────────────────────────────
//  Workbook → Buffer
// ────────────────────────────────────────

export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
  return Buffer.from(buf)
}

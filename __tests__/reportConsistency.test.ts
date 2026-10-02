/**
 * 帳票の突き合わせ（2026-10-02 総合点検・提案2）
 *
 * 同じ入力から 月次集計（computeMonthly）・月次集計Excel・出面一覧／勤怠サマリー・計算根拠の監査チェック を作り、
 * 出勤日数・基本給・支給額が一致することを固定する。終了した現場・帰国・出向・補償＋追加所定 を含む。
 * 架空の人・金額のみ。
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { computeMonthly, type MainData, type RawWorker } from '@/lib/compute'
import { generateMonthlyExcel, generateOrgAttendance, sitesForMonthSheets } from '@/lib/export'
import { buildAuditChecks, type PayrollAuditWorker } from '@/lib/payroll-validator'
import type { AttendanceEntry } from '@/types'

const YM = '202610'
const E = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry
const dow = (d: number) => new Date(2026, 9, d).getDay()
const cal: Record<string, string> = {}
let P = 0
for (let d = 1; d <= 31; d++) { const work = dow(d) !== 0; cal[d] = work ? 'work' : 'off'; if (work) P++ }

const workers = [
  { id: 201, name: '新契約A', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 10500, hourlyRate: 1500, otMul: 1.25, hireDate: '2022-10-01', token: '' },
  { id: 202, name: '新契約B（帰国）', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: 10500, hourlyRate: 1500, otMul: 1.25, hireDate: '2022-10-01', token: '' },
  { id: 4, name: '日給C', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2020-04-01', token: '' },
  { id: 5, name: '日給D（出向）', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2020-04-01', token: '', dispatchTo: '出向先', dispatchFrom: '2026-01' },
] as unknown as RawWorker[]
const sites = [
  { id: 'live', name: '稼働中', start: '', end: '', foreman: 0, archived: false },
  { id: 'done', name: '終了済み', start: '', end: '', foreman: 0, archived: true },   // 月が終わってから終了にした現場
]
function build(): { main: MainData; att: Record<string, AttendanceEntry> } {
  const main = {
    workers, sites, subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {}, defaultRates: {}, mforeman: {},
  } as unknown as MainData
  const att: Record<string, AttendanceEntry> = {}
  const workdays = Object.entries(cal).filter(([, t]) => t === 'work').map(([d]) => Number(d))
  // A: 終了済み現場で21日出勤 ＋ 現場都合休2日 → 追加所定1日と休業手当1.2日分が両方ある
  workdays.slice(0, 21).forEach(d => { att[`done_201_${YM}_${d}`] = E })
  workdays.slice(21, 23).forEach(d => { att[`done_201_${YM}_${d}`] = { w: 0.6 } as AttendanceEntry })
  // B: 10/1〜10/10 帰国、以降は稼働中の現場に全日出勤
  workdays.filter(d => d > 10).forEach(d => { att[`live_202_${YM}_${d}`] = E })
  // C: 日給、終了済み現場に10日・稼働中に5日・現場都合休(0.6)1日
  workdays.slice(0, 10).forEach(d => { att[`done_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry })
  workdays.slice(10, 15).forEach(d => { att[`live_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry })
  att[`live_4_${YM}_${workdays[15]}`] = { w: 0.6 } as AttendanceEntry
  // D: 出向者
  workdays.slice(0, 8).forEach(d => { att[`live_5_${YM}_${d}`] = { w: 1 } as AttendanceEntry })
  return { main, att }
}
const homeLeaves = [{ workerId: 202, startDate: '2026-10-01', endDate: '2026-10-10' }]
const siteWorkDays = { live: P, done: P }
const calendars = { live: cal, done: cal }

describe('月次集計 と 帳票 の突き合わせ', () => {
  const { main, att } = build()
  const r = computeMonthly(main, att, {}, YM, 0, siteWorkDays, 20, calendars, homeLeaves)
  const byId = (id: number) => r.workers.find(w => w.id === id)!

  it('前提: A は追加所定と休業手当が両方、B は帰国で基本給が日割り', () => {
    expect(byId(201).additionalAllowance).toBeGreaterThan(0)
    expect(byId(201).compAllowance).toBeGreaterThan(0)
    expect(byId(202).hkDays).toBe(10)
    expect(byId(202).fixedBasePay).toBeLessThan(1500 * 20 * 7)
  })

  it('出面一覧Excel: 終了済み現場の日も載り、出勤合計＝月次集計の出勤日数（日本人は人工）', () => {
    const forMonth = sitesForMonthSheets(main.sites, YM, att).map(s => ({ id: s.id, name: s.name }))
    expect(forMonth.map(s => s.id).sort()).toEqual(['done', 'live'])
    const wb = generateOrgAttendance({ ym: YM, workers: main.workers, attD: att, sites: forMonth, assign: {}, massign: {}, calendarDays: calendars, baseDays: 20, monthlyWorkers: r.workers }, 'hibi')
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['出面一覧'], { header: 1 }) as (string | number)[][]
    const total = (name: string) => { const row = rows.find(x => x[0] === name)!; return Number(row[row.length - 1]) }
    expect(total('新契約A')).toBe(21 + 0.6 * 2)          // 補償日は 0.6 として載る
    expect(total('新契約B（帰国）')).toBe(byId(202).workDays)
    expect(total('日給C')).toBe(byId(4).manDays)          // 終了済み現場の10日も含めて 15.6
    // 旧: 終了した現場を除いていたので A の21日・C の10日が消えていた
    const old = generateOrgAttendance({ ym: YM, workers: main.workers, attD: att, sites: forMonth.filter(s => s.id === 'live'), assign: {}, massign: {}, calendarDays: calendars, baseDays: 20 }, 'hibi')
    const oldRows = XLSX.utils.sheet_to_json(old.Sheets['出面一覧'], { header: 1 }) as (string | number)[][]
    const oldA = oldRows.find(x => x[0] === '新契約A')!
    expect(oldA[oldA.length - 1]).toBe('')
  })

  it('勤怠サマリー: 基本給(固定)は月次集計の値（帰国の日割り）', () => {
    const forMonth = sitesForMonthSheets(main.sites, YM, att).map(s => ({ id: s.id, name: s.name }))
    const wb = generateOrgAttendance({ ym: YM, workers: main.workers, attD: att, sites: forMonth, assign: {}, massign: {}, calendarDays: calendars, baseDays: 20, monthlyWorkers: r.workers }, 'hibi')
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['勤怠サマリー'], { header: 1 }) as (string | number)[][]
    const h = rows[1] as string[]
    const col = h.indexOf('基本給(固定)')
    expect(rows.find(x => x[0] === '新契約A')![col]).toBe(byId(201).fixedBasePay)
    expect(rows.find(x => x[0] === '新契約B（帰国）')![col]).toBe(byId(202).fixedBasePay)
    expect(rows.some(x => String(x[1] ?? '').includes('新契約B（帰国）（帰国中 10日）'))).toBe(true)
  })

  it('月次集計Excel: 支給額合計の小計＝月次集計の合計、検算OK、新しい列（枠内補償日・試験日・帰国日数・保証枠・本人の欠勤）', () => {
    const siteNames = Object.fromEntries(main.sites.map(s => [s.id, s.name]))
    const wb = generateMonthlyExcel({ ym: YM, workers: r.workers, subcons: [], siteNames, prescribedDays: 0 })
    const vn = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・ベトナム人'], { header: 1 }) as (string | number)[][]
    const h = vn[2] as string[]
    for (const c of ['枠内補償日(100%)', '試験日', '帰国日数', '保証枠', '本人の欠勤(欠)']) expect(h).toContain(c)
    const rowA = vn.find(x => x[0] === '新契約A')!
    expect(rowA[h.indexOf('枠内補償日(100%)')]).toBe(byId(201).compInGuaranteeDays || 0)
    expect(rowA[h.indexOf('休業手当')]).toBe(byId(201).compAllowance)
    expect(rowA[h.indexOf('追加所定手当')]).toBe(byId(201).additionalAllowance)
    const rowB = vn.find(x => x[0] === '新契約B（帰国）')!
    expect(rowB[h.indexOf('帰国日数')]).toBe(10)
    const sub = vn.find(x => x[0] === '小計')!
    expect(sub[h.indexOf('支給額合計')]).toBe((byId(201).salaryNetPay || 0) + (byId(202).salaryNetPay || 0))
    expect(vn.some(x => String(x[0]).startsWith('✓ 自動検算: 全員'))).toBe(true)
    // 日本人シート: 補償日列は 0.6 の日数、小計は出向者（🔁）も含む
    const jp = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・日本人'], { header: 1 }) as (string | number)[][]
    const hj = jp[2] as string[]
    const rowC = jp.find(x => x[0] === '日給C')!
    expect(rowC[hj.indexOf('補償日')]).toBe(1)
    expect(rowC[hj.indexOf('出勤日数')]).toBe(15.6)
    const rowD = jp.find(x => String(x[0]).includes('日給D（出向）'))!
    expect(String(rowD[0])).toContain('🔁')
    const subJ = jp.find(x => x[0] === '小計')!
    expect(subJ[hj.indexOf('支給額合計')]).toBe((byId(4).salaryNetPay || 0) + (byId(5).salaryNetPay || 0))
  })

  it('計算根拠の監査チェック: 全員「内訳合計＝支給額」が ✓。法定上限チェックは新ルールの外国人だけ', () => {
    for (const w of r.workers) {
      const checks = buildAuditChecks(w as unknown as PayrollAuditWorker, YM, 0)
      expect(checks.find(c => c.label === '支給額の内訳合計が一致')?.pass).toBe(true)
      expect(checks.some(c => c.label === '所定労働時間が法定上限以内')).toBe(w.visa !== 'none')
    }
  })

  it('出向者: 月次集計の原価では控除され、支給額は出向者を除いた合計＋出向者分で Excel の小計に一致', () => {
    const d = byId(5)
    expect(d.isDispatched).toBe(true)
    expect(d.dispatchDeduction).toBe(d.salaryNetPay)
    const site = r.sites.find(s => s.id === 'live')!
    expect(site.dispatchDeduction).toBe(d.salaryNetPay)
    const nonDispatched = r.workers.filter(w => !w.isDispatched && w.visa === 'none').reduce((s, w) => s + (w.salaryNetPay || 0), 0)
    expect(nonDispatched + (d.salaryNetPay || 0)).toBe((byId(4).salaryNetPay || 0) + (d.salaryNetPay || 0))
  })
})

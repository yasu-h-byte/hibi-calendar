import { describe, it, expect } from 'vitest'
import { generateOrgAttendance, generateMonthlyExcel } from '@/lib/export'
import type { WorkerMonthly } from '@/lib/compute'
import * as XLSX from 'xlsx'

/**
 * 2026-09-17: 9月分から日比建設・HFU とも給与計算をキャシュモに委託。
 * 両社の出面一覧が同じシート構成で出ること、日本人シートに欠勤控除の列が出て
 * 内訳の合計＝支給額合計が検算できることを保証する。
 */
const sites = [{ id: 'ihi', name: 'IHI' }]
const workers = [
  { id: 1, name: '日本 太郎', org: 'hibi', visa: 'none', job: 'tobi', rate: 15000, otMul: 1.25, hireDate: '2020-01-01' },
  { id: 101, name: 'グエン', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 0, hourlyRate: 2000, otMul: 1.25, hireDate: '2022-01-01' },
  { id: 201, name: 'ラップ', org: 'hfu', visa: 'jisshu2', job: 'tobi', rate: 0, hourlyRate: 1300, otMul: 1.25, hireDate: '2024-01-01', payrollNo: '1130' },
] as unknown as Parameters<typeof generateOrgAttendance>[0]['workers']
const attD = {
  'ihi_1_202609_1': { w: 1, o: 1 }, 'ihi_1_202609_2': { w: 1 },
  'ihi_101_202609_1': { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 },
  'ihi_201_202609_1': { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 },
} as Parameters<typeof generateOrgAttendance>[0]['attD']
const calendarDays = { ihi: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), 'work'])) }
const base = { ym: '202609', workers, attD, sites, assign: {}, massign: {}, calendarDays, baseDays: 20 }

describe('会社別 出面一覧（キャシュモ提出用・両社共通）', () => {
  it('日比建設・HFU で同じシート構成（出面一覧／勤務時間一覧／勤怠サマリー）', () => {
    const hibi = generateOrgAttendance(base, 'hibi')
    const hfu = generateOrgAttendance(base, 'hfu')
    expect(hibi.SheetNames).toEqual(['出面一覧', '勤務時間一覧', '勤怠サマリー'])
    expect(hfu.SheetNames).toEqual(hibi.SheetNames)
  })

  it('出面一覧にはその会社の全員（日本人含む）、勤務時間一覧は外国人だけ', () => {
    const hibi = generateOrgAttendance(base, 'hibi')
    const names = (XLSX.utils.sheet_to_json(hibi.Sheets['出面一覧'], { header: 1 }) as string[][]).map(r => r[0])
    expect(names).toContain('日本 太郎')
    expect(names).toContain('グエン')
    expect(names).not.toContain('ラップ')
    const time = XLSX.utils.sheet_to_json(hibi.Sheets['勤務時間一覧'], { header: 1 }) as string[][]
    expect(JSON.stringify(time)).toContain('グエン')
    expect(JSON.stringify(time)).not.toContain('日本 太郎')
    expect(time[0][0]).toContain('日比建設')
  })

  it('org の表記ゆれ（日比／HFU）も同じ会社として拾う', () => {
    const ws = workers.map(w => ({ ...w, org: w.org === 'hibi' ? '日比' : 'HFU' }))
    const hfu = generateOrgAttendance({ ...base, workers: ws }, 'hfu')
    const rows = XLSX.utils.sheet_to_json(hfu.Sheets['出面一覧'], { header: 1 }) as string[][]
    const names = rows.map(r => r[0])
    expect(names).toContain('ラップ')
    expect(names).not.toContain('グエン')
    // キャシュモの従業員番号は名前の隣の列
    expect(rows[1][1]).toBe('従業員番号')
    expect(rows.find(r => r[0] === 'ラップ')?.[1]).toBe('1130')
  })
})

describe('月次集計Excel 日本人シート（キャシュモ向けの内訳列）', () => {
  const jp = (over: Partial<WorkerMonthly>): WorkerMonthly => ({
    id: 1, name: '濱上', org: 'hibi', visa: 'none', job: 'tobi', rate: 0, salary: 250000, otMul: 1.25,
    sites: ['ihi'], workDays: 18, compDays: 0, plDays: 0, restDays: 2, actualWorkDays: 18,
    basePay: 250000, otAllowance: 0, paidLeaveAllowance: 0, legalHolidayAllowance: 0,
    absence: 2, absentDeduction: 24000, salaryNetPay: 226000,
    ...over,
  } as unknown as WorkerMonthly)

  it('202608〜: 補償日・欠勤日数・欠勤控除 の列があり、内訳合計＝支給額の検算が OK になる', () => {
    const wb = generateMonthlyExcel({ ym: '202609', workers: [jp({})], subcons: [], siteNames: { ihi: 'IHI' }, prescribedDays: 21 })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・日本人'], { header: 1 }) as (string | number)[][]
    const header = rows[2]
    expect(header).toContain('従業員番号')
    expect(header).toContain('補償日')
    expect(header).toContain('欠勤日数')
    expect(header).toContain('欠勤控除')
    const row = rows[3]
    expect(row[header.indexOf('欠勤控除')]).toBe(24000)
    expect(rows.some(r => String(r[0]).startsWith('✓ 自動検算'))).toBe(true)
  })

  it('内訳と支給額が合わない行は ⚠ で名指しする', () => {
    const wb = generateMonthlyExcel({ ym: '202609', workers: [jp({ salaryNetPay: 230000 })], subcons: [], siteNames: {}, prescribedDays: 21 })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・日本人'], { header: 1 }) as (string | number)[][]
    const warn = rows.find(r => String(r[0]).startsWith('⚠ 自動検算'))
    expect(String(warn?.[0])).toContain('濱上')
  })

  it('202607 以前は列構成を変えない（過去月の見え方を壊さない）', () => {
    const wb = generateMonthlyExcel({ ym: '202607', workers: [jp({ absence: 0, absentDeduction: 0, salaryNetPay: 250000 })], subcons: [], siteNames: {}, prescribedDays: 21 })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・日本人'], { header: 1 }) as (string | number)[][]
    expect(rows[2]).not.toContain('欠勤控除')
    expect(rows[2]).not.toContain('補償日')
  })
})

describe('月次集計Excel ベトナム人シート（202609〜 新旧統合）', () => {
  const vn = (over: Record<string, unknown>): WorkerMonthly => ({
    id: 101, name: 'グエン', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 0, hourlyRate: 2000, otMul: 1.25,
    sites: ['ihi'], workDays: 20, compDays: 0, plDays: 0, restDays: 0, actualWorkDays: 20, regularWorkDays: 20,
    workerPrescribedDays: 21, legalLimit: 171.4, actualWorkHours: 140, legalOtHours: 0,
    fixedBasePay: 280000, additionalAllowance: 0, paidLeaveAllowance: 0, nonStatutoryOTAllowance: 0, otAllowance: 0,
    legalHolidayAllowance: 0, nightAllowance: 0, compAllowance: 0, absence: 0, absentDeduction: 0, salaryNetPay: 280000,
    ...over,
  } as unknown as WorkerMonthly)
  const oldOne = vn({ id: 104, name: 'フン', useOldRules: true, payrollNo: '9999', salary: 396105, hourlyRate: 2830, prescribedHours: 161,
    basePay: 396105, fixedBasePay: undefined, additionalAllowance: 0, otAllowance: 29430, breakShortenAllowance: 17658,
    absentDeduction: 0, compBaseDeduction: 0, salaryNetPay: 443193 })

  it('202609: 新旧が1シート「日比建設・ベトナム人」に載り、(旧)シートは無い。契約列で区別', () => {
    const wb = generateMonthlyExcel({ ym: '202609', workers: [vn({}), oldOne], subcons: [], siteNames: { ihi: 'IHI' }, prescribedDays: 21 })
    expect(wb.SheetNames).toEqual(['日比建設・ベトナム人'])
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・ベトナム人'], { header: 1 }) as (string | number)[][]
    const h = rows[2]
    expect(h[1]).toBe('従業員番号'); expect(h[2]).toBe('契約')
    expect(rows[3][0]).toBe('グエン'); expect(rows[3][2]).toBe('新')
    expect(rows[4][0]).toBe('フン'); expect(rows[4][2]).toBe('旧')
    expect(rows[4][1]).toBe('9999')
    // 旧の残業は「残業手当(旧・1.25倍)」列、新の残業は「法定外残業手当」列
    expect(rows[4][h.indexOf('残業手当(旧・1.25倍)')]).toBe(29430)
    expect(rows[4][h.indexOf('法定外残業手当')]).toBeUndefined()
    expect(rows[4][h.indexOf('休憩短縮手当')]).toBe(17658)
    expect(rows[4][h.indexOf('支給額合計')]).toBe(443193)
    expect(rows.some(r => String(r[0]).startsWith('✓ 自動検算'))).toBe(true)
  })

  it('内訳が合わない行は ⚠ で名指し', () => {
    const wb = generateMonthlyExcel({ ym: '202609', workers: [vn({ salaryNetPay: 281000 })], subcons: [], siteNames: {}, prescribedDays: 21 })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['日比建設・ベトナム人'], { header: 1 }) as (string | number)[][]
    expect(String(rows.find(r => String(r[0]).startsWith('⚠ 自動検算'))?.[0])).toContain('グエン')
  })

  it('202608 以前は従来どおり 新・(旧) の2シート', () => {
    const wb = generateMonthlyExcel({ ym: '202608', workers: [vn({}), oldOne], subcons: [], siteNames: {}, prescribedDays: 21 })
    expect(wb.SheetNames).toEqual(['日比建設・ベトナム人', '日比建設・ベトナム人(旧)'])
  })
})

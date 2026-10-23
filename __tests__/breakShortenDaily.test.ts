import { describe, test, expect } from 'vitest'
import * as XLSX from 'xlsx-js-style'
import { computeMonthly } from '@/lib/compute-monthly'
import { type MainData } from '@/lib/compute'
import { generateActualHoursExcel } from '@/lib/export-labor'
import type { AttendanceEntry } from '@/types'

/**
 * 休憩短縮（旧契約の毎日20分）を日ごとに見せる（2026-10-23 代表: 帳票で毎日どう足されているか確かめられなかった）。
 * - 実労働時間明細の「休憩短縮(分)」列は、給与計算が数えた日と同じ日にだけ付く
 * - 計算根拠の式に使う日数・分・単価を給与計算が持つ
 */
const YM = '202610'
function main(): MainData {
  return {
    workers: [
      { id: 207, name: 'フォン', org: 'hfu', visa: 'jisshu1', job: 'tobi', rate: 8960, hourlyRate: 1280, salary: 215467, otMul: 1.25, hireDate: '2026-08-01', token: '', useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202608' },
      { id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25, hireDate: '2017-10-01', token: '', useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202608' },
    ],
    sites: [
      { id: 's', name: '現場A', start: '', end: '', foreman: 0, archived: false },
      { id: 't', name: '現場B', start: '', end: '', foreman: 0, archived: false },
    ],
    subcons: [], assign: { s: { workers: [207, 104], subcons: [] } }, massign: {}, billing: {}, workDays: { [YM]: 23 }, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}
function att(): Record<string, AttendanceEntry> {
  const a: Record<string, AttendanceEntry> = {}
  const e = (x: object) => x as unknown as AttendanceEntry
  for (const wid of [207, 104]) {
    for (const d of [1, 2, 3, 6, 7]) a[`s_${wid}_${YM}_${d}`] = e({ w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 })
    a[`t_${wid}_${YM}_7`] = e({ w: 0.5 })          // 同じ日に2現場 → 1日に数える
    a[`s_${wid}_${YM}_8`] = e({ p: 1 })            // 有給
    a[`s_${wid}_${YM}_9`] = e({ w: 0.6 })          // 現場都合休
    a[`s_${wid}_${YM}_10`] = e({ r: 1 })           // 休み
    a[`s_${wid}_${YM}_13`] = e({ hk: 1, w: 1 })    // 帰国中（w の残骸があっても付かない）
  }
  return a
}

function sheetRows(id: number): unknown[][] {
  const m = main()
  const wb = generateActualHoursExcel({ ym: YM, workers: m.workers, attD: att(), sites: m.sites, org: 'all' })
  const name = m.workers.find(w => w.id === id)!.name
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][]
}

describe('休憩短縮を日ごとに見せる', () => {
  test('実労働時間明細: 出勤した日だけ 20分。同じ日に2現場でも1回', () => {
    const rows = sheetRows(207)
    const header = rows.find(r => r[0] === '日')!
    const col = header.indexOf('休憩短縮(分)')
    expect(col).toBeGreaterThan(0)
    const days: number[] = []
    for (const r of rows) {
      if (typeof r[0] === 'number' && r[col] === 20) days.push(r[0])
    }
    expect(days).toEqual([1, 2, 3, 6, 7])
    const total = rows.find(r => r[2] === '休憩短縮 合計')!
    expect(total[col]).toBe('100分')
    expect(String(total[col + 1])).toContain('5日 × 20分 = 1時間40分')
  })

  test('明細の日数と給与計算の日数が同じ', () => {
    const w = computeMonthly(main(), att(), {}, YM, 23, undefined, 20).workers.find(x => x.id === 207)!
    expect(w.breakShortenDays).toBe(5)
    expect(w.breakShortenMinPerDay).toBe(20)
    expect(w.breakShortenHours).toBeCloseTo(100 / 60)
  })

  test('計算根拠の単価: フォン = 契約時給×1.25、フン = 日給÷6時間40分×1.25', () => {
    const ws = computeMonthly(main(), att(), {}, YM, 23, undefined, 20).workers
    const phong = ws.find(x => x.id === 207)!
    expect(phong.breakShortenUnitRate).toBe(1600)
    expect(phong.breakShortenUnitNote).toContain('契約時給')
    expect(phong.breakShortenAllowance).toBe(Math.ceil(1600 * 100 / 60))
    const hung = ws.find(x => x.id === 104)!
    expect(hung.breakShortenUnitRate).toBe(2943)
    expect(hung.breakShortenUnitNote).toContain('6時間40分')
  })

  test('休憩短縮の設定が無い人は列が空', () => {
    const m = main()
    m.workers[0] = { ...m.workers[0], breakShortenMin: undefined, breakShortenFrom: undefined } as MainData['workers'][number]
    const wb = generateActualHoursExcel({ ym: YM, workers: m.workers, attD: att(), sites: m.sites, org: 'all' })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['フォン'], { header: 1, defval: '' }) as unknown[][]
    const col = rows.find(r => r[0] === '日')!.indexOf('休憩短縮(分)')
    expect(rows.some(r => typeof r[0] === 'number' && r[col] !== '')).toBe(false)
    expect(rows.some(r => r[2] === '休憩短縮 合計')).toBe(false)
  })
})

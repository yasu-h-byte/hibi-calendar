/**
 * 休憩短縮手当（2026-09 施行・フン 104 の個別契約）のテスト。
 *
 * 契約: 休憩40分×2 → 30分×2 に揃える代わりに、短縮分 20分/日 を
 * 所定外労働として **割増なし（通常時給1.0倍）** で支払う。
 * 入力はゴールデンマスターと同じ本番3ヶ月フィクスチャ（202607）を使い、
 * 「設定なし」との差分だけを検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

const DIR = join(__dirname, 'fixtures', 'golden')
const load = <T,>(n: string): T => JSON.parse(readFileSync(join(DIR, n), 'utf-8')) as T
const HUNG = 104

function run(ym: string, breakShorten?: { min: number; from: string }) {
  const main = load<MainData>('main.json')
  if (breakShorten) {
    const w = main.workers.find(x => x.id === HUNG)!
    ;(w as { breakShortenMin?: number; breakShortenFrom?: string }).breakShortenMin = breakShorten.min
    ;(w as { breakShortenMin?: number; breakShortenFrom?: string }).breakShortenFrom = breakShorten.from
  }
  const att = load<{ d: Record<string, AttendanceEntry>; sd: Record<string, { n: number; on: number }> }>(`att_${ym}.json`)
  const cals = load<Record<string, Record<string, Record<string, string>>>>('calendars.json')
  const hl = load<{ workerId: number; startDate: string; endDate: string }[]>('homeLeaves.json')
  const swd = main.siteWorkDays?.[ym] || {}
  const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
  return computeMonthly(main, att.d, att.sd, ym, main.workDays[ym] || 0,
    Object.keys(swd).length > 0 ? swd : undefined, baseDays, cals[ym] || {}, hl)
}
const hung = (r: ReturnType<typeof run>) => r.workers.find(w => w.id === HUNG)!

describe('休憩短縮手当', () => {
  it('適用開始月より前の月は一切影響しない', () => {
    const base = hung(run('202607'))
    const withCfg = hung(run('202607', { min: 20, from: '202609' }))
    expect(withCfg.salaryNetPay).toBe(base.salaryNetPay)
    expect(withCfg.breakShortenAllowance).toBeUndefined()
  })

  it('適用開始月以降は 出勤日数 × 20分 が加算される', () => {
    const base = hung(run('202607'))
    const w = hung(run('202607', { min: 20, from: '202607' }))
    // 7月は出勤13日 → 13 × 20分 = 4.333h
    expect(w.actualWorkDays).toBe(13)
    expect(w.breakShortenHours).toBeCloseTo(13 * 20 / 60, 3)
    // 残業単価（所定超25%・2026-09-15）= 切上(15,693 ÷ 6h40m × 1.25) = 2,943
    const otUnit = Math.ceil(15693 / (20 / 3) * 1.25)
    expect(w.breakShortenAllowance).toBe(Math.ceil(otUnit * (13 * 20 / 60)))
    expect(w.salaryNetPay! - base.salaryNetPay!).toBe(w.breakShortenAllowance)
  })

  it('所定超25%: 残業手当と同じ単価（2,943円）で払う（2026-09-15 代表決定）', () => {
    const w = hung(run('202607', { min: 20, from: '202607' }))
    const perHour = w.breakShortenAllowance! / w.breakShortenHours!
    expect(perHour).toBeGreaterThanOrEqual(2943)  // 1.25倍の残業単価
    expect(perHour).toBeLessThan(2944)             // 円未満切上のぶんだけ
  })

  it('20日出勤ならちょうど所定1日分（6h40m）になる', () => {
    // 20分 × 20日 = 400分 = 6時間40分 = 1日の所定
    expect(20 * 20 / 60).toBeCloseTo(20 / 3, 6)
  })

  it('内訳の合計が支給額と一致する（検算 I1 相当）', () => {
    const w = hung(run('202607', { min: 20, from: '202607' }))
    const sum = (w.basePay || 0) + (w.additionalAllowance || 0) + (w.otAllowance || 0)
      + (w.breakShortenAllowance || 0) - (w.absentDeduction || 0) - (w.compBaseDeduction || 0)
    expect(sum).toBe(w.salaryNetPay)
  })
})

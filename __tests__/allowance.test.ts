/**
 * 遠方現場日当・運転手当のテスト。
 *
 * 実データ検証（2026-08-27・本番出面3ヶ月）で確認した数値をそのまま期待値に固定する。
 * 特に「0.6補償の日を対象に含めない」は、検証で実際に踏んだ間違い
 * （8月だけで33,000円過大）の再発防止。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dailyAllowanceYen, isAllowanceEligibleDay, tenureRateOn, fullMonthsBetween,
  calcMonthlyAllowances, DRIVE_ALLOWANCE_FROM_YM, SITE_ALLOWANCE_FROM_YM, DRIVE_ALLOWANCE_YEN, driveAllowanceYen,
} from '@/lib/allowance'
import type { AttendanceEntry } from '@/types'

const G = join(__dirname, 'fixtures', 'golden')
const att = (ym: string) => JSON.parse(readFileSync(join(G, `att_${ym}.json`), 'utf-8')).d as Record<string, AttendanceEntry>

describe('dailyAllowanceYen（80分超500円 / 120分超1,500円）', () => {
  it.each([
    [130, 1500], [121, 1500],
    [120, 500], [116, 500], [105, 500], [81, 500],
    [80, 0], [75, 0], [0, 0],
  ])('判定値%d分 → %d円', (min, yen) => {
    expect(dailyAllowanceYen(min)).toBe(yen)
  })

  it('未測定は0円（確定後に遡って支給する運用）', () => {
    expect(dailyAllowanceYen(undefined)).toBe(0)
    expect(dailyAllowanceYen(null)).toBe(0)
  })
})

describe('isAllowanceEligibleDay（現場に行った日か）', () => {
  const e = (o: Partial<AttendanceEntry>): AttendanceEntry => o as AttendanceEntry
  it('実働は対象・半日も対象', () => {
    expect(isAllowanceEligibleDay(e({ w: 1 }))).toBe(true)
    expect(isAllowanceEligibleDay(e({ w: 0.5 }))).toBe(true)
  })
  it('0.6補償は対象外（現場都合の休み＝行っていない）', () => {
    expect(isAllowanceEligibleDay(e({ w: 0.6 }))).toBe(false)
  })
  it('夜勤のみ（w=0）は対象', () => {
    expect(isAllowanceEligibleDay(e({ w: 0, ns: 1, nonly: 1 }))).toBe(true)
  })
  it('有給・休み・帰国・試験は対象外', () => {
    expect(isAllowanceEligibleDay(e({ p: 1 }))).toBe(false)
    expect(isAllowanceEligibleDay(e({ r: 1 }))).toBe(false)
    expect(isAllowanceEligibleDay(e({ hk: 1 }))).toBe(false)
    expect(isAllowanceEligibleDay(e({ exam: 1, w: 1 }))).toBe(false)
  })
})

describe('tenureRateOn（長期従事の逓減・起算日方式）', () => {
  it('起算から12ヶ月未満は全額', () => {
    expect(tenureRateOn(['2026-10-01'], '2027-09-30')).toBe(1)
  })
  it('満12ヶ月ちょうどから半額', () => {
    expect(tenureRateOn(['2026-10-01'], '2027-10-01')).toBe(0.5)
    expect(fullMonthsBetween('2026-10-01', '2027-10-01')).toBe(12)
  })
  it('満24ヶ月から不支給', () => {
    expect(tenureRateOn(['2026-10-01'], '2028-10-01')).toBe(0)
    expect(tenureRateOn(['2026-10-01'], '2028-09-30')).toBe(0.5)
  })
  it('30日以上の空白でリセット（次の対象日が新しい起算日）', () => {
    // 2026-10-01 起算 → 2027-06-01 まで従事 → 45日空白 → 2027-07-16 再開
    const dates = ['2026-10-01', '2027-06-01', '2027-07-16']
    // 再開後は 2027-07-16 起算なので、2028-07-15 まで全額
    expect(tenureRateOn(dates, '2028-07-01')).toBe(1)
    expect(tenureRateOn(dates, '2028-07-16')).toBe(0.5)
  })
  it('29日の空白ではリセットしない', () => {
    // 間隔は 28日・29日（30日未満）。起算は 2026-10-01 のまま動かない
    const dates = ['2026-10-01', '2026-10-29', '2026-11-27']
    expect(tenureRateOn(dates, '2027-10-01')).toBe(0.5)
  })

  it('31日の空白はリセットする（境界の確認）', () => {
    // 10-01 → 11-01 は31日差なので、起算が 11-01 に移る
    const dates = ['2026-10-01', '2026-11-01']
    expect(tenureRateOn(dates, '2027-10-15')).toBe(1)   // 11-01起算の11ヶ月半 → 全額
    expect(tenureRateOn(dates, '2027-11-01')).toBe(0.5)
  })
  it('政仁さんの実例（7/9→8/3 の25日空白）はリセットしない', () => {
    expect(tenureRateOn(['2026-10-09', '2026-11-03'], '2027-10-09')).toBe(0.5)
  })
  it('対象日が無ければ全額（初回）', () => {
    expect(tenureRateOn([], '2026-10-01')).toBe(1)
  })
})

describe('calcMonthlyAllowances（実データ3ヶ月の検証値と一致）', () => {
  // 検証時: IHI を 1,500円区分と仮定したときの実測合計
  const commutes1500 = { ihi: { judgedMin: 125 }, sasazuka: { judgedMin: 40 } }
  const YAKUIN = [0, 1]

  it.each([
    ['202606', 495000 - 25500],   // 検証値495,000 − 政仁さん17日分（役員除外を決定したため）
    ['202607', 514500 - 9000],    // 同 − 政仁さん6日分
    ['202608', 375000 - 9000],
  ])('%s: 日当合計 %d円（役員除外後）', (ym, expected) => {
    const r = calcMonthlyAllowances(att(ym), ym, commutes1500, {}, YAKUIN)
    const total = [...r.values()].reduce((s, v) => s + v.siteAllowanceYen, 0)
    expect(total).toBe(expected)
  })

  it('202606: ケンさんは22日 × 1,500円（検証値どおり）', () => {
    const r = calcMonthlyAllowances(att('202606'), '202606', commutes1500, {}, YAKUIN)
    const ken = r.get(107)!
    expect(ken.allowanceDays).toBe(22)
    expect(ken.siteAllowanceYen).toBe(33000)
    expect(ken.bySite.ihi.days).toBe(22)
  })

  it('役員（政仁さん）は日当の対象外', () => {
    const r = calcMonthlyAllowances(att('202606'), '202606', commutes1500, {}, YAKUIN)
    expect(r.get(1)).toBeUndefined()
  })

  it('笹塚（判定値40分）は0円のまま', () => {
    const r = calcMonthlyAllowances(att('202607'), '202607', commutes1500, {}, YAKUIN)
    for (const v of r.values()) expect(v.bySite.sasazuka).toBeUndefined()
  })

  it('適用開始月の定数: 運転手当は2026-10、日当は保留(null)', () => {
    // ゲートは loadMonthlyAllowances 側で適用する（純関数はどの月でも計算できる）
    expect(DRIVE_ALLOWANCE_FROM_YM).toBe('202610')
    expect(SITE_ALLOWANCE_FROM_YM).toBeNull()   // 2026-08-28 代表決定により日当は保留
  })

  it('運転手当: 全現場一律 片道1,000円・便ごとに積む・役員も対象', () => {
    expect(DRIVE_ALLOWANCE_YEN).toBe(1000)
    expect(driveAllowanceYen()).toBe(1000)

    const drv = {
      'ihi_202606_2': { am: [2, 5], pm: [2, 11] },   // 2台: 行き2名・帰り2名
      'ihi_202606_3': { am: [1], pm: [1] },           // 政仁さんが運転
    }
    const r = calcMonthlyAllowances(att('202606'), '202606', commutes1500, drv, YAKUIN)
    expect(r.get(2)!.driveLegs).toBe(2)
    expect(r.get(2)!.driveAllowanceYen).toBe(2000)   // 1,000円 × 2便
    expect(r.get(5)!.driveAllowanceYen).toBe(1000)
    expect(r.get(11)!.driveAllowanceYen).toBe(1000)
    expect(r.get(1)!.driveAllowanceYen).toBe(2000)   // 日当は対象外でも運転手当は労働の対価
    expect(r.get(1)!.siteAllowanceYen).toBe(0)
  })

  it('運転手当: 近い現場でも一律1,000円（判定値に依存しない）', () => {
    const near = { kinjo: { judgedMin: 20 } }        // 判定値20分の近距離現場
    const drv = { 'kinjo_202606_2': { am: [2], pm: [2] } }
    const r = calcMonthlyAllowances({}, '202606', near, drv, [])
    expect(r.get(2)!.driveAllowanceYen).toBe(2000)   // 1,000円 × 2便（旧仕様は500円×2=1,000）
  })

  it('日当が保留の間: 判定値を渡さなければ日当0円・運転手当だけ出る', () => {
    // loadMonthlyAllowances は日当オフのとき commutes を空で渡す（=この状態）
    const drv = { 'ihi_202606_2': { am: [2], pm: [2] } }
    const r = calcMonthlyAllowances(att('202606'), '202606', {}, drv, YAKUIN)
    for (const v of r.values()) {
      expect(v.siteAllowanceYen).toBe(0)
      expect(v.allowanceDays).toBe(0)
    }
    expect(r.get(2)!.driveAllowanceYen).toBe(2000)
  })

  it('長期従事の履歴を渡すと逓減が効く', () => {
    // ケンさんのIHIを「13ヶ月前から従事」とすると全日半額
    // 2025-05-01 から28日おきに連続従事（30日空白なし）→ 起算は2025-05-01のまま、2026-06は13ヶ月目
    const cont: string[] = []
    {
      let d = new Date(Date.UTC(2025, 4, 1))
      while (d < new Date(Date.UTC(2026, 5, 1))) {
        cont.push(d.toISOString().slice(0, 10))
        d = new Date(d.getTime() + 28 * 86400000)
      }
    }
    const hist = { '107_ihi': [...cont, ...Array.from({ length: 22 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`)] }
    const r = calcMonthlyAllowances(att('202606'), '202606', commutes1500, {}, YAKUIN, hist)
    expect(r.get(107)!.siteAllowanceYen).toBe(Math.round(33000 * 0.5))
  })
})

/**
 * 月次給与計算（computeMonthly）の検証テスト
 *
 * 1ヶ月単位変形労働時間制 + 各雇用区分（日給/月給/時給）の
 * 計算ロジックが法令準拠で正しく行われているかを担保する。
 *
 * テストケースは「労基法上の典型シナリオ」を網羅:
 *   - 日給制日本人 (補償あり/なし)
 *   - 月給制日本人 (基本給固定 + 残業)
 *   - 時給制ベトナム人 (新ルール / 旧ルール)
 *   - 月給制ベトナム人 (salary 方式)
 *   - 月途中入社・退職
 *   - 全期間帰国
 *   - 法定上限超過の検出
 *   - 出向控除
 *
 * 検証戦略:
 *   - 与えられた入力に対する出力値を手計算で求め、それと一致するか確認
 *   - 計算式は仕様書 (docs/salary-calculation.md) を真の元とする
 */
import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

// ─────────────────────────────────────────────────────────────
// ヘルパー: 最小のテスト用 MainData / Attendance を生成
// ─────────────────────────────────────────────────────────────

function buildMain(overrides: Partial<MainData>): MainData {
  return {
    workers: [],
    sites: [{ id: 'site1', name: '現場1', start: '', end: '', foreman: 0, archived: false }],
    subcons: [],
    assign: { site1: { workers: [], subcons: [] } },
    massign: {},
    billing: {},
    workDays: {},
    siteWorkDays: {},
    locks: {},
    plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 },
    mforeman: {},
    ...overrides,
  } as MainData
}

/** att.d のキー: `${siteId}_${workerId}_${ym}_${day}` */
function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${day}`
}

/** 1日分の出勤エントリ生成 */
function dayWork(siteId: string, workerId: number, ym: string, day: number, w: number = 1, o: number = 0): Record<string, { w: number; o?: number }> {
  return { [attKey(siteId, workerId, ym, day)]: { w, ...(o > 0 ? { o } : {}) } }
}

/** 1日分の有給エントリ生成 */
function dayPL(siteId: string, workerId: number, ym: string, day: number) {
  return { [attKey(siteId, workerId, ym, day)]: { w: 0, p: 1 } }
}

// ─────────────────────────────────────────────────────────────
// テスト本体
// ─────────────────────────────────────────────────────────────

describe('computeMonthly - 日給制日本人', () => {
  test('出勤20日・残業0h・補償なし → 基本給 = 日額×20', () => {
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 4, '202604', d))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.workDays).toBe(20)
    expect(w.basePay).toBe(17655 * 20)  // 353100
    expect(w.otAllowance).toBe(0)
    expect(w.salaryNetPay).toBe(353100)
  })

  test('同日2現場の有給は1日として数える（plUsed 二重カウント防止）', () => {
    // 回帰防止: C8修正で actualWorkDays は日単位デデュープされたが、p/exam/w=0.6 は
    //   エントリ単位のままだった。同日2現場に有給があると plUsed=2 となり、
    //   有給手当の過払い・欠勤控除の漏れが発生していた。
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] }, site2: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 19; d++) Object.assign(attD, dayWork('site1', 4, '202604', d))
    // 20日目: 同じ日に2現場とも有給
    Object.assign(attD, dayPL('site1', 4, '202604', 20))
    Object.assign(attD, dayPL('site2', 4, '202604', 20))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.plUsed).toBe(1)        // 2現場でも1日
    expect(w.paidLeaveDays).toBe(1) // 有給手当も1日分
  })

  test('出勤20日・残業10h → 残業手当 = (日額/8) × otMul × 10h', () => {
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 4, '202604', d, 1, d === 1 ? 10 : 0))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.otHours).toBe(10)
    // 残業代は「1円未満切り上げ」: 残業単価=ceil(17655/8×1.25)=ceil(2758.59)=2759、残業代=ceil(2759×10)=27590
    const otUnit = Math.ceil((17655 / 8) * 1.25)
    expect(w.otAllowance).toBe(Math.ceil(otUnit * 10))
    expect(w.otAllowance).toBe(27590)
    expect(w.basePay).toBe(17655 * 20)
  })

  test('残業代は1円未満を切り上げ（四捨五入ではない）', () => {
    const main = buildMain({
      workers: [{
        id: 5, name: '倉本隆次', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 19100, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [5], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 5, '202604', d, 1, d === 1 ? 1 : 0))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 5)!
    // 残業単価 = 19100/8 × 1.25 = 2984.375 → 切り上げ 2985（四捨五入なら 2984）
    expect(w.otAllowance).toBe(2985)
    expect(w.otAllowance).not.toBe(Math.round((19100 / 8) * 1.25 * 1)) // 2984 ではない
  })

  test('日本人 w=0.6 → 半日勤務として workDays に 0.6 加算 (compDays は外国人限定)', () => {
    // 仕様: 補償(compDays) 概念は外国人のみ。日本人の w=0.6 は単なる半日勤務扱い。
    //   workDays += 0.6、 actualWorkDays += 1 (普通の出勤としてカウント)
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 19; d++) Object.assign(attD, dayWork('site1', 4, '202604', d))
    Object.assign(attD, { [attKey('site1', 4, '202604', 20)]: { w: 0.6 } })

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.compDays).toBe(0)  // 日本人は 0
    expect(w.workDays).toBeCloseTo(19.6, 1)
    // 基本給 = round(19.6 × 17655) = 346038
    expect(w.basePay).toBe(Math.round(19.6 * 17655))
  })

  test('外国人 w=0.6 → compDays が +1、基本給は通常分のみ計上', () => {
    // 仕様: 外国人の補償(0.6)は会社都合休業の象徴 → workDays には含めず compDays でカウント
    //   別途 compAllowance として時給×7h×0.6 が支給される (新ルール) or 旧ルールでは別計算
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 19; d++) Object.assign(attD, dayWork('site1', 101, '202604', d))
    Object.assign(attD, { [attKey('site1', 101, '202604', 20)]: { w: 0.6 } })

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.compDays).toBe(1)  // 外国人なので 1
    expect(w.actualWorkDays).toBe(19)  // 補償は実出勤に含めない
  })
})

describe('computeMonthly - 月給制日本人 (Phase G で追加)', () => {
  test('月給制スタッフ・出勤日数に関わらず基本給は月給値', () => {
    const main = buildMain({
      workers: [{
        id: 12, name: '濱上祥太郎', org: 'hibi', visa: 'none', job: 'tobi_apprentice',
        rate: 0, salary: 235000, otMul: 1.25, hireDate: '2026-06-01', token: '',
      }],
      assign: { site1: { workers: [12], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 15日出勤 (5日欠勤相当だが月給制なので影響なし)
    for (let d = 1; d <= 15; d++) Object.assign(attD, dayWork('site1', 12, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 12)!
    expect(w.basePay).toBe(235000)
    expect(w.salaryNetPay).toBe(235000)

    // 入社前（2026年5月）は月次集計に出さない（完全月給でも入社月より前は対象外）
    const mayResult = computeMonthly(main, {}, {}, '202605', 23)
    expect(mayResult.workers.find(x => x.id === 12)).toBeUndefined()
    // GAP2: 完全月給の原価＝固定給（15日出勤でも 15×(235000/20)=176250 ではなく 235000）
    expect(w.totalCost).toBe(235000)
    // 固定給が現場原価に全額計上される（出勤日数比の概算ではない）
    const site = result.sites.find(s => s.id === 'site1')!
    expect(site.cost).toBe(235000)
  })

  test('GAP2: 完全月給を複数現場で勤務 → 固定給を出勤日数比で配賦（合計=月給）', () => {
    const main = buildMain({
      workers: [{
        id: 12, name: '濱上祥太郎', org: 'hibi', visa: 'none', job: 'tobi_apprentice',
        rate: 0, salary: 200000, otMul: 1.25, hireDate: '2026-06-01', token: '',
      }],
      sites: [
        { id: 'siteA', name: '現場A', start: '', end: '', foreman: 0, archived: false },
        { id: 'siteB', name: '現場B', start: '', end: '', foreman: 0, archived: false },
      ],
      assign: {
        siteA: { workers: [12], subcons: [] },
        siteB: { workers: [12], subcons: [] },
      },
      siteWorkDays: { '202606': { siteA: 20, siteB: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // siteA 12日 / siteB 8日 = 計20日
    for (let d = 1; d <= 12; d++) Object.assign(attD, dayWork('siteA', 12, '202606', d))
    for (let d = 13; d <= 20; d++) Object.assign(attD, dayWork('siteB', 12, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 12)!
    expect(w.totalCost).toBe(200000)
    const siteA = result.sites.find(s => s.id === 'siteA')!
    const siteB = result.sites.find(s => s.id === 'siteB')!
    // 12:8 の比で配賦、合計は固定給に一致
    expect(siteA.cost + siteB.cost).toBe(200000)
    expect(siteA.cost).toBe(Math.round(200000 * 12 / 20)) // 120000
  })

  test('月給制 + 残業10h → 残業手当 = (月給/月所定h) × otMul × 10h', () => {
    const main = buildMain({
      workers: [{
        id: 12, name: '濱上祥太郎', org: 'hibi', visa: 'none', job: 'tobi_apprentice',
        rate: 0, salary: 240000, otMul: 1.25, hireDate: '2026-06-01', token: '',
      }],
      assign: { site1: { workers: [12], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 12, '202606', d, 1, d === 1 ? 10 : 0))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 12)!
    expect(w.basePay).toBe(240000)
    // 月所定 = 20日 × 8h = 160h
    // 時給換算 = 240000 / 160 = 1500
    // 残業 = round(1500 × 1.25 × 10) = 18750
    expect(w.otAllowance).toBe(18750)
    expect(w.salaryNetPay).toBe(240000 + 18750)
  })

  test('完全月給: 月途中入社は在籍日数で日割り、残業単価は按分前ベース（監査C5）', () => {
    const main = buildMain({
      workers: [{
        id: 12, name: '濱上祥太郎', org: 'hibi', visa: 'none', job: 'tobi_apprentice',
        rate: 0, salary: 240000, otMul: 1.25, hireDate: '2026-06-16', token: '',
      }],
      assign: { site1: { workers: [12], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 6/16〜6/30 のうち10日出勤、1日に残業4h
    for (let d = 16; d <= 25; d++) Object.assign(attD, dayWork('site1', 12, '202606', d, 1, d === 16 ? 4 : 0))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 12)!
    // 在籍 6/16〜6/30 = 15日 / 暦30日 → ratio 0.5
    // 基本給 = 切上(240,000 × 0.5) = 120,000
    expect(w.basePay).toBe(120000)
    // 残業単価は按分前の月所定(20日×8h=160h)ベース: 240,000/160=1,500 → 単価 ceil(1,500×1.25)=1,875
    expect(w.otAllowance).toBe(1875 * 4)
    expect(w.salaryNetPay).toBe(120000 + 7500)
  })
})

describe('computeMonthly - 時給制ベトナム人 (旧ルール ~ 2026/4)', () => {
  test('旧ルール: 出勤20日 + 残業10h → 基本給は時給×月所定時間', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 101, '202604', d, 1, d === 1 ? 10 : 0))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.otHours).toBe(10)
    // 旧ルール: 1日あたり 20/3 ≈ 6.667h、月所定 = 20 × 6.667 = 133.33h
    // 基本給 = round(1500 × 133.33) ≈ 200000
    expect(w.prescribedHours).toBeCloseTo(133.33, 0)
    expect(w.basePay).toBe(200000)
    // 残業 = round(1500 × 1.25 × 10) = 18750
    expect(w.otAllowance).toBe(18750)
  })

  test('固定月給(salary)が設定された旧ルール外国人は、基本給=月給固定（所定日数で変動しない・フン問題）', () => {
    // フン(104)を再現: 旧ルール継続 + 固定月給。時給も持つが salary が優先。
    const mk = (ym: string, prescribed: number, siteDays: number) => {
      const main = buildMain({
        workers: [{
          id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi',
          rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25,
          hireDate: '2017-10-01', token: 'h', useOldRules: true,
        }],
        assign: { site1: { workers: [104], subcons: [] } },
        siteWorkDays: { [ym]: { site1: siteDays } },
      })
      const attD: Record<string, { w: number; o?: number }> = {}
      for (let d = 1; d <= prescribed; d++) Object.assign(attD, dayWork('site1', 104, ym, d))
      return computeMonthly(main, attD, {}, ym, prescribed)
    }
    // 所定が異なる2か月でも基本給は同じ固定額
    const may = mk('202605', 23, 23).workers.find(x => x.id === 104)!
    const jun = mk('202606', 24, 24).workers.find(x => x.id === 104)!
    expect(may.basePay).toBe(396105)
    expect(jun.basePay).toBe(396105)
    // フル出勤（欠勤なし・残業なし）なら支給額も月給固定そのもの
    expect(may.salaryNetPay).toBe(396105)
    expect(jun.salaryNetPay).toBe(396105)
  })

  test('固定月給の残業単価は日給ベースで固定（月給からの逆算ではない・フン2,943円問題）', () => {
    // 残業10h・欠勤2日を含めて、残業単価=日給÷6h40m×1.25 固定、欠勤=日給×日数 を検証
    const mk = (ym: string, prescribed: number) => {
      const main = buildMain({
        workers: [{
          id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi',
          rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25,
          hireDate: '2017-10-01', token: 'h', useOldRules: true,
        }],
        assign: { site1: { workers: [104], subcons: [] } },
        siteWorkDays: { [ym]: { site1: prescribed } },
      })
      const attD: Record<string, { w: number; o?: number }> = {}
      // (prescribed-2)日出勤・うち1日10h残業・2日欠勤
      for (let d = 1; d <= prescribed - 2; d++) Object.assign(attD, dayWork('site1', 104, ym, d, 1, d === 1 ? 10 : 0))
      return computeMonthly(main, attD, {}, ym, prescribed).workers.find(x => x.id === 104)!
    }
    const expectedOtUnit = Math.ceil(Math.round((15693 / (20 / 3)) * 1.25 * 100) / 100) // = 2943
    expect(expectedOtUnit).toBe(2943)
    for (const [ym, pd] of [['202605', 23], ['202606', 26]] as const) {
      const w = mk(ym, pd)
      expect(w.basePay).toBe(396105)               // 基本給は固定
      expect(w.otHours).toBe(10)
      // 残業手当 = 切上(2,943 × 10) = 29,430（所定日数に関係なく単価固定）
      expect(w.otAllowance).toBe(Math.ceil(Math.round(expectedOtUnit * 10 * 100) / 100))
      expect(w.otAllowance).toBe(29430)
      // 欠勤控除 = 日給15,693 × 2日（所定日数に関係なく日給ベース）
      expect(w.absence).toBe(2)
      expect(w.absentDeduction).toBe(15693 * 2)
    }
  })

  test('固定月給: 会社都合休(0.6補)は欠勤日数に含めず、補償日控除＋休業補償で正味60%支給（フン土曜休み）', () => {
    // 5月: 所定23日のうち 20日出勤・2日欠勤・1日(18日)を会社都合休(w=0.6)
    const main = buildMain({
      workers: [{
        id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25,
        hireDate: '2017-10-01', token: 'h', useOldRules: true,
      }],
      assign: { site1: { workers: [104], subcons: [] } },
      siteWorkDays: { '202605': { site1: 23 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    let worked = 0
    for (let d = 1; d <= 23 && worked < 20; d++) {
      if (d === 18) continue
      Object.assign(attD, dayWork('site1', 104, '202605', d))
      worked++
    }
    Object.assign(attD, dayWork('site1', 104, '202605', 18, 0.6))  // 会社都合休

    const w = computeMonthly(main, attD, {}, '202605', 23).workers.find(x => x.id === 104)!
    expect(w.compDays).toBe(1)
    // 欠勤日数は「無給の欠勤」だけ＝2日（補償日は含めない）
    expect(w.absence).toBe(2)
    // 欠勤控除 = 日給15,693 × 2日（補償日を含まない）
    expect(w.absentDeduction).toBe(15693 * 2)
    // 補償日 通常分控除 = 日給15,693 × 1日（固定給は満額前提のため一旦控除）
    expect(w.compBaseDeduction).toBe(15693)
    // 休業補償 = 日給15,693 × 60% × 1日（切上）
    expect(w.additionalAllowance).toBe(Math.ceil(15693 * 0.6))  // = 9416
    // 支給額 = 396,105 + 9,416 − 31,386 − 15,693（補償日は正味60%支給＝日給の40%控除）
    expect(w.salaryNetPay).toBe(396105 + 9416 - 15693 * 2 - 15693)
    expect(w.salaryNetPay).toBe(358442)
    // 補償日を会社都合休にすると、単なる欠勤(60%なし)より日給の60%=9,416円多い
    // （= 補償日の休業補償分。資料の支給額もこの値に連動する）
  })

  test('固定月給: 月途中退職は在籍日数で日割り（監査C5）', () => {
    const main = buildMain({
      workers: [{
        id: 104, name: 'フン', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 15693, hourlyRate: 2403, salary: 396105, otMul: 1.25,
        hireDate: '2017-10-01', retired: '2026-06-15', token: 'h', useOldRules: true,
      }],
      assign: { site1: { workers: [104], subcons: [] } },
      siteWorkDays: { '202606': { site1: 26 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 6/1〜6/13 のうち12日出勤（日曜7を除く）、1日に残業2h
    for (let d = 1; d <= 13; d++) {
      if (d === 7) continue
      Object.assign(attD, dayWork('site1', 104, '202606', d, 1, d === 1 ? 2 : 0))
    }

    const result = computeMonthly(main, attD, {}, '202606', 26)
    const w = result.workers.find(x => x.id === 104)!
    // 在籍 6/1〜6/15 = 15日 / 暦30日 → ratio 0.5
    // 基本給 = 切上(396,105 × 0.5) = 198,053
    expect(w.basePay).toBe(198053)
    // 残業単価は日給ベースで固定 2,943（按分の影響なし）
    expect(w.otAllowance).toBe(2943 * 2)
    // 所定は按分: round(26×0.5)=13日 → 出勤12日で欠勤1日 = 15,693
    expect(w.absence).toBe(1)
    expect(w.absentDeduction).toBe(15693)
    expect(w.salaryNetPay).toBe(198053 + 5886 - 15693)
  })
})

describe('computeMonthly - 時給制ベトナム人 (新ルール 2026/5~)', () => {
  test('変形労働: 週6日×7h=42h（事前所定）の週は週次の法定外残業ゼロ（週所定ベース判定）', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人C', org: 'hfu', visa: 'jisshu2', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'xyz',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202606': { site1: 24 } },
    })
    // 2026年6月1日(月)〜6日(土) = 同一週、各7時間（週42時間）
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 6; d++) Object.assign(attD, dayWork('site1', 101, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 24, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 週所定42hが事前設定されているため、週次の法定外残業は0（旧 flat-40h では 2h 計上されていた）
    expect(w.legalOtHours).toBe(0)
  })

  test('有給日給: 20日以上働いて有給を取った人は、20日枠超の有給を別途支給（月給制維持・ハウ問題）', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人D', org: 'hfu', visa: 'jisshu3', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'p1',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202606': { site1: 26 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    // 22日出勤（日曜7,14,21を避ける）+ 有給1日
    const workDays = [1,2,3,4,5,6, 8,9,10,11,12,13, 15,16,17,18,19,20, 22,23,24,25]
    for (const d of workDays) Object.assign(attD, dayWork('site1', 101, '202606', d))
    Object.assign(attD, dayPL('site1', 101, '202606', 26))

    const result = computeMonthly(main, attD, {}, '202606', 26, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.regularWorkDays).toBe(22)
    expect(w.plUsed).toBe(1)
    // 20日枠を出勤で超えているため、有給1日は有給日給として別途支給（旧: 未払い）
    expect(w.paidLeaveDays).toBe(1)
    expect(w.paidLeaveAllowance).toBe(Math.ceil(1500 * 1 * 7)) // 10,500
    // 支給額に有給日給が含まれる
    const sum = (w.fixedBasePay || 0) + (w.additionalAllowance || 0) + (w.paidLeaveAllowance || 0)
      + (w.nonStatutoryOTAllowance || 0) + (w.otAllowance || 0)
      + (w.legalHolidayAllowance || 0) + (w.nightAllowance || 0) + (w.compAllowance || 0)
      - (w.absentDeduction || 0)
    expect(w.salaryNetPay).toBe(sum)
  })

  test('有給日給: 20日未満の出勤で有給を取った人は、有給は基本給20日枠に内包（別途支給なし）', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人E', org: 'hfu', visa: 'jisshu2', job: 'tobi',
        rate: 0, hourlyRate: 1425, otMul: 1.25, hireDate: '2025-01-01', token: 'p2',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    // 18日出勤 + 有給2日 = 20日（基本給枠内）
    const workDays = [1,2,3,4,5,6, 8,9,10,11,12,13, 15,16,17,18]
    for (const d of workDays) Object.assign(attD, dayWork('site1', 101, '202606', d))
    Object.assign(attD, dayPL('site1', 101, '202606', 19))
    Object.assign(attD, dayPL('site1', 101, '202606', 20))

    const result = computeMonthly(main, attD, {}, '202606', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.plUsed).toBe(2)
    // 有給2日が20日枠を埋めるため、有給日給は0（基本給に内包）
    expect(w.paidLeaveDays).toBe(0)
    expect(w.paidLeaveAllowance).toBe(0)
    // 基本給は20日固定（月給制維持）
    expect(w.fixedBasePay).toBe(1425 * 20 * 7)
  })

  test('有給日給: 月給(salary)方式の新ルール外国人でも20日枠超の有給が別途支給される（監査C1）', () => {
    // salary方式ブランチは salaryNet を手組みしており、有給日給の加算が漏れていた
    const main = buildMain({
      workers: [{
        id: 108, name: 'ベトナム人F月給', org: 'hfu', visa: 'jisshu3', job: 'tobi',
        rate: 0, hourlyRate: 0, salary: 210000, otMul: 1.25, hireDate: '2025-01-01', token: 'p3',
      }],
      assign: { site1: { workers: [108], subcons: [] } },
      siteWorkDays: { '202606': { site1: 26 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    // 時給ブランチの既存テストと同じ勤務パターン: 22日出勤 + 有給1日
    const workDays = [1,2,3,4,5,6, 8,9,10,11,12,13, 15,16,17,18,19,20, 22,23,24,25]
    for (const d of workDays) Object.assign(attD, dayWork('site1', 108, '202606', d))
    Object.assign(attD, dayPL('site1', 108, '202606', 26))

    const result = computeMonthly(main, attD, {}, '202606', 26, undefined, 20)
    const w = result.workers.find(x => x.id === 108)!
    // 時給換算 = 210,000 ÷ (20日×7h) = 1,500
    expect(w.fixedBasePay).toBe(210000)
    expect(w.paidLeaveDays).toBe(1)
    expect(w.paidLeaveAllowance).toBe(1500 * 1 * 7)  // 10,500（旧: 加算漏れで未払い）
    // 支給額に有給日給が含まれる（内訳和と一致）
    const sum = (w.fixedBasePay || 0) + (w.additionalAllowance || 0) + (w.paidLeaveAllowance || 0)
      + (w.nonStatutoryOTAllowance || 0) + (w.otAllowance || 0)
      + (w.legalHolidayAllowance || 0) + (w.nightAllowance || 0) + (w.compAllowance || 0)
      - (w.absentDeduction || 0)
    expect(w.salaryNetPay).toBe(sum)
  })

  test('新ルール: 基本給 = 時給 × baseDays × 7h', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 新ルール 3層構造: 基本給 = 1500 × 20 × 7 = 210000
    expect(w.fixedBasePay).toBe(210000)
    expect(w.prescribedHours).toBe(140)  // 20 × 7
    // 原価＝実支給額に統一: totalCost = salaryNetPay（旧: 日数×日額+残業概算ではない）
    expect(w.totalCost).toBe(w.salaryNetPay)
    // 単一現場なら site.cost = 支給額
    const site = result.sites.find(s => s.id === 'site1')!
    expect(site.cost).toBe(w.salaryNetPay)
  })

  test('原価＝実支給額: 残業ありでも totalCost = salaryNetPay（日額×日数概算ではない）', () => {
    const main = buildMain({
      workers: [{
        id: 102, name: 'ベトナム人B', org: 'hibi', visa: 'tokutei2', job: 'tobi',
        rate: 16727, hourlyRate: 2509, otMul: 1.25, hireDate: '2025-01-01', token: 'def',
      }],
      assign: { site1: { workers: [102], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 102, '202605', d, 1, d <= 10 ? 1 : 0))

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 102)!
    // 概算労務費の旧式（日数×日額+残業概算）ではなく、実際の支給額に一致する
    expect(w.totalCost).toBe(w.salaryNetPay)
    const site = result.sites.find(s => s.id === 'site1')!
    expect(site.cost).toBe(w.salaryNetPay)
  })
})

describe('computeMonthly - 退職月のスタッフ', () => {
  test('6/30 退職予定者は6月の集計に含まれる', () => {
    const main = buildMain({
      workers: [{
        id: 204, name: 'ルオン', org: 'hfu', visa: 'jisshu2', job: 'tobi',
        rate: 0, hourlyRate: 1425, otMul: 1.25, hireDate: '2023-10-23',
        retired: '2026-06-30', token: 'xxx',
      }],
      assign: { site1: { workers: [204], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 204, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 204)
    expect(w).toBeDefined()  // 含まれていること
    expect(w!.workDays).toBe(20)
  })

  test('6/30 退職予定者は7月の集計から除外', () => {
    const main = buildMain({
      workers: [{
        id: 204, name: 'ルオン', org: 'hfu', visa: 'jisshu2', job: 'tobi',
        rate: 0, hourlyRate: 1425, otMul: 1.25, hireDate: '2023-10-23',
        retired: '2026-06-30', token: 'xxx',
      }],
      assign: { site1: { workers: [204], subcons: [] } },
      siteWorkDays: { '202607': { site1: 20 } },
    })
    const result = computeMonthly(main, {}, {}, '202607', 20)
    const w = result.workers.find(x => x.id === 204)
    // workers list には含まれるが、workDays==0 なら最終的に表示フィルタで除外される
    // computeMonthly の出力では含まれない（フィルタ済み）
    expect(w).toBeUndefined()
  })

  test('既に退職済 (2/28) のスタッフは6月の集計に含まれない', () => {
    const main = buildMain({
      workers: [{
        id: 108, name: 'クアン', org: 'hibi', visa: 'jisshu', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2023-05-14',
        retired: '2026-02-28', token: 'xxx',
      }],
      assign: { site1: { workers: [108], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const result = computeMonthly(main, {}, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 108)
    expect(w).toBeUndefined()
  })
})

describe('computeMonthly - 有給日', () => {
  test('有給日は workDays に含めないが plUsed にカウント', () => {
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number; p?: number }> = {}
    // 19日出勤 + 1日有給
    for (let d = 1; d <= 19; d++) Object.assign(attD, dayWork('site1', 4, '202604', d))
    Object.assign(attD, dayPL('site1', 4, '202604', 20))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.workDays).toBe(19)
    expect(w.plUsed).toBe(1)
    // 日給制日本人: 基本給 = 19日 × 17655 (有給は別途)
    expect(w.basePay).toBe(19 * 17655)
    // 2026-06 追加: 日給月給は有給日も日給を加算して支給（有給手当 = 有給日数 × 日額）
    expect(w.paidLeaveDays).toBe(1)
    expect(w.paidLeaveAllowance).toBe(1 * 17655)
    // 支給額 = 基本給 + 有給手当（残業なし）
    expect(w.salaryNetPay).toBe(19 * 17655 + 1 * 17655)
    expect(w.netPay).toBe(19 * 17655 + 1 * 17655)
  })

  test('日給月給: 有給を複数日取った場合、有給日数 × 日額 が支給額に加算される', () => {
    const main = buildMain({
      workers: [{
        id: 2, name: '白戸', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 21300, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [2], subcons: [] } },
      siteWorkDays: { '202605': { site1: 24 } },
    })
    const attD: Record<string, { w: number; o?: number; p?: number }> = {}
    // 20日出勤 + 4日有給（5月の実データを再現）
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 2, '202605', d))
    for (const d of [21, 22, 23, 24]) Object.assign(attD, dayPL('site1', 2, '202605', d))

    const result = computeMonthly(main, attD, {}, '202605', 24)
    const w = result.workers.find(x => x.id === 2)!
    expect(w.workDays).toBe(20)
    expect(w.plUsed).toBe(4)
    expect(w.paidLeaveDays).toBe(4)
    // 有給手当 = 4日 × 21,300 = 85,200（旧: 未払いだった）
    expect(w.paidLeaveAllowance).toBe(4 * 21300)
    // 支給額 = 基本給(20日×21,300) + 有給手当(4日×21,300)
    expect(w.salaryNetPay).toBe(20 * 21300 + 4 * 21300)
    expect(w.netPay).toBe(20 * 21300 + 4 * 21300)
  })
})

describe('computeMonthly - 出向控除', () => {
  test('出向中のスタッフは dispatchDeduction が設定される', () => {
    const main = buildMain({
      workers: [{
        id: 3, name: '大川愛志', org: 'hibi', visa: 'none', job: 'shokucho',
        rate: 23550, otMul: 1.25, hireDate: '',
        dispatchTo: '山岡建設工業', dispatchFrom: '2025-10', token: '',
      }],
      assign: { site1: { workers: [3], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 3, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 3)!
    expect(w.isDispatched).toBe(true)
    expect(w.dispatchDeduction).toBeGreaterThan(0)
    expect(w.dispatchDeduction).toBe(w.totalCost)  // 全人件費が控除対象
  })
})

describe('computeMonthly - 集計整合性チェック', () => {
  test('基本給 + 残業手当 = 支給額 (日給制日本人・残業のみ)', () => {
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 17655, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 4, '202604', d, 1, d === 1 ? 5 : 0))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const w = result.workers.find(x => x.id === 4)!
    // 支給額 = 基本給 + 残業手当
    const expected = (w.basePay || 0) + (w.otAllowance || 0)
    expect(w.salaryNetPay).toBe(expected)
  })

  test('日給月給: netPay・労務費(totalCost)が支給額(salaryNetPay)と一致する（監査C4）', () => {
    // 旧: totalCost が丸め前 float の残業原価を含み、salaryNetPay と数円ズレていた
    const main = buildMain({
      workers: [{
        id: 4, name: '本田文人', org: 'hibi', visa: 'none', job: 'tobi',
        rate: 19100, otMul: 1.25, hireDate: '', token: '',
      }],
      assign: { site1: { workers: [4], subcons: [] } },
      siteWorkDays: { '202605': { site1: 24 } },
    })
    const attD: Record<string, AttendanceEntry> = {}
    // 20日出勤 + 残業5.5h + 有給2日（単価 ceil(19100/8×1.25)=2,985 → 残業 ceil(2,985×5.5)=16,418）
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 4, '202605', d, 1, d === 1 ? 5.5 : 0))
    Object.assign(attD, dayPL('site1', 4, '202605', 21))
    Object.assign(attD, dayPL('site1', 4, '202605', 22))

    const result = computeMonthly(main, attD, {}, '202605', 24)
    const w = result.workers.find(x => x.id === 4)!
    expect(w.otAllowance).toBe(16418)
    expect(w.salaryNetPay).toBe((w.basePay || 0) + (w.paidLeaveAllowance || 0) + 16418)
    expect(w.netPay).toBe(w.salaryNetPay)
    expect(w.totalCost).toBe(w.salaryNetPay)
  })

  test('totals.workDays = 全スタッフの workDays 合計', () => {
    const main = buildMain({
      workers: [
        { id: 1, name: 'A', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '', token: '' },
        { id: 2, name: 'B', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '', token: '' },
      ],
      assign: { site1: { workers: [1, 2], subcons: [] } },
      siteWorkDays: { '202604': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 15; d++) Object.assign(attD, dayWork('site1', 1, '202604', d))
    for (let d = 1; d <= 18; d++) Object.assign(attD, dayWork('site1', 2, '202604', d))

    const result = computeMonthly(main, attD, {}, '202604', 20)
    const totalWorkDays = result.workers.reduce((s, w) => s + w.workDays, 0)
    expect(result.totals.workDays).toBe(totalWorkDays)
    expect(result.totals.workDays).toBe(33)  // 15 + 18
  })
})

describe('computeMonthly - 法定休日 8h超の追加0.25倍 (Phase N C-3)', () => {
  test('日曜10h労働: 8h × 1.35 + 2h × 1.60 で計算される', () => {
    // 仕様: 法定休日(日曜)労働は通常1.35倍だが、8h超部分は更に+0.25 = 1.60倍にする必要がある
    //   (労基法37条 時間外労働＋休日労働＋深夜労働の重畳)
    //   旧実装: 全時間×1.35のみ → 8h超部分の0.25が不払い
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 5/3 (日曜) に 10h勤務 = 7h規定 + 3h残業
    Object.assign(attD, { [attKey('site1', 101, '202605', 3)]: { w: 1, o: 3 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!

    // 法定休日労働 10h
    expect(w.legalHolidayHours).toBe(10)
    // 法定休日手当 = 1,500 × (1.35 × 8 + 1.60 × 2) = 1,500 × (10.8 + 3.2) = 1,500 × 14 = 21,000
    expect(w.legalHolidayAllowance).toBe(21000)
  })

  test('日曜8h労働 (8h丁度): 全時間×1.35のみ', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    Object.assign(attD, { [attKey('site1', 101, '202605', 3)]: { w: 1, o: 1 } })  // 8h

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 8h × 1.35 = 10.8h × 1,500 = 16,200
    expect(w.legalHolidayHours).toBe(8)
    expect(w.legalHolidayAllowance).toBe(Math.round(1500 * 1.35 * 8))
  })
})

describe('computeMonthly - 半日勤務 w=0.5 の actualHours 整合 (Phase N C-6)', () => {
  test('半日勤務 (w=0.5) では actualHours が 3.5h + 残業 で計算される', () => {
    // 仕様: w=0.5 = 半日勤務 = 所定の半分 (3.5h相当)
    //   旧実装: actualHours = 7 + entry.o で常に7h固定 → 過大計上
    //   新実装: actualHours = w × 7 + entry.o
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 4 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 5/4 月曜に半日勤務 (w=0.5, o=0)
    Object.assign(attD, { [attKey('site1', 101, '202605', 4)]: { w: 0.5 } })

    const result = computeMonthly(main, attD, {}, '202605', 4, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 実労働時間 = 3.5h (= 7 × 0.5)
    expect(w.actualWorkHours).toBeCloseTo(3.5, 1)
    // 所定外労働は発生しない (3.5h < 所定 3.5h)
    expect(w.nonStatutoryOTHours || 0).toBe(0)
    // 法定外残業も発生しない
    expect(w.legalOtHours || 0).toBe(0)
  })
})

describe('computeMonthly - 補償日 (w=0.6) の労基法26条準拠 (Phase N で追加)', () => {
  test('補償日は欠勤扱いで基本給から減額され、別途60%の休業手当が支給される', () => {
    // 仕様 (2026-06-XX 修正後):
    //   - 補償日 (w=0.6) は会社都合休業日
    //   - 基本給では「欠勤」として扱われ、その日の分が控除される
    //   - 別途、休業手当 = 時給 × 7h × 0.6 が支給される
    //   - 結果: 補償日 1日 = 通常時給1日分の 60% を受け取る (労基法26条準拠)
    //
    // 旧実装: 補償日を absentDays から除外 → 基本給100% + 休業手当60% = 160% (過払い)
    // 新実装: 補償日を absentDays に算入 → 基本給0% (1日分控除) + 休業手当60% = 60%
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 19日通常出勤 + 1日補償（w=0.6）
    for (let d = 4; d <= 22; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))
    Object.assign(attD, { [attKey('site1', 101, '202605', 25)]: { w: 0.6 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!

    expect(w.compDays).toBe(1)
    // regularWorkDays = 出勤19日 (Sundays = 10, 17, 24 を除く → 5/4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21,22 = 17日)
    // 実際は 5/4 ~ 5/22 のうち Sundays = 5/10, 5/17 = 2日を除いた 17日
    // 5/25 は補償日（regularWorkDays に含まれない）
    // 欠勤 = baseDays(20) - regularWorkDays(17) - plUsed(0) - examDays(0) = 3日 ※補償日は含めない
    expect(w.absence).toBe(3)
    // 休業手当 = 1,500 × 7 × 0.6 × 1 = 6,300
    expect(w.compAllowance).toBe(6300)
    // 欠勤控除 = 1,500 × 7 × 3 = 31,500
    expect(w.absentDeduction).toBe(31500)
  })

  test('全日補償日（5日全部w=0.6）: 完全に60%支給のみ', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 5 } },
    })
    const attD: Record<string, { w: number }> = {}
    // 5日全部補償（w=0.6）
    Object.assign(attD, { [attKey('site1', 101, '202605', 4)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 5)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 6)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 7)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 8)]: { w: 0.6 } })

    const result = computeMonthly(main, attD, {}, '202605', 5, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!

    expect(w.compDays).toBe(5)
    // 補償日も欠勤扱い → 欠勤 = 20 (baseDays全部)
    expect(w.absence).toBe(20)
    // 休業手当 = 1,500 × 7 × 0.6 × 5 = 31,500
    expect(w.compAllowance).toBe(31500)
    // 欠勤控除 = 1,500 × 7 × 20 = 210,000
    expect(w.absentDeduction).toBe(210000)
    // 基本給 - 欠勤控除 = 210,000 - 210,000 = 0
    // + 休業手当 31,500 = 支給額 31,500
    expect(w.salaryNetPay).toBe(31500)
  })
})

describe('computeMonthly - 所定外労働手当（割増なし）(Phase N で追加)', () => {
  test('出勤4日+残業4hで法定外残業0、所定外労働4hが通常賃金支給', () => {
    // シナリオ: 月の総労働時間が法定上限を全く超えない最小例
    //   - 1週間中の4日（Mon-Thu）にそれぞれ8h勤務 = 7h規定 + 1h残業
    //   - 各日 actualHours=8h → daily statutory = 0
    //   - 週labels = 4 × 8 = 32h → weekly statutory = 0
    //   - 月labels = 32h → 法定上限以内、monthly statutory = 0
    //   - 計 4h の残業は全て「所定外労働（割増なし）」として支給される
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 4 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 2026/5/4(月), 5/5(火), 5/6(水), 5/7(木) に各日 +1h残業
    Object.assign(attD, { [attKey('site1', 101, '202605', 4)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 5)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 6)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 7)]: { w: 1, o: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 4, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!

    // 基本給は 20日 × 7h × 1,500 = 210,000（実出勤に関わらず固定）
    expect(w.fixedBasePay).toBe(210000)
    // 法定外残業 = 0（全ての層を超えていない）
    expect(w.legalOtHours).toBe(0)
    // 所定外労働 = 残業合計 4h（全て割増対象外）
    expect(w.nonStatutoryOTHours).toBe(4)
    // 所定外労働手当 = 1,500 × 4 = ¥6,000
    expect(w.nonStatutoryOTAllowance).toBe(6000)
    // 法定外残業手当 = 0
    expect(w.otAllowance).toBe(0)
    // 欠勤控除 = (20 - 4) × 1,500 × 7 = 168,000 ※有給なし
    expect(w.absentDeduction).toBe(168000)
    // 支給額 = 210,000 + 6,000 + 0 - 168,000 = 48,000
    expect(w.salaryNetPay).toBe(48000)
  })

  test('出勤4日+有給2日+残業4hで欠勤控除が減る', () => {
    // 上のテストに有給2日を追加 → 欠勤控除 = (20-4-2) × 時給 × 7h = 14 × 1500 × 7 = 147,000
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 4 } },
    })
    const attD: Record<string, { w: number; o?: number; p?: number }> = {}
    for (const d of [4, 5, 6, 7]) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 8)]: { w: 0, p: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 11)]: { w: 0, p: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 4, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 有給は基本給枠を埋めるので、残業4hは全て所定外労働として支給
    expect(w.nonStatutoryOTHours).toBe(4)
    expect(w.nonStatutoryOTAllowance).toBe(6000)
    expect(w.plUsed).toBe(2)
    // 欠勤 = 20 - 4 (実出勤) - 2 (有給) = 14日
    expect(w.absentDeduction).toBe(14 * 1500 * 7)
  })

  test('日次8h超で法定外残業が発生する場合、その分は所定外労働から除外', () => {
    // 1日だけ 9h勤務 (= 7h規定 + 2h残業) → daily statutory = 1h
    // 3日 × 8h = 24h + 1日 × 9h = 33h、weekly statutory = 0 (週40h以内)
    // 残業合計 = 2 + 1×3 = 5h, statutoryOT = 1h, nonStatutoryOT = 4h
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 4 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    Object.assign(attD, { [attKey('site1', 101, '202605', 4)]: { w: 1, o: 2 } })  // 9h
    Object.assign(attD, { [attKey('site1', 101, '202605', 5)]: { w: 1, o: 1 } })  // 8h
    Object.assign(attD, { [attKey('site1', 101, '202605', 6)]: { w: 1, o: 1 } })  // 8h
    Object.assign(attD, { [attKey('site1', 101, '202605', 7)]: { w: 1, o: 1 } })  // 8h

    const result = computeMonthly(main, attD, {}, '202605', 4, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.legalOtHours).toBeCloseTo(1.0, 1)  // 日次1.0h
    // 2026-06-XX 修正: nonStatutoryOTHours は totalDailyExcess 全部（statutoryOT 引かない）
    expect(w.nonStatutoryOTHours).toBeCloseTo(5.0, 1)  // 残業合計5h 全部
    expect(w.nonStatutoryOTAllowance).toBe(7500)  // 1,500 × 5 = 1.0倍
    // 2026-06-XX 修正: 法定外残業手当は割増 0.25倍 のみ
    expect(w.otAllowance).toBe(Math.round(1500 * 0.25 * 1.0))  // 375 (= 1500 × 0.25 × 1)
    // 1.0h statutory の合計支給 = 1.0倍 (nonStat内) + 0.25倍 (法定外) = 1.25倍 ✓
  })

  test('週6日×7h=42h（事前所定）→ 週次の法定外残業ゼロ（変形労働の週所定判定・社労士確認済み）', () => {
    // 6日 × 7h = 42h の週を含む 22日勤務。
    // 2026-06 社労士確認: 事前にカレンダーで「週6日・42時間」と定めていれば、
    //   その42時間分の割増は不要 → 週次の法定外残業は発生しない（旧 flat-40h では誤って2h/週計上）。
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 22 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 5/1〜21 のうち日曜(3,10,17)を除く18日 + 月-土の追加4日で22日
    // 簡略化: 月-土ペアで複数週 → 週40h超を確実に発生させる
    // 月-土6日勤務 × 3週 = 18日 + 月-金 × 1週 = 4日 → 計22日（正確には日付調整）
    const workDays = [4,5,6,7,8,9, 11,12,13,14,15,16, 18,19,20,21,22,23, 25,26,27,28]
    for (const d of workDays) {
      Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })  // 7h（残業0）
    }
    const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 22日 × 7h = 154h（残業欄入力 0h）
    expect(w.workDays).toBe(22)
    expect(w.otHours).toBe(0)
    // 基本給 = 20 × 7 × 1500 = 210,000
    expect(w.fixedBasePay).toBe(210000)
    // 追加所定 = 2 × 7 × 1500 = 21,000
    expect(w.additionalAllowance).toBe(21000)
    // 週所定42hを基準に判定するため、週6日勤務でも週次の法定外残業は発生しない
    expect(w.legalOtHours).toBe(0)
    expect(w.otAllowance).toBe(0)
    // 所定外労働も0 (各日7h丁度・所定どおり)
    expect(w.nonStatutoryOTHours).toBe(0)
    expect(w.nonStatutoryOTAllowance).toBe(0)
  })
})

describe('computeMonthly - 試験日 examDays (Phase M で追加)', () => {
  test('試験日は workDays に含めないが examDays としてカウントされる', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number; exam?: number }> = {}
    // 19日出勤 + 1日試験
    for (let d = 1; d <= 19; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))
    Object.assign(attD, { [attKey('site1', 101, '202605', 20)]: { w: 0, exam: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.examDays).toBe(1)
    expect(w.workDays).toBe(19)
  })

  test('試験日が増えると欠勤日数が減る（同じ稼働日数で比較）', () => {
    // 仕様: absentDays = baseDays - regularWorkDays - plUsed - examDays
    //   examDays が +1 されると absentDays が −1 → absentDeduction が減る
    //   ※2026-06-XX 修正: 補償日 (compDays) は欠勤扱いに変更（労基法26条準拠）
    const buildMainTpl = () => buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })

    // ケースA: 10日出勤、試験なし
    const attA: Record<string, { w: number; o?: number; exam?: number }> = {}
    for (let d = 1; d <= 10; d++) Object.assign(attA, dayWork('site1', 101, '202605', d))
    const resA = computeMonthly(buildMainTpl(), attA, {}, '202605', 20, undefined, 20)
    const wA = resA.workers.find(x => x.id === 101)!

    // ケースB: 10日出勤、+ 1日試験
    const attB: Record<string, { w: number; o?: number; exam?: number }> = {}
    for (let d = 1; d <= 10; d++) Object.assign(attB, dayWork('site1', 101, '202605', d))
    Object.assign(attB, { [attKey('site1', 101, '202605', 11)]: { w: 0, exam: 1 } })
    const resB = computeMonthly(buildMainTpl(), attB, {}, '202605', 20, undefined, 20)
    const wB = resB.workers.find(x => x.id === 101)!

    expect(wB.examDays).toBe(1)
    expect(wA.examDays || 0).toBe(0)
    // examDays が増えた分、欠勤控除が時給×7×1日分（=10500円）減る
    expect((wA.absentDeduction || 0) - (wB.absentDeduction || 0)).toBe(Math.round(1500 * 7 * 1))
  })
})

describe('computeMonthly - useOldRules フラグ (Phase M で追加)', () => {
  test('useOldRules=true: 5月以降でも旧ルール（時給×月所定h）で計算', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
        useOldRules: true,
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 101, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 旧ルール: prescribedHours = 20日 × 20/3h ≈ 133.33h（新ルールなら 140h）
    expect(w.prescribedHours).toBeCloseTo(133.33, 0)
  })

  test('フンケース: useOldRules=true で6月以降も旧ルール計算が正しく完了', () => {
    // 想定: ID 104 フン (2027/01 退職予定, useOldRules=true)
    //   2026/06 の月次集計でも旧ルール（時給×6h40m×所定日数）で計算される必要がある
    const main = buildMain({
      workers: [{
        id: 104, name: 'フン', org: 'hibi', visa: 'jisshu2', job: 'tobi',
        rate: 10000, hourlyRate: 1500, otMul: 1.25, hireDate: '2024-01-01',
        retired: '2027-01-31', token: 'hun-tok', useOldRules: true,
      }],
      assign: { site1: { workers: [104], subcons: [] } },
      siteWorkDays: { '202606': { site1: 22 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 22; d++) Object.assign(attD, dayWork('site1', 104, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 104)!
    // 旧ルール特徴: prescribedHours = 22 × 20/3 ≈ 146.67 (新ルールなら 140)
    expect(w.prescribedHours).toBeCloseTo(146.67, 0)
    // 基本給 = 時給 × 月所定時間 = 1500 × 146.67 ≈ 220000
    expect(w.basePay).toBe(Math.round(1500 * 22 * 20 / 3))
    // 新ルール特有の fixedBasePay は undefined のまま
    expect(w.fixedBasePay).toBeUndefined()
    // useOldRules フラグが下流に伝播している
    expect(w.useOldRules).toBe(true)
  })

  test('useOldRules=undefined (デフォルト): 5月以降は新ルール（baseDays × 7h）', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 101, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.prescribedHours).toBe(140)  // 20 × 7
  })
})

describe('computeMonthly - 新ルール3層構造の金額検証 (Phase M で追加)', () => {
  test('追加所定手当: regularWorkDays > baseDays の月のみ発生', () => {
    // 2026年5月 — Sundays: 5/3, 5/10, 5/17, 5/24, 5/31 (5日)
    // d=1..26 で稼働すると Sundays(3,10,17,24) を除く 22 日が regularWorkDays
    // → additionalDays = 22 - 20 = 2
    // → additionalAllowance = 1500 × 2 × 7 = 21000
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 22 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 26; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))

    const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 基本給（固定） = 1500 × 20 × 7 = 210000
    expect(w.fixedBasePay).toBe(210000)
    // 追加所定 = 1500 × 2 × 7 = 21000 (日曜は regularWorkDays に含めない)
    expect(w.additionalAllowance).toBe(21000)
  })

  test('regularWorkDays ≤ baseDays なら追加所定手当は0', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 15日出勤（baseDays=20 未満）
    for (let d = 1; d <= 15; d++) Object.assign(attD, dayWork('site1', 101, '202605', d))

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.additionalAllowance).toBe(0)
    // 基本給は固定（出勤に依らず）
    expect(w.fixedBasePay).toBe(210000)
  })
})

describe('computeMonthly - 法定休日（日曜出勤）— 新ルール (Phase M で追加)', () => {
  test('日曜出勤分は legalHolidayHours / legalHolidayAllowance に反映', () => {
    // 2026年5月 — 5/3, 5/10, 5/17, 5/24, 5/31 が日曜
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number; st?: string; et?: string }> = {}
    // 5/3 (日曜) に出勤（8:00-17:00 → 実労働 8h）
    Object.assign(attD, {
      [attKey('site1', 101, '202605', 3)]: { w: 1, st: '08:00', et: '17:00' },
    })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 法定休日労働があれば legalHolidayHours が記録される
    expect(w.legalHolidayHours).toBeGreaterThan(0)
    // 法定休日手当 = 時給 × 1.35 × legalHolidayHours
    expect(w.legalHolidayAllowance).toBeGreaterThan(0)
  })
})

describe('computeMonthly - 深夜（22:00-5:00）— 新ルール (Phase M で追加)', () => {
  test('深夜帯の労働は nightHours / nightAllowance に反映', () => {
    const main = buildMain({
      workers: [{
        id: 101, name: 'ベトナム人A', org: 'hibi', visa: 'tokutei1', job: 'tobi',
        rate: 0, hourlyRate: 1500, otMul: 1.25, hireDate: '2025-01-01', token: 'abc',
      }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number; st?: string; et?: string }> = {}
    // 18:00-23:00 出勤（22:00-23:00 が深夜帯 = 60分 = 1h）
    Object.assign(attD, {
      [attKey('site1', 101, '202605', 5)]: { w: 1, st: '18:00', et: '23:00' },
    })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    // 深夜割増（+0.25）
    expect(w.nightHours).toBeGreaterThan(0)
    expect(w.nightAllowance).toBeGreaterThan(0)
    // 1h × 1500 × 0.25 = 375
    expect(w.nightAllowance).toBe(Math.round(1 * 1500 * 0.25))
  })
})

describe('computeMonthly - 鳶見習い (Phase 19 で追加)', () => {
  test('tobi_apprentice は tobi グループとして集計（合計面）', () => {
    const main = buildMain({
      workers: [{
        id: 12, name: '濱上', org: 'hibi', visa: 'none', job: 'tobi_apprentice',
        rate: 0, salary: 235000, otMul: 1.25, hireDate: '2026-06-01', token: '',
      }],
      assign: { site1: { workers: [12], subcons: [] } },
      siteWorkDays: { '202606': { site1: 20 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    for (let d = 1; d <= 20; d++) Object.assign(attD, dayWork('site1', 12, '202606', d))

    const result = computeMonthly(main, attD, {}, '202606', 20)
    const w = result.workers.find(x => x.id === 12)!
    expect(w.job).toBe('tobi_apprentice')
    expect(w.basePay).toBe(235000)  // 月給固定
  })
})

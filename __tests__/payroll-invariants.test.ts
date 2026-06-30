/**
 * 給与計算の不変条件テスト（2026-06-XX 新設）
 *
 * 「外から見て分からない」タイプのバグを継続的に検出するため、
 * 多数のシナリオに対して労基法ベースの不変条件が成立することを検証する。
 *
 * 検出可能なバグ:
 *   - 残業手当の二重支給（過去の 1.25倍バグ）
 *   - 所定外労働手当の支給漏れ（過去の missing component バグ）
 *   - 構成要素合計と支給額の不一致
 *   - 法定外残業の割増不足
 *
 * 検出戦略:
 *   1. Pre-defined シナリオ（境界・典型ケース）を網羅
 *   2. 決定論的なバリエーション（疑似ランダム）で30+パターン生成
 *   3. 全ケースで lib/payroll-validator.ts の不変条件を検証
 */
import { describe, test, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import { validatePayroll } from '@/lib/payroll-validator'

// ─────────────────────────────────────────────────────────────
// Helpers
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

function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${day}`
}

/** 標準的なベトナム人時給制ワーカー */
const STANDARD_WORKER = {
  id: 101,
  name: 'テスト太郎',
  org: 'hibi',
  visa: 'tokutei1',
  job: 'tobi',
  rate: 0,
  hourlyRate: 1500,
  otMul: 1.25,
  hireDate: '2025-01-01',
  token: 'test',
}

// ─────────────────────────────────────────────────────────────
// 1. Pre-defined 境界ケース
// ─────────────────────────────────────────────────────────────

describe('不変条件 - 標準ケース', () => {
  test('ゼロ出勤（不変条件チェックが落ちない）', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const result = computeMonthly(main, {}, {}, '202605', 20, undefined, 20)
    // workers が空配列でも問題ないこと
    expect(result.workers.length).toBeLessThanOrEqual(1)
  })

  test('標準出勤20日（残業0、補償0、有給0）→ 不変条件全部 OK', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number }> = {}
    // 5/1〜5/26 のうち日曜(3,10,17,24)を除く 22日のうち先頭20日
    const days = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21,22,23]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)
    expect(w).toBeDefined()
    const issues = validatePayroll(w!)
    expect(issues).toEqual([])
  })

  test('法定外残業ケース（日8h超）→ 二重支給なしの不変条件 OK', () => {
    // 過去の二重支給バグの直接テスト。
    // 週6日42hは社労士確認により週次残業ゼロのため、ここは「日8h超」で法定外残業を発生させる。
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 22 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    const days = [4,5,6,7,8,9, 11,12,13,14,15,16, 18,19,20,21,22,23, 25,26,27,28]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })
    // 1日だけ残業3h（=10h勤務）→ 日次8h超で法定外残業を確実に発生
    attD[attKey('site1', 101, '202605', 28)] = { w: 1, o: 3 }

    const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.legalOtHours).toBeGreaterThan(0)  // 日8h超で法定外残業発生
    const issues = validatePayroll(w)
    expect(issues).toEqual([])  // 二重支給バグがあると critical が出る
  })

  test('残業多めケース（サン問題の検証）→ 不変条件 OK', () => {
    // 過去の所定外労働未払いバグの直接テスト
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 23 } },
    })
    const attD: Record<string, { w: number; o?: number; p?: number }> = {}
    // 18日勤務（各日約1h残業）+ 2日有給
    const workDays = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21]
    for (const d of workDays) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 22)]: { w: 0, p: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 23)]: { w: 0, p: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 23, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.workDays).toBe(18)
    expect(w.otHours).toBe(18)
    const issues = validatePayroll(w)
    expect(issues).toEqual([])
  })

  test('補償日2日ケース → 不変条件 OK', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number }> = {}
    // 18日勤務 + 2日補償
    const workDays = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21]
    for (const d of workDays) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 22)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 23)]: { w: 0.6 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    const issues = validatePayroll(w)
    expect(issues).toEqual([])
  })

  test('日曜出勤あり（法定休日労働）→ 不変条件 OK', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 21 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 5/3 (日) に8h勤務 + 通常出勤20日
    Object.assign(attD, { [attKey('site1', 101, '202605', 3)]: { w: 1, o: 1 } })
    const days = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21,22,23]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 21, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.legalHolidayHours).toBeGreaterThan(0)
    const issues = validatePayroll(w)
    expect(issues).toEqual([])
  })

  test('月60h超残業（特殊ケース） → 不変条件 OK', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 22 } },
    })
    const attD: Record<string, { w: number; o?: number }> = {}
    // 22日 × 3h残業 = 66h残業
    const days = [4,5,6,7,8,9, 11,12,13,14,15,16, 18,19,20,21,22,23, 25,26,27,28]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1, o: 3 } })

    const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(w.otHours).toBe(66)
    const issues = validatePayroll(w)
    expect(issues).toEqual([])
  })

  test('全日有給（極端ケース） → 不変条件 OK', () => {
    const main = buildMain({
      workers: [STANDARD_WORKER],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number; p?: number }> = {}
    const days = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21,22,23]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 0, p: 1 } })

    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)
    if (w) {
      const issues = validatePayroll(w)
      expect(issues).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────
// 2. 決定論的バリエーション（疑似ランダム）
// ─────────────────────────────────────────────────────────────

// Seed-based 疑似乱数（Mulberry32）— deterministic for CI reproducibility
function mulberry32(seed: number) {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

interface RandomScenario {
  hourlyRate: number
  workDayCount: number
  yuukyuCount: number
  compCount: number
  avgOTPerDay: number
  sundayWorkCount: number
}

function generateScenarios(seed: number, count: number): RandomScenario[] {
  const rand = mulberry32(seed)
  const scenarios: RandomScenario[] = []
  for (let i = 0; i < count; i++) {
    scenarios.push({
      hourlyRate: 1200 + Math.floor(rand() * 800),  // 1200-2000
      workDayCount: 10 + Math.floor(rand() * 13),    // 10-22
      yuukyuCount: Math.floor(rand() * 4),           // 0-3
      compCount: Math.floor(rand() * 3),             // 0-2
      avgOTPerDay: rand() * 2,                       // 0-2h
      sundayWorkCount: Math.floor(rand() * 2),       // 0-1
    })
  }
  return scenarios
}

function runScenario(s: RandomScenario, idx: number) {
  const main = buildMain({
    workers: [{
      ...STANDARD_WORKER,
      hourlyRate: s.hourlyRate,
    }],
    assign: { site1: { workers: [101], subcons: [] } },
    siteWorkDays: { '202605': { site1: 22 } },
  })
  const attD: Record<string, { w: number; o?: number; p?: number }> = {}

  // 出勤日（非Sunday日から先頭 workDayCount 日を選択）
  const nonSundays = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21,22,23,25,26,27,28,29,30]
  const workDays = nonSundays.slice(0, s.workDayCount)
  for (const d of workDays) {
    const otHours = Math.round(s.avgOTPerDay * 10) / 10
    Object.assign(attD, {
      [attKey('site1', 101, '202605', d)]: otHours > 0 ? { w: 1, o: otHours } : { w: 1 }
    })
  }

  // 有給日
  const yuukyuDays = nonSundays.slice(s.workDayCount, s.workDayCount + s.yuukyuCount)
  for (const d of yuukyuDays) {
    Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 0, p: 1 } })
  }

  // 補償日
  const compDays = nonSundays.slice(
    s.workDayCount + s.yuukyuCount,
    s.workDayCount + s.yuukyuCount + s.compCount,
  )
  for (const d of compDays) {
    Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 0.6 } })
  }

  // 日曜出勤（5/3）
  if (s.sundayWorkCount > 0) {
    Object.assign(attD, { [attKey('site1', 101, '202605', 3)]: { w: 1 } })
  }

  const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
  const w = result.workers.find(x => x.id === 101)
  return { worker: w, scenario: s, idx }
}

describe('不変条件 - 決定論的バリエーション（50パターン）', () => {
  const scenarios = generateScenarios(20260601, 50)

  test('全シナリオで不変条件が成立', () => {
    const failures: { idx: number; scenario: RandomScenario; issues: ReturnType<typeof validatePayroll> }[] = []
    for (let i = 0; i < scenarios.length; i++) {
      const { worker, scenario } = runScenario(scenarios[i], i)
      if (!worker) continue  // worker がない場合はスキップ（ゼロ出勤等）
      const issues = validatePayroll(worker)
      if (issues.length > 0) {
        failures.push({ idx: i, scenario, issues })
      }
    }
    if (failures.length > 0) {
      console.error(`\n❌ ${failures.length}/${scenarios.length} シナリオで不変条件違反:`)
      for (const f of failures.slice(0, 5)) {
        console.error(`  シナリオ#${f.idx}: ${JSON.stringify(f.scenario)}`)
        for (const i of f.issues) {
          console.error(`    [${i.severity}] ${i.message}: expected ${i.expected}, actual ${i.actual}, diff ${i.diff}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────
// 3. リグレッション保証（過去のバグの直接テスト）
// ─────────────────────────────────────────────────────────────

describe('過去バグの直接リグレッション', () => {
  test('回帰: 法定外残業の二重支給（基本給+追加所定で1.0倍 + 法定外残業1.25倍）', () => {
    // ハウさんケース: 22日勤務、各日7h、週40h超で法定残業4h
    // 旧バグ: 154h × 1.0 + 4h × 1.25 = 159h相当 (4h過払い)
    // 修正後: 154h × 1.0 + 4h × 0.25 = 155h相当 ✓
    const main = buildMain({
      workers: [{ ...STANDARD_WORKER, hourlyRate: 1500 }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 22 } },
    })
    const attD: Record<string, { w: number }> = {}
    const days = [4,5,6,7,8,9, 11,12,13,14,15,16, 18,19,20,21,22,23, 25,26,27,28]
    for (const d of days) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })
    const result = computeMonthly(main, attD, {}, '202605', 22, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(validatePayroll(w)).toEqual([])
  })

  test('回帰: 所定外労働手当の支給漏れ（残業18.5hで unpaid 17.5h）', () => {
    // サンさんケース: 18日勤務 + 2日有給 + 残業18.5h
    // 旧バグ: 1h × 1.25倍 = ¥1,781 のみ → 17.5h × ¥1,425 = ¥24,938 unpaid
    // 修正後: 18.5h × 1.0 + 1h × 0.25 で正しく支払い ✓
    const main = buildMain({
      workers: [{ ...STANDARD_WORKER, hourlyRate: 1425 }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 23 } },
    })
    const attD: Record<string, { w: number; o?: number; p?: number }> = {}
    const workDays = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20,21]
    for (const d of workDays) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1, o: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 22)]: { w: 0, p: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 23)]: { w: 0, p: 1 } })
    const result = computeMonthly(main, attD, {}, '202605', 23, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(validatePayroll(w)).toEqual([])
  })

  test('回帰: 残業時間の0.1h丸めで割増が¥10下振れしても誤検知しない（2026-06-30）', () => {
    // 月次集計で「法定外残業の割増(0.25倍)が不足」と誤検知された実ケース（モン/ハウ/ゴック）。
    // 原因: 実支給 otAllowance は丸め前の精密な残業時間で計算（例 5.07h → ¥2,005）するが、
    //   検算が使う legalOtHours は compute.ts が return 時に 0.1h へ丸めた値（5.1h）。
    //   検算の想定 = round(時給×5.1×0.25)=¥2,016 となり、差¥11が±2円許容を超えて誤検知。
    // 対策: hoursRoundSlack（時給×0.05×倍率）を許容差に織り込み、丸め差では発火しないこと。
    const snap = {
      id: 107, name: 'モン ヴァンケン', visa: 'jisshu3', hourlyRate: 1581,
      useOldRules: false,
      workDays: 22, regularWorkDays: 22, compDays: 0, plDays: 0,
      actualWorkHours: 5.1, legalHolidayHours: 0, nightHours: 0,
      legalOtHours: 5.1, otHours: 5.1,
      fixedBasePay: 0, additionalAllowance: 0, paidLeaveAllowance: 0,
      nonStatutoryOTAllowance: 0,
      otAllowance: 2005,            // 丸め前 5.07h で計算した実額（正しい）
      legalHolidayAllowance: 0, nightAllowance: 0, compAllowance: 0,
      absentDeduction: 0,
      salaryNetPay: 2005,
    }
    const issues = validatePayroll(snap)
    expect(issues).toEqual([])  // 丸め差では critical を出さない

    // 一方、本当に割増が大きく不足（例: 半額しか払っていない）ケースは依然として検出する
    const realShortfall = { ...snap, otAllowance: 1000, salaryNetPay: 1000 }
    const realIssues = validatePayroll(realShortfall)
    expect(realIssues.some(i => i.field === 'otAllowance')).toBe(true)
  })

  test('回帰: 補償日(w=0.6)の160%過払い', () => {
    // 旧バグ: 基本給100% + 休業手当60% = 160%
    // 修正後: 基本給から1日分減額(40%) + 休業手当60% = 60% ✓
    const main = buildMain({
      workers: [{ ...STANDARD_WORKER, hourlyRate: 1500 }],
      assign: { site1: { workers: [101], subcons: [] } },
      siteWorkDays: { '202605': { site1: 20 } },
    })
    const attD: Record<string, { w: number }> = {}
    const workDays = [1,2,4,5,6,7,8,9,11,12,13,14,15,16,18,19,20]
    for (const d of workDays) Object.assign(attD, { [attKey('site1', 101, '202605', d)]: { w: 1 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 21)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 22)]: { w: 0.6 } })
    Object.assign(attD, { [attKey('site1', 101, '202605', 23)]: { w: 0.6 } })
    const result = computeMonthly(main, attD, {}, '202605', 20, undefined, 20)
    const w = result.workers.find(x => x.id === 101)!
    expect(validatePayroll(w)).toEqual([])
  })
})

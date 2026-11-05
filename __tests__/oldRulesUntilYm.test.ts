import { describe, test, expect } from 'vitest'
import { computeMonthly } from '@/lib/compute-monthly'
import { type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'
import { oldRulesActiveFor, resolveContractForYm, isOldContractWorker } from '@/lib/old-contract'
import { breakShortenMinFor } from '@/lib/attendance-confirm'
import { generateOrgAttendance } from '@/lib/export-attendance'

/**
 * 旧契約を何月分まで使うか（oldRulesUntilYm・2026-11-05 代表決定）。
 * HFU の技能実習1号（旧契約・固定月給）を 12月分から新契約（時給制・1か月単位の変形労働）へ切り替える。
 * useOldRules を外すと締めた過去月まで新契約で再計算されるので、月で区切る。
 *
 * 人・金額は架空（A=切り替える人・B=旧契約のままの人）。
 */
const A = 900
const B = 901
function worker(id: number, extra: Record<string, unknown> = {}) {
  return {
    id, name: id === A ? 'Aさん' : 'Bさん', org: 'hfu', visa: 'jisshu1', job: 'tobi',
    rate: 8000, hourlyRate: 1300, hourlyRateFrom: '2026-12-01', prevHourlyRate: 1200,
    salary: 200000, otMul: 1.25, hireDate: '2026-01-01', token: '',
    useOldRules: true, breakShortenMin: 20, breakShortenFrom: '202609',
    ...extra,
  }
}
function main(aExtra: Record<string, unknown> = {}): MainData {
  return {
    workers: [worker(A, aExtra), worker(B)],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: { s: { workers: [A, B], subcons: [] } }, massign: {}, billing: {},
    workDays: { '202610': 26, '202611': 25, '202612': 25 }, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
  } as unknown as MainData
}
const WORK = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 24, 25, 26, 27]
function att(ym: string) {
  const a: Record<string, AttendanceEntry> = {}
  for (const wid of [A, B]) {
    for (const d of WORK) a[`s_${wid}_${ym}_${d}`] = { w: 1, o: d === 2 ? 1 : 0, st: '08:00', et: '17:00' } as unknown as AttendanceEntry
  }
  return a
}
const run = (m: MainData, ym: string, id: number) => {
  const orig = console.error; console.error = () => {}
  try { return computeMonthly(m, att(ym), {}, ym, 25, undefined, 20).workers.find(x => x.id === id)! }
  finally { console.error = orig }
}

describe('oldRulesActiveFor / resolveContractForYm（純粋な関数）', () => {
  const w = { useOldRules: true, oldRulesUntilYm: '202611', salary: 1, breakShortenMin: 20, breakShortenFrom: '202609', hourlyRate: 1300 }
  test('その月 ≤ 期限の月は旧契約、翌月から新契約（YYYYMM / YYYY-MM / 日付どれでも）', () => {
    expect(oldRulesActiveFor(w, '202611')).toBe(true)
    expect(oldRulesActiveFor(w, '2026-11')).toBe(true)
    expect(oldRulesActiveFor(w, '2026-11-30')).toBe(true)
    expect(oldRulesActiveFor(w, '202612')).toBe(false)
    expect(oldRulesActiveFor(w, '2026-12-01')).toBe(false)
    expect(oldRulesActiveFor(w, '202701')).toBe(false)
  })
  test('期限の無い人はずっと旧契約・useOldRules でない人は旧契約にならない', () => {
    expect(oldRulesActiveFor({ useOldRules: true }, '203012')).toBe(true)
    expect(oldRulesActiveFor({ oldRulesUntilYm: '202611' }, '202605')).toBe(false)
  })
  test('新契約の月は useOldRules・固定月給・休憩短縮を外す。時給はそのまま', () => {
    const r = resolveContractForYm(w, '202612')
    expect(r.useOldRules).toBeUndefined()
    expect(r.salary).toBeUndefined()
    expect(r.breakShortenMin).toBeUndefined()
    expect(r.hourlyRate).toBe(1300)
    expect(resolveContractForYm(w, '202611')).toBe(w)  // 旧契約の月は同じオブジェクト
  })
  test('isOldContractWorker（0.6補を入れられる日・空欄の注意点）もその日の月で決まる', () => {
    const x = { visa: 'jisshu1', useOldRules: true, oldRulesUntilYm: '202611' }
    expect(isOldContractWorker(x, '2026-11-30')).toBe(true)
    expect(isOldContractWorker(x, '2026-12-01')).toBe(false)
    expect(isOldContractWorker({ visa: 'none', useOldRules: true }, '202611')).toBe(false)
  })
  test('breakShortenMinFor（本人確認・実労働時間明細）は新契約の月に 0', () => {
    expect(breakShortenMinFor(w, '202611')).toBe(20)
    expect(breakShortenMinFor(w, '202612')).toBe(0)
    expect(breakShortenMinFor({ breakShortenMin: 20, breakShortenFrom: '202609', useOldRules: true }, '202612')).toBe(20)
  })
})

describe('computeMonthly: 11月分は旧契約・12月分は新契約', () => {
  const m = main({ oldRulesUntilYm: '202611' })
  test('11月分: 旧契約（固定月給・休憩短縮・旧時給）', () => {
    const w = run(m, '202611', A)
    expect(w.useOldRules).toBe(true)
    expect(w.salary).toBe(200000)
    expect(w.hourlyRate).toBe(1200)
    expect(w.breakShortenHours).toBeGreaterThan(0)
  })
  test('12月分: 新契約（時給 1,300・固定月給なし・休憩短縮なし）', () => {
    const w = run(m, '202612', A)
    expect(w.useOldRules).toBeFalsy()
    expect(w.salary).toBeUndefined()
    expect(w.hourlyRate).toBe(1300)
    expect(w.breakShortenHours).toBeUndefined()
    expect(w.breakShortenAllowance || 0).toBe(0)
    // 新契約の3層構造（基本給 = 時給 × 7h × ベース日数）
    expect(w.fixedBasePay).toBe(1300 * 7 * 20)
  })
  test('締めた過去月（10・11月分）は期限を入れる前と1円も変わらない', () => {
    const before = main()  // 期限なし＝今の本番の状態
    for (const ym of ['202610', '202611']) {
      expect(run(m, ym, A)).toEqual(run(before, ym, A))
    }
  })
  test('期限の無い人（旧契約のまま）は12月分も旧契約で、A の設定に影響されない', () => {
    const b = run(m, '202612', B)
    expect(b.useOldRules).toBe(true)
    expect(b.salary).toBe(200000)
    expect(b).toEqual(run(main(), '202612', B))
  })
})

describe('提出用の出面一覧（キャシュモ・社労士）も月で切り替わる', () => {
  const sheetsOf = (ym: string) => {
    const m = main({ oldRulesUntilYm: '202611' })
    const wb = generateOrgAttendance({
      ym, workers: m.workers, attD: att(ym), sites: m.sites, assign: m.assign, massign: m.massign, baseDays: 20, calendarDays: {},
    } as unknown as Parameters<typeof generateOrgAttendance>[0], 'hfu')
    const sheet = wb.Sheets['勤怠サマリー']
    return sheet ? JSON.stringify(sheet) : ''
  }
  test('11月分の勤怠サマリーに A は出ない（旧契約）・12月分には出る（新契約）', () => {
    expect(sheetsOf('202611')).not.toContain('Aさん')
    expect(sheetsOf('202612')).toContain('Aさん')
  })
})

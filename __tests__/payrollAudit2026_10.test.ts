/**
 * 2026-10-02 総合点検（給与計算と帳票）の回帰テスト
 *
 * 支給額を変えた修正は2つだけ:
 *   - 旧ルール固定月給の欠勤控除は基本給を超えない（支給額をマイナスにしない）
 *   - 「欠」は1日1回（同じ日に2現場へ入っても二重控除しない）
 * ほかは「給与チェックの注意点」（payNotes・支給額は変えない）と、出向の判定の一本化、計算根拠の監査チェックの範囲。
 * 実在の人の金額は使わない（架空の時給・日給・月給）。
 */
import { describe, it, expect } from 'vitest'
import {
  computeMonthly, compute, calcTobiEquiv, createDispatchChecker, isDispatched, PAY_NOTES_FROM_YM, JP_WEEK_OVER40_NOTE_FROM_YM, type MainData,
} from '@/lib/compute'
import { validatePayrolls, buildAuditChecks, type PayrollSnapshot, type PayrollAuditWorker } from '@/lib/payroll-validator'
import type { AttendanceEntry } from '@/types'

const E = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry
const dow = (ym: string, d: number) => new Date(+ym.slice(0, 4), +ym.slice(4, 6) - 1, d).getDay()
const dim = (ym: string) => new Date(+ym.slice(0, 4), +ym.slice(4, 6), 0).getDate()
function mk(workers: unknown[], extra: Record<string, unknown> = {}): MainData {
  return {
    workers, sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 30000, dokoRate: 24000 }, mforeman: {}, ...extra,
  } as unknown as MainData
}
const OLD = { id: 104, name: '旧契約A', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 10000, hourlyRate: 1500, salary: 240000, otMul: 1.25, hireDate: '2020-01-01', token: '', useOldRules: true }
const JP_DAILY = { id: 4, name: '日給B', org: 'hibi', visa: 'none', job: 'tobi', rate: 20000, otMul: 1.25, hireDate: '2020-04-01', token: '' }
const JP_MONTHLY = { id: 12, name: '月給C', org: 'hibi', visa: 'none', job: 'tobi_apprentice', rate: 0, salary: 232000, otMul: 1.25, hireDate: '2026-04-01', token: '' }
const VN = { id: 201, name: '新契約D', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: 10500, hourlyRate: 1500, otMul: 1.25, hireDate: '2022-10-01', token: '' }

describe('旧ルール固定月給: 欠勤控除は基本給を超えない（支給額をマイナスにしない）', () => {
  const YM = '202610'  // 全社所定27日（日曜以外）
  it('所定27・出勤2 → 旧は −10,000円。控除は基本給が上限で支給0円、注意点が付く', () => {
    const att: Record<string, AttendanceEntry> = { [`s_104_${YM}_1`]: E, [`s_104_${YM}_2`]: E }
    const w = computeMonthly(mk([OLD], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    expect(w.absence).toBe(25)
    expect(w.absentDeduction).toBe(240000)   // 25日×10,000=250,000 ではなく基本給まで
    expect(w.salaryNetPay).toBe(0)
    expect(w.payNotes?.map(n => n.code)).toContain('belowWorkedDays')
  })
  it('補償日があるときは「基本給 − 補償日控除」が上限（内訳合計＝支給額を保つ）', () => {
    const att: Record<string, AttendanceEntry> = { [`s_104_${YM}_1`]: E, [`s_104_${YM}_2`]: { w: 0.6 } as AttendanceEntry }
    const w = computeMonthly(mk([OLD], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    expect(w.compBaseDeduction).toBe(10000)
    expect(w.absentDeduction).toBe(230000)
    expect(w.salaryNetPay).toBe((w.basePay || 0) + (w.additionalAllowance || 0) + (w.otAllowance || 0) - w.absentDeduction! - w.compBaseDeduction!)
    expect(w.salaryNetPay).toBeGreaterThanOrEqual(0)
  })
  it('控除が基本給に届かない普通の月は従来どおり（出勤26・欠1 → 日給1日分）', () => {
    const att: Record<string, AttendanceEntry> = {}
    let n = 0
    for (let d = 1; d <= 31 && n < 26; d++) if (dow(YM, d) !== 0) { att[`s_104_${YM}_${d}`] = E; n++ }
    const w = computeMonthly(mk([OLD], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    expect(w.absentDeduction).toBe(10000)
    expect(w.salaryNetPay).toBe(230000)
  })
})

describe('「欠」は1日1回（同じ日に2現場へ入っても二重控除しない）', () => {
  const YM = '202610'
  const main = mk([JP_MONTHLY], { sites: [{ id: 's', name: 'S' }, { id: 't', name: 'T' }] })
  const base = () => {
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 31; d++) if (dow(YM, d) >= 1 && dow(YM, d) <= 5) att[`s_12_${YM}_${d}`] = { w: 1 } as AttendanceEntry
    att[`s_12_${YM}_5`] = { w: 0, r: 1 } as unknown as AttendanceEntry
    return att
  }
  it('日本人月給制: 2現場に「欠」 → 欠勤1日・控除1日分', () => {
    const one = computeMonthly(main, base(), {}, YM, 0, undefined, 20, {}).workers[0]
    const att = base(); att[`t_12_${YM}_5`] = { w: 0, r: 1 } as unknown as AttendanceEntry
    const two = computeMonthly(main, att, {}, YM, 0, undefined, 20, {}).workers[0]
    expect(one.absence).toBe(1)
    expect(two.restDays).toBe(1)
    expect(two.absence).toBe(1)
    expect(two.absentDeduction).toBe(one.absentDeduction)
  })
})

describe('出向の判定を一本化（人ごとの dispatchTo と 現場ごとの dispatch 配列の両方）', () => {
  const YM = '202610'
  const att: Record<string, AttendanceEntry> = {}
  for (let d = 1; d <= 5; d++) { att[`s_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry; att[`s_5_${YM}_${d}`] = { w: 1 } as AttendanceEntry }
  const other = { ...JP_DAILY, id: 5, name: '日給E' }
  it('現場の dispatch 配列だけに入っている人: 鳶換算から除かれ、原価（computeMonthly の現場別）からも引かれる', () => {
    const main = mk([JP_DAILY, other], { assign: { s: { workers: [4, 5], dispatch: [4] } } })
    expect(isDispatched(main, 4, 's', YM)).toBe(true)
    expect(createDispatchChecker(main)(5, 's', YM)).toBe(false)
    const te = calcTobiEquiv(main, att, {}, [{ y: 2026, m: 10 }], 's')
    expect(te.tobiWork).toBe(5)   // 4 は除外、5 の5日だけ
    const c = compute(main, att, {}, [{ y: 2026, m: 10 }])
    expect(c.sites.s.dispatchDeduction).toBe(5 * 20000)
    const r = computeMonthly(main, att, {}, YM, 0, undefined, 20, {})
    const site = r.sites.find(x => x.id === 's')!
    expect(site.dispatchDeduction).toBe(100000)
    expect(site.cost).toBe(100000)   // 2人分 200,000 − 出向控除 100,000
    expect(r.workers.find(w => w.id === 4)!.dispatchDeduction).toBe(100000)
    expect(r.totals.cost).toBe(100000)
  })
  it('人ごとの dispatchTo だけの人: 鳶換算からも除かれる（旧は現場の配列しか見ておらず数えていた）', () => {
    const main = mk([{ ...JP_DAILY, dispatchTo: '出向先', dispatchFrom: '2026-01' }, other], { assign: { s: { workers: [4, 5] } } })
    const te = calcTobiEquiv(main, att, {}, [{ y: 2026, m: 10 }], 's')
    expect(te.tobiWork).toBe(5)
    const r = computeMonthly(main, att, {}, YM, 0, undefined, 20, {})
    expect(r.sites.find(x => x.id === 's')!.dispatchDeduction).toBe(100000)
  })
})

describe('計算根拠の監査チェック（lib/payroll-validator.ts buildAuditChecks）', () => {
  const YM = '202610'
  it('法定上限チェックは新ルールの外国人だけ（全社所定27日の月に日本人・旧ルールへ ❌ を出さない）', () => {
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 31; d++) if (dow(YM, d) !== 0) { att[`s_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry; att[`s_104_${YM}_${d}`] = E; att[`s_201_${YM}_${d}`] = E }
    const cal: Record<string, string> = {}; for (let d = 1; d <= 31; d++) cal[d] = dow(YM, d) === 0 ? 'off' : 'work'
    const r = computeMonthly(mk([JP_DAILY, OLD, VN], { workDays: { [YM]: 27 } }), att, {}, YM, 27, { s: 27 }, 20, { s: cal })
    const checksOf = (id: number) => buildAuditChecks(r.workers.find(w => w.id === id) as unknown as PayrollAuditWorker, YM, 27)
    expect(checksOf(4).some(c => c.label === '所定労働時間が法定上限以内')).toBe(false)
    expect(checksOf(104).some(c => c.label === '所定労働時間が法定上限以内')).toBe(false)
    const vn = checksOf(201)
    expect(vn.some(c => c.label === '所定労働時間が法定上限以内' && c.pass)).toBe(true)
    // 注意点（warning）は「自動検算」のチェックを落とさない
    expect(vn.find(c => c.label.startsWith('自動検算'))?.pass).toBe(true)
    for (const id of [4, 104, 201]) expect(checksOf(id).find(c => c.label === '支給額の内訳合計が一致')?.pass).toBe(true)
  })
})

describe('給与チェックの注意点（payNotes・支給額は変えない・2026年9月分〜）', () => {
  it('2026年8月分より前には付かない（締め済み月の見え方を変えない）', () => {
    expect(PAY_NOTES_FROM_YM).toBe('202609')
    const YM = '202608'
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 31; d++) if (dow(YM, d) !== 0) att[`s_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry
    const w = computeMonthly(mk([JP_DAILY]), att, {}, YM, 0, undefined, 20, {}).workers[0]
    expect(w.payNotes).toBeUndefined()
  })
  it('日本人（日給月給）の週40時間超: 月〜土6日×8h → 注意点は出さない（2026-10-03 代表決定: 割増は従来どおり不要）。支給額も変わらない', () => {
    const YM = '202610'
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 5; d <= 10; d++) att[`s_4_${YM}_${d}`] = { w: 1 } as AttendanceEntry   // 10/5(月)〜10/10(土)
    const w = computeMonthly(mk([JP_DAILY]), att, {}, YM, 0, undefined, 20, {}).workers[0]
    expect(w.salaryNetPay).toBe(6 * 20000)
    expect(w.payNotes?.some(x => x.code === 'jpWeekOver40')).toBeFalsy()
    expect(JP_WEEK_OVER40_NOTE_FROM_YM).toBeNull()   // 再開するときはここに開始月を入れ、このテストを「出す」側に直す
  })
  it('日本人月給制（役員以外）の土曜出勤 → 注意点。役員には付けない', () => {
    const YM = '202610'
    const att: Record<string, AttendanceEntry> = { [`s_12_${YM}_3`]: { w: 1 } as AttendanceEntry }
    const w = computeMonthly(mk([JP_MONTHLY]), att, {}, YM, 0, undefined, 20, {}).workers[0]
    expect(w.payNotes?.some(n => n.code === 'jpMonthlyOffDayWork')).toBe(true)
    const y = computeMonthly(mk([{ ...JP_MONTHLY, job: 'yakuin' }]), att, {}, YM, 0, undefined, 20, {}).workers[0]
    expect(y.payNotes).toBeUndefined()
  })
  it('旧ルール: 月途中の入社の暦日按分が「日給×出勤日数」を下回る → 注意点（支給額は変えない）', () => {
    const YM = '202610'
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 26; d <= 31; d++) att[`s_104_${YM}_${d}`] = E
    const w = computeMonthly(mk([{ ...OLD, hireDate: '2026-10-26' }], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    expect(w.basePay).toBe(Math.ceil(240000 * 6 / 31))
    const n = w.payNotes?.find(x => x.code === 'belowWorkedDays')
    expect(n?.amount).toBe(6 * 10000 - (w.basePay || 0))
    expect(w.payNotes?.some(x => x.code === 'oldRuleExtraWork')).toBe(true)   // 所定 round(27×6/31)=5日 を超える出勤
  })
  it('旧ルール: 日曜出勤・夜勤は支給額に入らない → 注意点', () => {
    const YM = '202610'
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 1; d <= 31; d++) if (dow(YM, d) !== 0) att[`s_104_${YM}_${d}`] = E
    const plain = computeMonthly(mk([OLD], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    att[`s_104_${YM}_11`] = E
    att[`s_104_${YM}_13`] = { ...E, ns: 1, nst: '22:00', net: '29:00', nb: 60 } as unknown as AttendanceEntry
    const w = computeMonthly(mk([OLD], { workDays: { [YM]: 27 } }), att, {}, YM, 27, undefined, 20, {}).workers[0]
    expect(w.salaryNetPay).toBe(plain.salaryNetPay)
    const n = w.payNotes?.find(x => x.code === 'oldRuleExtraWork')
    expect(n?.message).toContain('日曜の出勤 1日')
    expect(n?.message).toContain('夜勤 1回')
  })
  describe('新ルールの外国人', () => {
    const YM = '202609'
    const cal = (sat: boolean) => { const c: Record<string, string> = {}; let n = 0; for (let d = 1; d <= 30; d++) { const w = dow(YM, d); const work = w !== 0 && (sat || w !== 6); c[d] = work ? 'work' : 'off'; if (work) n++ } return { c, n } }
    const A = cal(true), B = cal(false)
    it('ほかの現場のカレンダーが週所定を押し上げる → 注意点（本人の現場だけなら法定外が増える）', () => {
      const att: Record<string, AttendanceEntry> = {}
      for (let d = 1; d <= 30; d++) if (dow(YM, d) >= 1 && dow(YM, d) <= 5) att[`b_201_${YM}_${d}`] = E
      att[`b_201_${YM}_12`] = E   // 土曜に臨時出勤 → 週42h
      const main = mk([VN], { sites: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }] })
      const w = computeMonthly(main, att, {}, YM, 0, { a: A.n, b: B.n }, 20, { a: A.c, b: B.c }).workers[0]
      expect(w.legalOtHours).toBe(0)
      const n = w.payNotes?.find(x => x.code === 'crossSiteCalendar')
      expect(n?.message).toContain('2h')
      expect(n?.amount).toBe(Math.ceil(1500 * 0.25) * 2)
      // 本人の現場だけなら注意点なし
      const own = computeMonthly(main, att, {}, YM, 0, { b: B.n }, 20, { b: B.c }).workers[0]
      expect(own.legalOtHours).toBe(2)
      expect(own.payNotes?.some(x => x.code === 'crossSiteCalendar')).toBeFalsy()
    })
    it('月途中の時給改定で改定後の残業が平均時給で計算される → 注意点（目安つき）', () => {
      const att: Record<string, AttendanceEntry> = {}
      for (let d = 1; d <= 30; d++) if (dow(YM, d) >= 1 && dow(YM, d) <= 5) att[`s_201_${YM}_${d}`] = d >= 24 ? { ...E, et: '19:00', o: 2 } as AttendanceEntry : E
      const main = mk([{ ...VN, hourlyRate: 1600, hourlyRateFrom: '2026-09-21', prevHourlyRate: 1400 }])
      const w = computeMonthly(main, att, {}, YM, 0, { s: B.n }, 20, { s: B.c }).workers[0]
      expect(w.hourlyRate).toBe(Math.round(((1400 * 20) + (1600 * 10)) / 30 * 100) / 100)
      const n = w.payNotes?.find(x => x.code === 'midMonthRateOt')
      expect(n).toBeDefined()
      expect(n!.amount).toBe(Math.ceil(10 * 1600 - 10 * (w.hourlyRate || 0)))   // 改定後の残業10h × (1,600 − 平均時給)
    })
    it('稼働日の空欄が「欠」より多く払われる → 注意点（差額つき）。欠を入れれば注意点なし', () => {
      const att: Record<string, AttendanceEntry> = {}
      const work = Object.entries(B.c).filter(([, t]) => t === 'work').map(([d]) => Number(d))
      work.slice(0, 19).forEach(d => { att[`s_201_${YM}_${d}`] = E })
      work.slice(19, 21).forEach(d => { att[`s_201_${YM}_${d}`] = { w: 0.6 } as AttendanceEntry })
      // 残り1日は空欄（カレンダー22日のとき）
      const main = mk([VN])
      const w = computeMonthly(main, att, {}, YM, 0, { s: B.n }, 20, { s: B.c }).workers[0]
      expect(w.calendarBlankDays).toBe(B.n - 21)
      const n = w.payNotes?.find(x => x.code === 'blankDays')
      expect(n).toBeDefined()
      expect(n!.amount).toBeGreaterThan(0)
      att[`s_201_${YM}_${work[21]}`] = { w: 0, r: 1 } as unknown as AttendanceEntry
      const w2 = computeMonthly(main, att, {}, YM, 0, { s: B.n }, 20, { s: B.c }).workers[0]
      expect((w.salaryNetPay || 0) - (w2.salaryNetPay || 0)).toBe(n!.amount)
      expect(w2.payNotes?.some(x => x.code === 'blankDays')).toBeFalsy()
    })
  })
  it('給与チェック（validatePayrolls）は注意点を warning で出し critical にしない（締めは止めない）', () => {
    // 週40時間超の注意点は 2026-10-03 から出さないので、月給制の土曜出勤（jpMonthlyOffDayWork）で確かめる
    const YM = '202610'
    const att: Record<string, AttendanceEntry> = { [`s_12_${YM}_3`]: { w: 1 } as AttendanceEntry }
    const r = computeMonthly(mk([JP_MONTHLY]), att, {}, YM, 0, undefined, 20, {})
    const v = validatePayrolls(r.workers as unknown as PayrollSnapshot[])
    expect(v.critical).toBe(0)
    expect(v.warning).toBe(1)
    expect(v.issues[0].field).toBe('jpMonthlyOffDayWork')
    expect(v.affectedWorkerIds).toEqual([12])
  })
})

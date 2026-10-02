/**
 * 「働いた分を下回らない」不変条件（2026-10-02 総合点検・提案1）
 *
 * 新ルール（変形労働時間制・最低20日保証・案A）を、稼働日数 P・出勤 W・現場都合休 C・欠 R・有給 PL の
 * 組み合わせで総当たりし、次が成り立つことを固定する:
 *   (i)   支給（割増を除く）≧ 通常賃金 × (出勤＋有給) ＋ 0.6 × 補償日  … 働いた分を下回らない
 *   (ii)  支給 ≧ 0
 *   (iii) 出勤 → 欠 に替えて支給が増えない／欠 → 補償 に替えて減らない／補償 → 出勤 に替えて減らない
 *   (iv)  内訳の合計 ＝ 支給額（給与チェック I1）
 * 旧ルール（固定月給・所定日数）は暦日按分と欠勤控除で (i) が破れることが分かっている（賃金の決まりなので
 * 直さず、payNotes の注意点にとどめている）。破れる例を it.todo と「注意点が付く」の確認で明記する。
 * 架空の時給・日給・月給のみ使う。
 */
import { describe, it, expect } from 'vitest'
import { computeMonthly, type MainData } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

const H = 1500
const YM = '202609'   // 案A（本人の欠勤を保証から引く）の最初の月
const dow = (d: number) => new Date(2026, 8, d).getDay()
function main(): MainData {
  return {
    workers: [{ id: 201, name: '新契約A', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: H * 7, hourlyRate: H, otMul: 1.25, hireDate: '2022-10-01', token: '' }],
    sites: [{ id: 's', name: '現場', start: '', end: '', foreman: 0, archived: false }],
    subcons: [], assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {}, defaultRates: {}, mforeman: {},
  } as unknown as MainData
}
type Case = { P: number; W: number; C: number; R: number; PL: number }
function run(c: Case) {
  const cal: Record<string, string> = {}; const att: Record<string, AttendanceEntry> = {}
  let n = 0; const workdays: number[] = []
  for (let d = 1; d <= 30; d++) {
    if (dow(d) === 0) { cal[String(d)] = 'holiday'; continue }
    if (n < c.P) { cal[String(d)] = 'work'; workdays.push(d); n++ } else cal[String(d)] = 'off'
  }
  let i = 0
  const put = (d: number, e: AttendanceEntry) => { att[`s_201_${YM}_${d}`] = e }
  for (let k = 0; k < c.W; k++) put(workdays[i++], { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry)
  for (let k = 0; k < c.C; k++) put(workdays[i++], { w: 0.6 } as AttendanceEntry)
  for (let k = 0; k < c.R; k++) put(workdays[i++], { r: 1 } as unknown as AttendanceEntry)
  for (let k = 0; k < c.PL; k++) put(workdays[i++], { p: 1 } as unknown as AttendanceEntry)
  const w = computeMonthly(main(), att, {}, YM, 0, { s: c.P }, 20, { s: cal }).workers.find(x => x.id === 201)
  if (!w) return null   // 出勤・有給・補償がゼロの月は月次集計に載らない（支給0）
  const core = (w.salaryNetPay ?? 0) - (w.otAllowance || 0)   // 割増は週40h超の有無で変わるので除いて比べる
  const parts = (w.fixedBasePay || 0) + (w.additionalAllowance || 0) + (w.paidLeaveAllowance || 0) + (w.nonStatutoryOTAllowance || 0)
    + (w.otAllowance || 0) + (w.legalHolidayAllowance || 0) + (w.nightAllowance || 0) + (w.compAllowance || 0) - (w.absentDeduction || 0)
  return { w, core, parts, days: Math.round(core / (H * 7) * 100) / 100 }
}

describe('新ルール（変形労働時間制）の不変条件', () => {
  it('総当たり: 働いた分を下回らない・マイナスにならない・内訳＝支給額・入力の置き換えで損得が逆転しない', () => {
    const bad: string[] = []
    let cases = 0
    for (let P = 17; P <= 26; P++) for (let W = 10; W <= P; W++) for (let C = 0; C <= Math.min(5, P - W); C++) for (let R = 0; R <= Math.min(4, P - W - C); R++) for (let PL = 0; PL <= Math.min(2, P - W - C - R); PL++) {
      cases++
      const c = { P, W, C, R, PL }
      const a = run(c)!
      const tag = `P${P} W${W} C${C} R${R} PL${PL}`
      if (a.core < Math.ceil(H * 7 * (W + PL) + H * 7 * 0.6 * C) - 2) bad.push(`(i) ${tag} → ${a.days}日分`)
      if ((a.w.salaryNetPay ?? 0) < 0) bad.push(`(ii) ${tag}`)
      if (a.parts !== (a.w.salaryNetPay ?? 0)) bad.push(`(iv) ${tag} 内訳 ${a.parts} ≠ ${a.w.salaryNetPay}`)
      if (W > 10) { const b = run({ ...c, W: W - 1, R: R + 1 })!; if (b.core > a.core) bad.push(`(iii)出→欠で増える ${tag}`) }
      if (R > 0) { const b = run({ ...c, C: C + 1, R: R - 1 })!; if (b.core < a.core) bad.push(`(iii)欠→補で減る ${tag}`) }
      if (C > 0) { const b = run({ ...c, W: W + 1, C: C - 1 })!; if (b.core < a.core) bad.push(`(iii)補→出で減る ${tag}`) }
    }
    expect(cases).toBeGreaterThan(2000)
    expect(bad).toEqual([])
  }, 60_000)

  it('代表例の日数換算（docs/calc-examples.md 例3・例3-2 と一致）', () => {
    expect(run({ P: 22, W: 15, C: 5, R: 0, PL: 0 })!.days).toBe(20)      // 枠内補償5日は100%
    expect(run({ P: 22, W: 19, C: 2, R: 1, PL: 0 })!.days).toBe(20.2)    // 保証19・休業手当1.2日分・欠1
    expect(run({ P: 18, W: 18, C: 0, R: 0, PL: 0 })!.days).toBe(20)      // 閑散月は20日分を保証
    expect(run({ P: 24, W: 20, C: 0, R: 4, PL: 0 })!.days).toBe(20)      // 保証は最低ライン。働いた20日分
  })

  it('稼働日の空欄は「欠」より多く払われることがある（既知。注意点 blankDays で検出する）', () => {
    const blank = run({ P: 22, W: 19, C: 2, R: 0, PL: 0 })!   // 残り1日が空欄
    const rest = run({ P: 22, W: 19, C: 2, R: 1, PL: 0 })!
    expect(blank.days).toBe(20.6)
    expect(rest.days).toBe(20.2)
    expect(blank.w.payNotes?.some(n => n.code === 'blankDays' && n.amount === blank.core - rest.core)).toBe(true)
  })
})

describe('旧ルール（固定月給・所定日数）の既知の破れ（賃金の決まり＝代表・社労士の判断待ち。注意点で検出）', () => {
  const YM10 = '202610'
  const OLD = { id: 104, name: '旧契約B', org: 'hibi', visa: 'tokutei1', job: 'tobi', rate: 10000, hourlyRate: 1500, salary: 240000, otMul: 1.25, hireDate: '2020-01-01', token: '', useOldRules: true }
  const E = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry
  const mk = (w: typeof OLD) => ({ ...main(), workers: [w], workDays: { [YM10]: 27 } }) as unknown as MainData
  it.todo('月途中の入社の暦日按分（月給×在籍日÷暦日）が「日給×出勤日数」を下回る → 決まりが決まったら (i) をここで固定する')
  it.todo('所定27日の月は欠勤1日の控除（日給）が基本給の1日分（月給÷27）を超える → 決まりが決まったら固定する')
  it('破れている間は注意点 belowWorkedDays が付き、支給額はマイナスにならない', () => {
    const att: Record<string, AttendanceEntry> = {}
    for (let d = 26; d <= 31; d++) att[`s_104_${YM10}_${d}`] = E
    const hire = computeMonthly(mk({ ...OLD, hireDate: '2026-10-26' }), att, {}, YM10, 27, undefined, 20, {}).workers[0]
    expect(hire.salaryNetPay).toBeLessThan(6 * 10000)
    expect(hire.payNotes?.some(n => n.code === 'belowWorkedDays')).toBe(true)
    const few: Record<string, AttendanceEntry> = { [`s_104_${YM10}_1`]: E, [`s_104_${YM10}_2`]: E }
    const w = computeMonthly(mk(OLD), few, {}, YM10, 27, undefined, 20, {}).workers[0]
    expect(w.salaryNetPay).toBeGreaterThanOrEqual(0)
    expect(w.payNotes?.some(n => n.code === 'belowWorkedDays')).toBe(true)
  })
})

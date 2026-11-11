/**
 * 新卒（月給）→ 日給月給への移行の決まり（docs/wage-system.md 第13節・2026-11-11 代表決定）。
 *   - 移行日 = 入社した翌年の10月1日。その日に18歳未満なら、18歳の誕生日の翌月1日
 *   - 号 = 1G で「月給 × 12 ÷ 251 を上回る最初の号」
 *   - 移ってから6ヶ月未満の年次改定は対象外
 * 金額は架空（実在の人の給与を書かない）。
 */
import { describe, it, expect } from 'vitest'
import {
  isJpMonthlyTrainee, jpTransferSchedule, transferPlacement, transferStatus, isTransferOverdueForYm,
} from '@/lib/jp-transfer'
import { computeRosterRevision, dailyForStep, type RosterMember } from '@/lib/jp-wage'
import { effectiveRateForYm, effectiveSalaryForYm } from '@/lib/workers'

describe('月給の新卒かどうか', () => {
  it('日本人・月給あり・等級なしだけが対象', () => {
    expect(isJpMonthlyTrainee({ visa: 'none', job: 'tobi_apprentice', salary: 200000 })).toBe(true)
    expect(isJpMonthlyTrainee({ visaType: 'none', jobType: 'tobi', salary: 200000 })).toBe(true)
  })
  it('役員・事務・外国籍・等級のある人・月給の無い人は対象外', () => {
    expect(isJpMonthlyTrainee({ visa: 'none', job: 'yakuin', salary: 900000 })).toBe(false)
    expect(isJpMonthlyTrainee({ visa: 'none', job: 'jimu', salary: 200000 })).toBe(false)
    expect(isJpMonthlyTrainee({ visa: 'jisshu1', job: 'tobi', salary: 200000 })).toBe(false)
    expect(isJpMonthlyTrainee({ visa: 'none', job: 'tobi', salary: 200000, jpGrade: '1G' })).toBe(false)
    expect(isJpMonthlyTrainee({ visa: 'none', job: 'tobi', salary: 0 })).toBe(false)
    expect(isJpMonthlyTrainee(null)).toBe(false)
  })
})

describe('移行日', () => {
  it('高卒・4月入社 → 翌年の10月1日（1年半後）', () => {
    const s = jpTransferSchedule('2027-04-01', '2008-08-15')
    expect(s.date).toBe('2028-10-01')
    expect(s.waitsForAge).toBe(false)
  })
  it('6月入社でも翌年の10月1日（1年4ヶ月後）', () => {
    expect(jpTransferSchedule('2026-06-01', '2007-01-01').date).toBe('2027-10-01')
  })
  it('中卒: 翌年の10月1日に17歳なら、18歳の誕生日の翌月1日', () => {
    // 2010年5月生まれ・2026年入社 → 2027-10-01 は17歳 → 18歳は2028年5月 → 2028-06-01
    const s = jpTransferSchedule('2026-06-01', '2010-05-10')
    expect(s.baseDate).toBe('2027-10-01')
    expect(s.date).toBe('2028-06-01')
    expect(s.waitsForAge).toBe(true)
  })
  it('誕生日が1日でも翌月・12月生まれは翌年1月', () => {
    expect(jpTransferSchedule('2026-04-01', '2010-05-01').date).toBe('2028-06-01')
    expect(jpTransferSchedule('2026-04-01', '2009-12-20').date).toBe('2028-01-01')
  })
  it('10月1日が誕生日ならその日に18歳として移れる・10月2日生まれは11月1日', () => {
    expect(jpTransferSchedule('2026-04-01', '2009-10-01').date).toBe('2027-10-01')
    expect(jpTransferSchedule('2026-04-01', '2009-10-02').date).toBe('2027-11-01')
  })
  it('10月以降に入社しても翌年の10月1日', () => {
    expect(jpTransferSchedule('2026-11-01', '2000-01-01').date).toBe('2027-10-01')
  })
  it('入社日・生年月日が無いと決めない（理由を返す）', () => {
    const s = jpTransferSchedule('2026-04-01', '')
    expect(s.date).toBeNull()
    expect(s.blockers.length).toBe(1)
    expect(jpTransferSchedule('', '').blockers.length).toBe(2)
  })
  it('状態: まだ先 → 60日前から「もうすぐ」→ 当日から「確定してください」', () => {
    const s = jpTransferSchedule('2027-04-01', '2008-08-15')
    expect(transferStatus(s, '2028-07-01')).toBe('waiting')
    expect(transferStatus(s, '2028-08-02')).toBe('soon')
    expect(transferStatus(s, '2028-10-01')).toBe('due')
    expect(transferStatus(jpTransferSchedule('2027-04-01', ''), '2028-10-01')).toBe('needInput')
  })
})

describe('号の決め方（月給を上回る最初の 1G の号）', () => {
  it('月給 × 12 ÷ 251 を上回る最初の号', () => {
    for (const monthly of [200000, 230000, 250000, 260000]) {
      const p = transferPlacement(monthly)
      expect(p.grade).toBe('1G')
      expect(p.daily).toBeGreaterThanOrEqual(p.dailyFromMonthly)
      if (p.step > 1) expect(dailyForStep('1G', p.step - 1)).toBeLessThan(p.dailyFromMonthly)
    }
  })
  it('1号より低い月給は1号', () => {
    expect(transferPlacement(150000).step).toBe(1)
  })
})

describe('月次の注意点: 移行日を過ぎたのに月給のまま', () => {
  const w = { visa: 'none', job: 'tobi', salary: 230000, hireDate: '2027-04-01', birthDate: '2008-08-15' }
  it('移行日の月から出る・前の月は出ない', () => {
    expect(isTransferOverdueForYm(w, '202809')).toBeNull()
    expect(isTransferOverdueForYm(w, '202810')).toBe('2028-10-01')
    expect(isTransferOverdueForYm(w, '2028-11')).toBe('2028-10-01')
  })
  it('移行を確定した人（等級あり）には出ない', () => {
    expect(isTransferOverdueForYm({ ...w, salary: 0, jpGrade: '1G' }, '202810')).toBeNull()
  })
})

describe('確定で書く値と給与計算（移行日より前の月は月給のまま）', () => {
  // app/api/jp-wage/transfer が書く形
  const after = { rate: 11040, rateFrom: '2028-10-01', prevRate: 0, salary: 0, salaryFrom: '2028-10-01', prevSalary: 230000 }
  it('9月分は月給・日額なし', () => {
    expect(effectiveSalaryForYm(after, '202809')).toBe(230000)
    expect(effectiveRateForYm(after, '202809')).toBe(0)
  })
  it('10月分から月給なし・日額あり', () => {
    expect(effectiveSalaryForYm(after, '202810') || 0).toBe(0)
    expect(effectiveRateForYm(after, '202810')).toBe(11040)
    expect(effectiveSalaryForYm(after, '202811') || 0).toBe(0)
  })
})

describe('年次改定: 移ってから6ヶ月未満は対象外', () => {
  const base: RosterMember = {
    id: 1, name: 'Aさん', grade: '1G', currentStep: 3, birthDate: '2008-08-15', hireDate: '2027-04-01', hyogo: 'A',
  }
  it('基準日に移った人は ineligible', () => {
    const r = computeRosterRevision([{ ...base, transferredOn: '2028-10-01' }], { asOf: '2028-10-01' })
    expect(r.rows[0].status).toBe('ineligible')
    expect(r.rows[0].newTotal).toBe(r.rows[0].oldTotal)
  })
  it('6月に移った人も、その年の10月1日（4ヶ月後）は対象外', () => {
    const r = computeRosterRevision([{ ...base, transferredOn: '2028-06-01' }], { asOf: '2028-10-01' })
    expect(r.rows[0].status).toBe('ineligible')
  })
  it('1月に移った人は、その年の10月1日（9ヶ月後）は対象', () => {
    const r = computeRosterRevision([{ ...base, transferredOn: '2028-01-01' }], { asOf: '2028-10-01' })
    expect(r.rows[0].status).toBe('ok')
  })
  it('翌年の改定は対象', () => {
    const r = computeRosterRevision([{ ...base, transferredOn: '2028-10-01' }], { asOf: '2029-10-01' })
    expect(r.rows[0].status).toBe('ok')
  })
  it('個別に含める判断はできる', () => {
    const r = computeRosterRevision([{ ...base, transferredOn: '2028-10-01', forceInclude: true }], { asOf: '2028-10-01' })
    expect(r.rows[0].status).toBe('ok')
  })
})

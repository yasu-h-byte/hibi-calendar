import { describe, it, expect } from 'vitest'
import {
  childAllowance, isChildEligible, attendanceBonusDays, attendanceBonusAmount,
  NON_SMOKER_ALLOWANCE, CHILD_ALLOWANCE_BY_ORDER,
} from '@/lib/jp-wage'

/**
 * 賞与に上乗せする手当（2026-08-31 追加）
 *
 * 期待値は 2025年の賞与支給一覧（実物）から取っている:
 *   大川・大介 = 子2人 → 30,000 + 50,000 = 80,000
 *   倉本       = 子4人 → 30,000 + 50,000 + 70,000 + 70,000 = 220,000
 *   梶原       = 有給を全消化 → 精勤賞与 0円
 *   白戸春奈   = 3日 × 11,850 = 35,550
 */
describe('子ども手当', () => {
  it('金額表は 第1子3万・第2子5万・第3子以降7万', () => {
    expect(CHILD_ALLOWANCE_BY_ORDER).toEqual([30000, 50000, 70000])
  })

  it('子2人 = 80,000円（2025年 大川・大介さんの実績と一致）', () => {
    const r = childAllowance(['2012-04-01', '2015-08-20'], '2025-12-10')
    expect(r.eligibleCount).toBe(2)
    expect(r.amount).toBe(80000)
  })

  it('子4人 = 220,000円（2025年 倉本さんの実績と一致）', () => {
    const r = childAllowance(['2009-01-05', '2011-06-30', '2014-02-14', '2018-09-01'], '2025-12-10')
    expect(r.eligibleCount).toBe(4)
    expect(r.amount).toBe(220000)
    expect(r.perChild).toEqual([30000, 50000, 70000, 70000])
  })

  it('18歳の誕生日を迎える年までが対象（年単位で判定）', () => {
    // 2007年生まれ → 2025年に18歳 → 2025年は対象、2026年は対象外
    expect(isChildEligible('2007-12-31', '2025-12-10')).toBe(true)
    expect(isChildEligible('2007-01-01', '2025-12-10')).toBe(true)   // 誕生日前後で変わらない
    expect(isChildEligible('2007-12-31', '2026-12-10')).toBe(false)
  })

  it('対象外の子は数えず、下の子が第1子になる', () => {
    // 上の子(2006年生)は2025年時点で19歳 → 対象外
    const r = childAllowance(['2006-05-05', '2012-04-01'], '2025-12-10')
    expect(r.eligibleCount).toBe(1)
    expect(r.amount).toBe(30000)   // 第1子として3万
  })

  it('子がいなければ0円', () => {
    expect(childAllowance([], '2025-12-10').amount).toBe(0)
  })
})

describe('禁煙手当', () => {
  it('年額3万円', () => {
    expect(NON_SMOKER_ALLOWANCE).toBe(30000)
  })
})

describe('精勤賞与（有給の買取）', () => {
  it('残日数 × 日額（2025年 白戸春奈さんの実績と一致）', () => {
    expect(attendanceBonusAmount(attendanceBonusDays(3), 11850)).toBe(35550)
  })

  it('有給を全消化していれば0円（2025年 梶原さんの実績と一致）', () => {
    expect(attendanceBonusAmount(attendanceBonusDays(0), 18620)).toBe(0)
  })

  it('来期からは「残日数 − 5日」が上限', () => {
    expect(attendanceBonusDays(20, { capForFiveDayObligation: true })).toBe(15)
    expect(attendanceBonusDays(5, { capForFiveDayObligation: true })).toBe(0)
    expect(attendanceBonusDays(3, { capForFiveDayObligation: true })).toBe(0)  // マイナスにしない
  })

  it('上限なし（今期まで）は残日数の全部', () => {
    expect(attendanceBonusDays(20)).toBe(20)
  })

  it('端数の日数は切り捨て', () => {
    expect(attendanceBonusDays(12.7)).toBe(12)
  })
})

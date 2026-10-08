import { fiveDayReserve } from '@/lib/leave-settle'
import { describe, it, expect } from 'vitest'
import {
  childAllowance, isChildEligible, attendanceBonusDays, attendanceBonusAmount,
  NON_SMOKER_ALLOWANCE, CHILD_ALLOWANCE_BY_ORDER,
  bonusPoints, allocateBonus, FIXED_BONUS_STEP_DOWN,
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

  it('来期からは「残日数 −（5 − 稼働日に取った有給）」が上限（2026-10-08 有給精算とそろえた）', () => {
    // 20日付与・1日も取っていない → 5日を除いて15日
    expect(attendanceBonusDays(20, { reserveDays: fiveDayReserve(20, 0) })).toBe(15)
    // 5日取り終えた人（残15）→ 全部買い取れる（旧: 残−5 で10日しか買い取れず5日が消えていた）
    expect(attendanceBonusDays(15, { reserveDays: fiveDayReserve(20, 5) })).toBe(15)
    // 3日取った人（残17）→ 足りない2日を除いて15日
    expect(attendanceBonusDays(17, { reserveDays: fiveDayReserve(20, 3) })).toBe(15)
    expect(attendanceBonusDays(3, { reserveDays: 5 })).toBe(0)  // マイナスにしない
  })

  it('上限なし（今期まで）は残日数の全部', () => {
    expect(attendanceBonusDays(20)).toBe(20)
  })

  it('端数の日数は切り捨て', () => {
    expect(attendanceBonusDays(12.7)).toBe(12)
  })
})

/**
 * 処遇固定の人の賞与の点数（2026-10-07 代表決定「1グループ下で固定」）。
 */
describe('処遇固定の人の賞与の点数', () => {
  it('1段下で数える（4G・A 280点 → 200点＝3G・A と同じ）', () => {
    expect(FIXED_BONUS_STEP_DOWN).toBe(1)
    expect(bonusPoints('4G', 'A', FIXED_BONUS_STEP_DOWN)).toBe(200)
    expect(bonusPoints('4G', 'A', FIXED_BONUS_STEP_DOWN)).toBe(bonusPoints('3G', 'A'))
  })

  it('評語のシフトはその上に乗る（4G・S を1段下 = 280点）', () => {
    expect(bonusPoints('4G', 'S', FIXED_BONUS_STEP_DOWN)).toBe(280)
  })

  it('下げない人は従来どおり', () => {
    expect(bonusPoints('4G', 'A')).toBe(280)
    expect(bonusPoints('4G', 'A', 0)).toBe(280)
  })

  it('配分では下げた点数で原資を分ける（合計点が減り、他の人の単価が上がる）', () => {
    const r = allocateBonus(1_000_000, [
      { workerId: 1, grade: '4G', hyogo: 'A' },
      { workerId: 2, grade: '4G', hyogo: 'A', stepDown: 2 },
    ])
    expect(r.totalPoints).toBe(420)
    expect(r.allocations[0].points).toBe(280)
    expect(r.allocations[1].points).toBe(140)
    // 下げた人はちょうど半分（千円切り上げ前）
    expect(r.allocations[1].points * r.unit * 2).toBeCloseTo(r.allocations[0].points * r.unit)
  })
})

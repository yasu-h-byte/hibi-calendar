import { describe, it, expect } from 'vitest'
import {
  dailyForStep, capDaily, baseAnnual, stepForDaily, dailyFromMonthly,
  HYOGO_PITCH, ageAdjustment, profitAdjustment, profitRankOf, specialAdjustment,
  computeRevision, promote, bonusPoints, allocateBonus, MAX_STEP, ANNUAL_DAYS,
} from '@/lib/jp-wage'
import { MIGRATION_2026 } from '@/lib/jp-wage-migration'

describe('号俸表: 初号・上限（docs/wage-system.md と一致）', () => {
  it('初号(1号)', () => {
    expect(dailyForStep('1G', 1)).toBe(10850)
    expect(dailyForStep('6G', 1)).toBe(18300)
  })
  it('上限(60号)は 450万→900万 の一定割合', () => {
    expect(capDaily('1G')).toBe(15455)
    expect(capDaily('2G')).toBe(17775)
    expect(capDaily('3G')).toBe(20550)
    expect(capDaily('4G')).toBe(23575)
    expect(capDaily('5G')).toBe(27010)
    expect(capDaily('6G')).toBe(31065)
  })
  it('上限年収(×290)', () => {
    expect(baseAnnual(capDaily('1G'))).toBe(4481950)
    expect(baseAnnual(capDaily('6G'))).toBe(9008850)
  })
  it('上限の年収は各段およそ×1.15で逓増（450→900万）', () => {
    const ann = (['1G','2G','3G','4G','5G','6G'] as const).map(g => baseAnnual(capDaily(g)))
    for (let i = 1; i < ann.length; i++) {
      const r = ann[i] / ann[i - 1]
      expect(r).toBeGreaterThan(1.13)
      expect(r).toBeLessThan(1.17)
    }
    expect(ann[5] / ann[0]).toBeCloseTo(2.0, 1)
  })
  it('レンジ逓減: 26号・46号でピッチが小さくなる', () => {
    const p25 = dailyForStep('6G', 25) - dailyForStep('6G', 24) // z1=260
    const p26 = dailyForStep('6G', 26) - dailyForStep('6G', 25) // z2=210
    const p46 = dailyForStep('6G', 46) - dailyForStep('6G', 45) // z3=155
    expect(p25).toBe(260)
    expect(p26).toBe(210)
    expect(p46).toBe(155)
  })
  it('範囲外の号はエラー', () => {
    expect(() => dailyForStep('1G', 0)).toThrow()
    expect(() => dailyForStep('1G', 61)).toThrow()
  })
})

describe('土工: 3Gの90%（5円四捨五入）', () => {
  it('各号が 3G×0.9 を5円丸めた値', () => {
    for (const n of [1, 2, 26, 45, 60]) {
      expect(dailyForStep('doko', n)).toBe(Math.round((dailyForStep('3G', n) * 0.9) / 5) * 5)
    }
    expect(dailyForStep('doko', 60)).toBe(18495)
  })
})

describe('読み替え stepForDaily: 現日額を下回らない最初の号', () => {
  it('ちょうどの日額はその号', () => {
    expect(stepForDaily('1G', dailyForStep('1G', 10))).toBe(10)
  })
  it('間の日額は上の号に上がる（日額は下げない）', () => {
    const d = dailyForStep('1G', 10) + 1
    const s = stepForDaily('1G', d)
    expect(dailyForStep('1G', s)).toBeGreaterThanOrEqual(d)
    expect(s).toBe(11)
  })
})

describe('2026年度移行: 現員10名（docs §12 と一致・日額は下げない）', () => {
  it.each(MIGRATION_2026)('$name: $fromDaily → $step号', ({ grade, fromDaily, step }) => {
    expect(stepForDaily(grade, fromDaily)).toBe(step)
    expect(dailyForStep(grade, step)).toBeGreaterThanOrEqual(fromDaily)
  })
})

describe('新卒: 月給→日給→着地号', () => {
  it('中卒 月給235,000（所定251日）→ 1G 6号', () => {
    const d = dailyFromMonthly(235000, 251)
    expect(d).toBe(11235)
    expect(stepForDaily('1G', d)).toBe(6)
  })
  it('高卒 月給255,000（所定251日）→ 1G 16号', () => {
    const d = dailyFromMonthly(255000, 251)
    expect(d).toBe(12191)
    expect(stepForDaily('1G', d)).toBe(16)
  })
})

describe('評語 → ピッチ（5段階・基本A・C=1・SSSなし）', () => {
  it('SS=6 / S=5 / A=4 / B=3 / C=1', () => {
    expect(HYOGO_PITCH).toEqual({ SS: 6, S: 5, A: 4, B: 3, C: 1 })
  })
})

describe('年齢調整（docs §6）', () => {
  it('若手1Gは加点、高齢1Gは-4', () => {
    expect(ageAdjustment(20, '1G')).toBe(3)
    expect(ageAdjustment(28, '1G')).toBe(1)
    expect(ageAdjustment(33, '1G')).toBe(0)
    expect(ageAdjustment(65, '1G')).toBe(-4)
  })
  it('5G・6Gは50歳まで0、51/56/60で-1/-2/-3', () => {
    expect(ageAdjustment(50, '5G')).toBe(0)
    expect(ageAdjustment(50, '6G')).toBe(0)
    expect(ageAdjustment(52, '5G')).toBe(-1)
    expect(ageAdjustment(57, '6G')).toBe(-2)
    expect(ageAdjustment(61, '5G')).toBe(-3)
  })
  it('同年齢では上位等級ほど減点が小さい（46-50歳）', () => {
    const row = (['1G','2G','3G','4G','5G','6G'] as const).map(g => ageAdjustment(48, g))
    expect(row).toEqual([-3, -3, -2, -1, 0, 0])
  })
  it('土工は3G相当', () => {
    expect(ageAdjustment(48, 'doko')).toBe(ageAdjustment(48, '3G'))
  })
})

describe('利益調整（docs §7）', () => {
  it('利益率→ランク', () => {
    expect(profitRankOf(12)).toBe('over10')
    expect(profitRankOf(5)).toBe('over5')
    expect(profitRankOf(1)).toBe('profit')
    expect(profitRankOf(-3)).toBe('loss')
  })
  it('1G/2Gは常に0、上位ほど連動が強い', () => {
    expect(profitAdjustment('over10', '1G')).toBe(0)
    expect(profitAdjustment('over10', '6G')).toBe(3)
    expect(profitAdjustment('loss', '6G')).toBe(-3)
    expect(profitAdjustment('profit', '6G')).toBe(1)
  })
})

describe('特別調整（±3上限）', () => {
  it('事由の合計', () => {
    expect(specialAdjustment(['qualification'])).toBe(1)
    expect(specialAdjustment(['qualification', 'newsite', 'offsite'])).toBe(3)
    expect(specialAdjustment(['qualification', 'newsite', 'offsite', 'qualification'])).toBe(3) // +4→+3にクランプ
    expect(specialAdjustment(['discipline', 'accident'])).toBe(-3)
    expect(specialAdjustment(['discipline', 'accident', 'longleave'])).toBe(-3) // -4→-3
    expect(specialAdjustment([])).toBe(0)
  })
})

describe('改定 computeRevision: 合計ピッチ・降給なし', () => {
  it('標準A・利益黒字・特別なしの一般的ケース', () => {
    // 本田さん相当: 3G 33号, A, 47歳, 黒字
    const r = computeRevision({ grade: '3G', currentStep: 33, hyogo: 'A', age: 47, profitRank: 'profit' })
    expect(r.hyogoPitch).toBe(4)
    expect(r.agePitch).toBe(ageAdjustment(47, '3G')) // -2
    expect(r.profitPitch).toBe(0)
    expect(r.totalPitch).toBe(2)
    expect(r.newStep).toBe(35)
  })
  it('合計マイナスは0にクランプ（降給なし）', () => {
    // C(1) + 年齢-3 + 利益赤字-2 = -4 → 0
    const r = computeRevision({ grade: '4G', currentStep: 30, hyogo: 'C', age: 58, profitRank: 'loss' })
    expect(r.agePitch).toBe(-3)
    expect(r.profitPitch).toBe(-2)
    expect(r.totalPitch).toBe(0)
    expect(r.newStep).toBe(30)
    expect(r.newDaily).toBe(r.oldDaily) // 据え置き
  })
  it('60号でキャップ', () => {
    const r = computeRevision({ grade: '1G', currentStep: 58, hyogo: 'SS', age: 20, profitRank: 'over10' })
    expect(r.newStep).toBe(MAX_STEP)
  })
})

describe('昇格 promote（読み替え→当期ピッチ加算）', () => {
  it('docs §9 例: 3G35号(18,000) → 4G, +5 → 4G24号(19,025)', () => {
    const cur = dailyForStep('3G', 35)
    expect(cur).toBe(18000)
    const p = promote('4G', cur, 5)
    expect(p.readStep).toBe(19) // 4G19号=18,150 ≥ 18,000
    expect(dailyForStep('4G', 19)).toBe(18150)
    expect(p.newStep).toBe(24)
    expect(p.newDaily).toBe(19025)
  })
})

describe('賞与 bonusPoints / allocateBonus', () => {
  it('点数 = 基礎点ラダー × 評語シフト', () => {
    expect(bonusPoints('6G', 'SS')).toBe(1120)
    expect(bonusPoints('6G', 'A')).toBe(560)
    expect(bonusPoints('1G', 'A')).toBe(100)
    expect(bonusPoints('1G', 'C')).toBe(50)
    expect(bonusPoints('3G', 'A')).toBe(200)
    expect(bonusPoints('doko', 'A')).toBe(200) // 土工=3G相当
  })
  it('原資を点数比で配分（千円丸め・単価一定）', () => {
    const { unit, totalPoints, allocations } = allocateBonus(3000000, [
      { workerId: 1, grade: '6G', hyogo: 'A' }, // 560
      { workerId: 2, grade: '3G', hyogo: 'A' }, // 200
      { workerId: 3, grade: '1G', hyogo: 'A' }, // 100
    ])
    expect(totalPoints).toBe(860)
    expect(unit).toBeCloseTo(3000000 / 860)
    // 各人 = 点数×単価を千円丸め
    expect(allocations[0].amount).toBe(Math.round((560 * unit) / 1000) * 1000)
    // 配分は原資近傍（千円丸め誤差の範囲）
    const sum = allocations.reduce((s, a) => s + a.amount, 0)
    expect(Math.abs(sum - 3000000)).toBeLessThan(3000)
  })
})

describe('定数の健全性', () => {
  it('年間所定日数は290', () => {
    expect(ANNUAL_DAYS).toBe(290)
  })
})

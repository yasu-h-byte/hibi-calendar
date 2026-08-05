import { describe, it, expect } from 'vitest'
import { applyLegalWageFloor, getRaiseAmount } from '@/lib/evaluation-config'

/**
 * 評価昇給の法令フロア
 *
 * 背景（2026-08-04 賃金モデル突合検証）:
 *   評価テーブルの昇給ペース（C連続=年3.3% / B連続=年5.3%）は東京都最低賃金の
 *   上昇（年4〜5%）や建設特定技能の「最賃×1.1」認定要件（国交省 国不国第654号）を
 *   将来割り込む。承認時に「昇給後の時給 >= その時点の下限」を保証する。
 */
describe('applyLegalWageFloor', () => {
  const MW = 1226 // 2025-10 東京都最低賃金

  it('下限を上回る昇給はテーブル値のまま', () => {
    const r = applyLegalWageFloor({ baseRaise: 80, currentHourlyRate: 2000, visa: 'tokutei1', minWage: MW })
    expect(r.floored).toBe(false)
    expect(r.raiseAmount).toBe(80)
  })

  it('特定技能: 昇給後も最賃×1.1未満なら下限まで底上げ', () => {
    // 下限 = ceil(1226 × 1.1) = 1349円。1300 + 30 = 1330 < 1349 → +49 に底上げ
    const r = applyLegalWageFloor({ baseRaise: 30, currentHourlyRate: 1300, visa: 'tokutei1', minWage: MW })
    expect(r.legalMinRate).toBe(1349)
    expect(r.floored).toBe(true)
    expect(r.raiseAmount).toBe(49)
    expect(r.baseRaise).toBe(30)
  })

  it('技能実習: 係数は1.0（最賃そのもの）', () => {
    // 下限 = 1226円。1200 + 20 = 1220 < 1226 → +26 に底上げ
    const r = applyLegalWageFloor({ baseRaise: 20, currentHourlyRate: 1200, visa: 'jisshu2', minWage: MW })
    expect(r.legalMinRate).toBe(1226)
    expect(r.floored).toBe(true)
    expect(r.raiseAmount).toBe(26)
  })

  it('特定2号にも×1.1を適用する', () => {
    const r = applyLegalWageFloor({ baseRaise: 0, currentHourlyRate: 1340, visa: 'tokutei2', minWage: MW })
    expect(r.floored).toBe(true)
    expect(r.raiseAmount).toBe(9)  // 1349 - 1340
  })

  it('時給不明ならフロアを適用せずテーブル値を返す（安全側に壊さない）', () => {
    const r = applyLegalWageFloor({ baseRaise: 60, visa: 'tokutei1', minWage: MW })
    expect(r.floored).toBe(false)
    expect(r.raiseAmount).toBe(60)
  })

  it('検証で見つけたシナリオ: C連続の実習生が特定技能へ移行した年', () => {
    // 起点1230でC連続5年 → 1530円。特定技能移行後の評価C(6年目=+45)では
    // 1575 < 下限1349×…将来最賃で割れる。現在の最賃でも 1.1倍=1349 は上回るが、
    // 最賃が1430になった想定（4.5%×3年後）では下限 ceil(1430×1.1)=1573 → 底上げ発動
    const r = applyLegalWageFloor({ baseRaise: 45, currentHourlyRate: 1530, visa: 'tokutei1', minWage: 1430 })
    expect(r.legalMinRate).toBe(1573)
    expect(r.floored).toBe(false)  // 1530+45=1575 >= 1573 ぎりぎりクリア
    const r2 = applyLegalWageFloor({ baseRaise: 30, currentHourlyRate: 1530, visa: 'tokutei1', minWage: 1430 })
    expect(r2.floored).toBe(true)  // 1560 < 1573 → 発動
    expect(r2.raiseAmount).toBe(43)
  })

  it('D評価（+1%）にもフロアが乗る前提の整合: getRaiseAmount と組み合わせ', () => {
    const base = getRaiseAmount('D', 3, 1300)  // ceil(1300×0.01) = 13
    expect(base).toBe(13)
    const r = applyLegalWageFloor({ baseRaise: base, currentHourlyRate: 1300, visa: 'tokutei1', minWage: MW })
    expect(r.floored).toBe(true)   // 1313 < 1349
    expect(r.raiseAmount).toBe(49)
  })
})

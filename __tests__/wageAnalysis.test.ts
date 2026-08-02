/**
 * 賃金分析（代表専用）のテスト
 *
 * 特に「入社時の最低賃金を起点にした昇給率」は外部データ（東京都の公示額）に
 * 依存するため、代表的な入社日で期待値を固定して回帰を防ぐ。
 */
import { describe, test, expect } from 'vitest'
import {
  minWageAt, roundUp10, stageOf, buildWageAnalysis, currentMinWage,
  modelWage, MODEL_RAISE_RATE, KENSETSU_TOKUTEI,
  findInversions, stageIQROutliers,
} from '@/lib/wage-analysis'

describe('minWageAt（東京都最低賃金）', () => {
  test('発効日当日から新しい額が適用される', () => {
    expect(minWageAt('2016-09-30')).toBe(907)
    expect(minWageAt('2016-10-01')).toBe(932)
    expect(minWageAt('2017-10-01')).toBe(958)
  })

  test('2020年は改定なし（2019年の額が継続）', () => {
    expect(minWageAt('2020-01-15')).toBe(1013)
    expect(minWageAt('2020-10-01')).toBe(1013)
    expect(minWageAt('2021-09-30')).toBe(1013)
  })

  test('2025年の発効日は10月3日', () => {
    expect(minWageAt('2025-10-02')).toBe(1163)
    expect(minWageAt('2025-10-03')).toBe(1226)
  })

  test('現在額', () => {
    expect(currentMinWage('2026-08-01')).toBe(1226)
  })
})

describe('roundUp10（起点時給の丸め）', () => {
  test('10円単位に切り上げ', () => {
    expect(roundUp10(932)).toBe(940)
    expect(roundUp10(958)).toBe(960)
    expect(roundUp10(1013)).toBe(1020)
    expect(roundUp10(1226)).toBe(1230)
  })
  test('ちょうどの値は変えない', () => {
    expect(roundUp10(1080)).toBe(1080)
  })
})

describe('stageOf（在籍年数 → 制度上の段階）', () => {
  test('1年目=実習1号 / 2〜3年目=実習2号 / 4〜5年目=実習3号 / 6年目〜=特定技能', () => {
    expect(stageOf(0)).toBe(0)
    expect(stageOf(0.9)).toBe(0)
    expect(stageOf(1.0)).toBe(1)
    expect(stageOf(2.8)).toBe(1)
    expect(stageOf(3.0)).toBe(2)
    expect(stageOf(3.8)).toBe(2)
    expect(stageOf(5.0)).toBe(3)
    expect(stageOf(9.8)).toBe(3)
  })

  test('特定技能2号は試験合格が要件のため在留資格で判定する', () => {
    // 年数だけなら段階3だが、tokutei2 なら段階4
    expect(stageOf(9.8, 'tokutei2')).toBe(4)
    expect(stageOf(8.8, 'tokutei2')).toBe(4)
    // 同じ年数でも tokutei1 なら段階3のまま（試験未合格）
    expect(stageOf(8.8, 'tokutei1')).toBe(3)
  })
})

describe('modelWage（7%昇給モデル）', () => {
  test('10年で約2倍になる', () => {
    expect(MODEL_RAISE_RATE).toBe(0.07)
    expect(modelWage(1270, 0)).toBe(1270)
    expect(modelWage(1270, 10)).toBeCloseTo(2498, 0)
    expect(modelWage(1270, 10) / 1270).toBeCloseTo(1.97, 2)
  })

  test('定率なので上げ幅は年々大きくなる', () => {
    const d1 = modelWage(1270, 1) - modelWage(1270, 0)
    const d10 = modelWage(1270, 10) - modelWage(1270, 9)
    expect(d1).toBeCloseTo(89, 0)
    expect(d10).toBeCloseTo(163, 0)
    expect(d10).toBeGreaterThan(d1)
  })

  test('建設特定技能の定期昇給要件（月額1,000円/年）を満たす', () => {
    // 1年目の上げ幅を月額換算（140h）しても要件を超える
    const monthly = (modelWage(1270, 1) - modelWage(1270, 0)) * 140
    expect(monthly).toBeGreaterThan(KENSETSU_TOKUTEI.minAnnualRaiseMonthly)
  })

  test('要件を割る昇給率の境目', () => {
    // 起点1270・140h で月額1,000円/年 を割るのは概ね年0.56%未満
    const rate = KENSETSU_TOKUTEI.minAnnualRaiseMonthly / 140 / 1270
    expect(rate * 100).toBeCloseTo(0.56, 1)
    expect((modelWage(1270, 1, 0.005) - 1270) * 140).toBeLessThan(KENSETSU_TOKUTEI.minAnnualRaiseMonthly)
    expect((modelWage(1270, 1, 0.01) - 1270) * 140).toBeGreaterThan(KENSETSU_TOKUTEI.minAnnualRaiseMonthly)
  })
})

describe('buildWageAnalysis', () => {
  const W = [
    { id: 101, name: 'A', visaType: 'tokutei2', hireDate: '2016-10-01', hourlyRate: 2558 },
    { id: 109, name: 'B', visaType: 'tokutei1', hireDate: '2020-01-15', hourlyRate: 2214 },
    { id: 110, name: 'C', visaType: 'tokutei1', hireDate: '2020-01-15', hourlyRate: 2150 },
    { id: 202, name: 'D', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1464 },
    { id: 201, name: 'E', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1513 },
  ]
  const r = buildWageAnalysis(W, '2026-08-01')
  const by = (n: string) => r.rows.find(x => x.name === n)!

  test('起点は入社時最低賃金の10円切上げ', () => {
    expect(by('A').hireMinWage).toBe(932)
    expect(by('A').startWage).toBe(940)
    expect(by('B').hireMinWage).toBe(1013)
    expect(by('B').startWage).toBe(1020)
  })

  test('昇給率は起点からの複利', () => {
    // 2558 / 940 を 9.8年で複利換算 → 約10.8%
    expect(by('A').cagr).toBeCloseTo(10.76, 1)
    expect(by('B').cagr).toBeCloseTo(12.66, 1)
  })

  test('実質＝昇給率 − 同期間の最賃上昇率', () => {
    const a = by('A')
    expect(a.realGain).toBeCloseTo(a.cagr! - a.minWageCagr!, 5)
    expect(a.realGain!).toBeGreaterThan(0) // 最賃の伸びを上回っている
  })

  test('現在の最低賃金に対する倍率', () => {
    expect(by('A').vsMinWage).toBeCloseTo(2558 / 1226, 3)
  })

  test('同期比較は同じ入社年月の人だけを見る', () => {
    // B と C は 2020-01 の同期
    expect(by('B').devCohort).toBeCloseTo(2214 - 2150, 5)
    expect(by('C').devCohort).toBeCloseTo(2150 - 2214, 5)
    // A は同期なし
    expect(by('A').devCohort).toBeNull()
  })

  test('特定2号は特定1号と別の段階として集計される', () => {
    // A は tokutei2（9.8年）→ 段階4。B/C は tokutei1（6.5年）→ 段階3。
    expect(by('A').stage).toBe(4)
    expect(by('B').stage).toBe(3)
    // 段階3の平均は B と C だけ（A を混ぜない）
    expect(r.stageAvg[3]).toBeCloseTo((2214 + 2150) / 2, 5)
    expect(r.stageAvg[4]).toBeCloseTo(2558, 5)
  })

  test('段階内平均との差', () => {
    // D と E は在籍3.8年 → 実習3号。平均は (1464+1513)/2 = 1488.5
    expect(by('D').devStage).toBeCloseTo(1464 - 1488.5, 5)
    expect(by('E').devStage).toBeCloseTo(1513 - 1488.5, 5)
  })

  test('3基準すべてで低い人を検出する', () => {
    // D は段階内・同期ともに下、傾向線でも下
    expect(by('D').allLow).toBe(true)
    expect(by('D').allHigh).toBe(false)
  })

  test('しきい値以内なら高いとも低いとも判定しない', () => {
    const r2 = buildWageAnalysis(W, '2026-08-01', 1000)
    expect(r2.rows.every(x => !x.allLow && !x.allHigh)).toBe(true)
  })

  test('モデル起点は在籍0年の人の時給を使う', () => {
    const r4 = buildWageAnalysis([
      ...W,
      { id: 207, name: 'NEW', visaType: 'jisshu1', hireDate: '2026-08-01', hourlyRate: 1270 },
    ], '2026-08-01')
    expect(r4.modelStart).toBe(1270)
    // 10年後は約2倍
    expect(r4.rows.find(x => x.name === 'NEW')!.model).toBeCloseTo(1270, 5)
  })

  test('特定技能1号の報酬下限は最低賃金×1.1', () => {
    expect(r.tokuteiFloor).toBeCloseTo(1226 * 1.1, 5)
  })

  test('入社日が無い場合でも落ちない', () => {
    const r3 = buildWageAnalysis(
      [{ id: 1, name: 'X', visaType: 'jisshu1', hireDate: '', hourlyRate: 1270 }],
      '2026-08-01',
    )
    expect(r3.rows[0].years).toBe(0)
    expect(r3.rows[0].cagr).toBeNull()
  })
})

describe('findInversions（逆転ペア検出）', () => {
  // 実データ相当のミニセット: ケン(3.2年¥1581)がラップ(3.8年¥1464)を逆転している
  const W = [
    { id: 107, name: 'ケン', visaType: 'jisshu3', hireDate: '2023-05-14', hourlyRate: 1581 },
    { id: 202, name: 'ラップ', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1464 },
    { id: 109, name: 'リン', visaType: 'tokutei1', hireDate: '2020-01-15', hourlyRate: 2214 },
  ]
  const rows = buildWageAnalysis(W, '2026-08-03').rows

  test('在籍が長いのに時給が低いペアを検出する', () => {
    const r = findInversions(rows)
    expect(r.discordant).toBe(1)
    const p = r.pairs[0]
    expect(p.senior.name).toBe('ラップ')
    expect(p.junior.name).toBe('ケン')
    expect(p.gap).toBe(1581 - 1464)
  })

  test('順方向のペアは concordant に数える', () => {
    const r = findInversions(rows)
    // リン>ケン, リン>ラップ が順方向
    expect(r.concordant).toBe(2)
    expect(r.tau).toBeCloseTo((2 - 1) / 3, 5)
  })

  test('在籍差が閾値以下のペアは比較しない', () => {
    const near = buildWageAnalysis([
      { id: 1, name: 'A', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1500 },
      { id: 2, name: 'B', visaType: 'jisshu3', hireDate: '2022-11-01', hourlyRate: 1400 },
    ], '2026-08-03').rows
    expect(findInversions(near).discordant + findInversions(near).concordant).toBe(0)
  })
})

describe('stageIQROutliers（段階内の外れ値）', () => {
  test('実習3号相当の5名でケンが上側・ラップが下側の外れ値になる', () => {
    const rows = buildWageAnalysis([
      { id: 107, name: 'ケン', visaType: 'jisshu3', hireDate: '2023-05-14', hourlyRate: 1581 },
      { id: 106, name: 'タン', visaType: 'tokutei1', hireDate: '2023-05-14', hourlyRate: 1527 },
      { id: 201, name: 'グエン', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1513 },
      { id: 203, name: 'ハウ', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1513 },
      { id: 202, name: 'ラップ', visaType: 'jisshu3', hireDate: '2022-10-01', hourlyRate: 1464 },
    ], '2026-08-03').rows
    const out = stageIQROutliers(rows)
    expect(out).toHaveLength(1)
    expect(out[0].high.map(r => r.name)).toEqual(['ケン'])
    expect(out[0].low.map(r => r.name)).toEqual(['ラップ'])
  })

  test('3名未満の段階は判定しない', () => {
    const rows = buildWageAnalysis([
      { id: 1, name: 'A', visaType: 'jisshu2', hireDate: '2023-10-23', hourlyRate: 1425 },
      { id: 2, name: 'B', visaType: 'jisshu2', hireDate: '2023-10-23', hourlyRate: 9999 },
    ], '2026-08-03').rows
    expect(stageIQROutliers(rows)).toHaveLength(0)
  })
})

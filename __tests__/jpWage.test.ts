import { describe, it, expect } from 'vitest'
import {
  dailyForStep, capDaily, baseAnnual, stepForDaily, dailyFromMonthly,
  HYOGO_PITCH, ageAdjustment, profitAdjustment, profitRankOf, specialAdjustment,
  computeRevision, promote, bonusPoints, allocateBonus, MAX_STEP, ANNUAL_DAYS,
  ageOn, nextRevisionDate, monthsBetween, checkHyogoBalance, computeRosterRevision, type RosterMember,
  paySheetFigures, baseAnnualWithLeave, TOTAL_PAID_DAYS,
} from '@/lib/jp-wage'
import { MIGRATION_2026, MIGRATION_EXCLUDED } from '@/lib/jp-wage-migration'

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

describe('2026年度移行: 現員（docs §12 と一致・日額は下げない）', () => {
  // 月給制の1年目（fromDaily=null）と、調整給つきの者は別に検証する
  it.each(MIGRATION_2026.filter(m => m.fromDaily !== null && !m.adjustment))(
    '$name: $fromDaily → $step号',
    ({ grade, fromDaily, step }) => {
      expect(stepForDaily(grade, fromDaily!)).toBe(step)
      expect(dailyForStep(grade, step!)).toBeGreaterThanOrEqual(fromDaily!)
    },
  )
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

describe('MIGRATION_2026（号俸制への移行シード）', () => {
  it('号俸額 + 調整給 で移行前日額を下回らない（読み替えの原則）', () => {
    for (const m of MIGRATION_2026) {
      if (m.fromDaily === null || m.step === null) continue
      const total = dailyForStep(m.grade, m.step) + (m.adjustment ?? 0)
      expect(total).toBeGreaterThanOrEqual(m.fromDaily)
    }
  })

  it('調整給が無い人は、移行前日額がその等級の上限に収まっている', () => {
    for (const m of MIGRATION_2026) {
      if (m.fromDaily === null || m.adjustment) continue
      expect(m.fromDaily).toBeLessThanOrEqual(capDaily(m.grade))
    }
  })

  it('調整給がある人は上限を超えており、超過分と調整給が一致する', () => {
    for (const m of MIGRATION_2026) {
      if (!m.adjustment || m.fromDaily === null || m.step === null) continue
      // 調整給は「役割等級では払えない分」なので、上限に置いたうえでの差額に等しい
      expect(m.step).toBe(60)
      expect(m.fromDaily).toBeGreaterThan(capDaily(m.grade))
      expect(m.adjustment).toBe(m.fromDaily - capDaily(m.grade))
    }
  })

  it('workerId が一意で、役員（id:1）を含まない', () => {
    const ids = MIGRATION_2026.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(1)
    expect(MIGRATION_EXCLUDED).toContain(1)
  })

  it('梶原さんは 4G上限 + 移籍調整給 で28,000円になり、処遇は固定', () => {
    const k = MIGRATION_2026.find(m => m.id === 10)!
    expect(k.grade).toBe('4G')
    expect(k.step).toBe(60)          // 4Gの上限。構造として号が上がらない
    expect(k.fixed).toBe(true)
    expect(dailyForStep('4G', 60)).toBe(23575)
    expect(k.adjustment).toBe(4425)
    expect(dailyForStep(k.grade, k.step!) + k.adjustment!).toBe(28000)
  })

  it('処遇固定の人は等級の上限に置かれている（号で上がらないことの担保）', () => {
    for (const m of MIGRATION_2026) {
      if (!m.fixed) continue
      expect(m.step).toBe(60)
    }
  })

  it('移行による増額は合計685円/日（梶原さんは調整給で±0）', () => {
    const inc = MIGRATION_2026.reduce((s, m) => {
      if (m.fromDaily === null || m.step === null) return s
      return s + (dailyForStep(m.grade, m.step) + (m.adjustment ?? 0) - m.fromDaily)
    }, 0)
    expect(inc).toBe(685)
  })
})

describe('ageOn（基準日時点の満年齢）', () => {
  it('誕生日を迎えていれば加齢している', () => {
    expect(ageOn('1980-09-30', '2026-10-01')).toBe(46)
  })

  it('誕生日前なら1つ少ない', () => {
    expect(ageOn('1980-10-02', '2026-10-01')).toBe(45)
  })

  it('誕生日当日は加齢している', () => {
    expect(ageOn('1980-10-01', '2026-10-01')).toBe(46)
  })

  it('タイムゾーンに影響されない（文字列で比較している）', () => {
    // new Date() を挟むと UTC 深夜解釈で1日ずれ、誕生日当日の判定が変わる
    const tz = process.env.TZ
    try {
      for (const z of ['UTC', 'Asia/Tokyo', 'America/Chicago']) {
        process.env.TZ = z
        expect(ageOn('1980-10-01', '2026-10-01')).toBe(46)
      }
    } finally { process.env.TZ = tz }
  })
})

describe('checkHyogoBalance（ペア評価のルール）', () => {
  it('SをBとペアで出していれば通る', () => {
    const b = checkHyogoBalance(['S', 'A', 'A', 'B'])
    expect(b.ok).toBe(true)
  })

  it('Bを伴わないSは不足として出る', () => {
    const b = checkHyogoBalance(['S', 'S', 'A', 'B'])
    expect(b.ok).toBe(false)
    expect(b.needB).toBe(1)
    expect(b.messages[0]).toContain('あと 1名 B が必要')
  })

  it('SSはCとペアで見る（Bでは代替できない）', () => {
    expect(checkHyogoBalance(['SS', 'A', 'B']).needC).toBe(1)
    expect(checkHyogoBalance(['SS', 'A', 'C']).ok).toBe(true)
  })

  it('全員Aなら当然通る', () => {
    expect(checkHyogoBalance(['A', 'A', 'A']).ok).toBe(true)
  })
})

describe('computeRosterRevision（名簿全体の改定）', () => {
  const base = { asOf: '2026-10-01', profitRatePercent: 6 }
  const m = (o: Partial<RosterMember>): RosterMember => ({
    id: 1, name: 'テスト', grade: '3G', currentStep: 30,
    birthDate: '1990-01-01', hyogo: 'A', ...o,
  })

  it('標準（A評価）で号が進み、日額が上がる', () => {
    const r = computeRosterRevision([m({})], base)
    const row = r.rows[0]
    expect(row.result).not.toBeNull()
    // A=4ピッチ、31〜35歳は年齢調整0、利益6%(over5)は3Gで0
    expect(row.result!.totalPitch).toBe(4)
    expect(row.result!.newStep).toBe(34)
    expect(r.applied).toBe(1)
  })

  it('生年月日が無い人は計算せず、理由を返す', () => {
    const r = computeRosterRevision([m({ birthDate: null })], base)
    expect(r.rows[0].result).toBeNull()
    expect(r.rows[0].blockers[0]).toContain('生年月日')
    expect(r.blocked).toBe(1)
    expect(r.raisePerDay).toBe(0)
  })

  it('号が未確定の人も計算しない', () => {
    const r = computeRosterRevision([m({ currentStep: null })], base)
    expect(r.rows[0].blockers).toContain('号が未確定')
  })

  it('S評価は理由がないと計算しない', () => {
    expect(computeRosterRevision([m({ hyogo: 'S' })], base).rows[0].blockers[0]).toContain('理由')
    expect(computeRosterRevision([m({ hyogo: 'S', reason: '大型現場を完遂' })], base).rows[0].result).not.toBeNull()
  })

  it('A評価は理由がなくてよい（標準だから）', () => {
    expect(computeRosterRevision([m({ hyogo: 'A' })], base).rows[0].blockers).toEqual([])
  })

  it('処遇固定の人は号が動かず、調整給込みの日額が前後で同じ', () => {
    const r = computeRosterRevision(
      [m({ grade: '4G', currentStep: 60, adjustment: 4425, fixed: true, birthDate: null })],
      base,
    )
    const row = r.rows[0]
    expect(row.result).toBeNull()
    expect(row.oldTotal).toBe(28000)
    expect(row.newTotal).toBe(28000)
    expect(r.blocked).toBe(0)   // 固定は「入力不足」ではない
    expect(r.raisePerDay).toBe(0)
  })

  it('調整給は改定後の日額にも引き継がれる', () => {
    const r = computeRosterRevision([m({ grade: '3G', currentStep: 30, adjustment: 500 })], base)
    const row = r.rows[0]
    expect(row.newTotal! - row.oldTotal!).toBe(row.result!.raisePerDay)
    expect(row.newTotal).toBe(row.result!.newDaily + 500)
  })

  it('年齢調整が効く（46〜50歳の2Gは −3ピッチ）', () => {
    const young = computeRosterRevision([m({ grade: '2G', birthDate: '1994-01-01' })], base)
    const old = computeRosterRevision([m({ grade: '2G', birthDate: '1978-01-01' })], base)
    expect(young.rows[0].result!.agePitch).toBe(0)   // 32歳
    expect(old.rows[0].result!.agePitch).toBe(-3)    // 48歳
    expect(old.rows[0].result!.totalPitch).toBe(1)   // A(4) − 3
  })

  it('評語のバランスは改定対象者だけで判定する', () => {
    const r = computeRosterRevision([
      m({ id: 1, hyogo: 'S', reason: '完遂' }),
      m({ id: 2, hyogo: 'B', reason: '出勤状況' }),
      m({ id: 3, hyogo: 'S', reason: '育成', fixed: true }),   // 固定＝母数外
    ], base)
    expect(r.balance.counts.S).toBe(1)
    expect(r.balance.ok).toBe(true)
  })

  it('年間コストは 1日あたり × 年間所定日数', () => {
    const r = computeRosterRevision([m({})], { ...base, annualDays: 290 })
    expect(r.annualCost).toBe(r.raisePerDay * 290)
  })
})

describe('nextRevisionDate（改定の基準日）', () => {
  it('10月1日より前なら今年の10月1日', () => {
    expect(nextRevisionDate('2026-08-25')).toBe('2026-10-01')
  })

  it('10月1日当日はその日', () => {
    expect(nextRevisionDate('2026-10-01')).toBe('2026-10-01')
  })

  it('10月1日を過ぎたら翌年', () => {
    expect(nextRevisionDate('2026-10-02')).toBe('2027-10-01')
    expect(nextRevisionDate('2026-12-31')).toBe('2027-10-01')
  })
})

describe('中途採用の初回改定', () => {
  const base = { asOf: '2026-10-01', profitRatePercent: 6 }
  const m = (o: Partial<RosterMember>): RosterMember => ({
    id: 20, name: '中途 太郎', grade: '3G', currentStep: 20,
    birthDate: '1990-01-01', hyogo: 'A', ...o,
  })

  it('monthsBetween は満月数を返す', () => {
    expect(monthsBetween('2026-09-15', '2026-10-01')).toBe(0)
    expect(monthsBetween('2026-04-01', '2026-10-01')).toBe(6)
    expect(monthsBetween('2026-04-02', '2026-10-01')).toBe(5)  // 日が足りない
    expect(monthsBetween('2025-10-01', '2026-10-01')).toBe(12)
  })

  it('9月半ば入社は10月の改定対象外になる', () => {
    const r = computeRosterRevision([m({ hireDate: '2026-09-15' })], base)
    expect(r.rows[0].status).toBe('ineligible')
    expect(r.rows[0].tenureMonths).toBe(0)
    expect(r.rows[0].blockers[0]).toContain('在籍0ヶ月')
    expect(r.ineligible).toBe(1)
    expect(r.raisePerDay).toBe(0)
  })

  it('対象外でも日額は据え置き（下がらない）', () => {
    const r = computeRosterRevision([m({ hireDate: '2026-09-15' })], base)
    expect(r.rows[0].newTotal).toBe(r.rows[0].oldTotal)
  })

  it('在籍6ヶ月ちょうどなら対象になる', () => {
    const r = computeRosterRevision([m({ hireDate: '2026-04-01' })], base)
    expect(r.rows[0].status).toBe('ok')
  })

  it('forceInclude で既定を上書きできる', () => {
    const r = computeRosterRevision([m({ hireDate: '2026-09-15', forceInclude: true })], base)
    expect(r.rows[0].status).toBe('ok')
    expect(r.rows[0].result!.totalPitch).toBeGreaterThan(0)
  })

  it('入社日が未登録なら在籍で弾かない（他の不足で止める）', () => {
    const r = computeRosterRevision([m({ hireDate: null })], base)
    expect(r.rows[0].status).toBe('ok')
    expect(r.rows[0].tenureMonths).toBeNull()
  })

  it('対象外の人は評語のバランス母数に入らない', () => {
    const r = computeRosterRevision([
      m({ id: 1, hyogo: 'S', reason: '完遂' }),
      m({ id: 2, hyogo: 'B', reason: '出勤' }),
      m({ id: 3, hyogo: 'S', reason: '育成', hireDate: '2026-09-15' }),
    ], base)
    expect(r.balance.counts.S).toBe(1)
    expect(r.balance.ok).toBe(true)
  })

  it('status で内訳が数えられる', () => {
    const r = computeRosterRevision([
      m({ id: 1 }),
      m({ id: 2, hireDate: '2026-09-15' }),
      m({ id: 3, fixed: true, currentStep: 60 }),
      m({ id: 4, birthDate: null }),
    ], base)
    expect(r.applied).toBe(1)
    expect(r.ineligible).toBe(1)
    expect(r.blocked).toBe(1)
    expect(r.rows.find(x => x.member.id === 3)!.status).toBe('fixed')
  })
})

describe('paySheetFigures（給料表の換算）', () => {
  /**
   * 2025年10月改定版の実物（とび事業部給料表）の数値。
   * 様式を作り替えても数字がズレないよう、実際に本人へ渡した値で固定する。
   * [氏名, 確定日給, 改訂前, 有給買取額, 日給換算, 前期実質日給, 実質日給, 昇給(日), 昇給(年), ベース年収, UP率%]
   */
  const REAL = [
    ['大川 愛志', 23550, 22650, 471000, 1624, 24212, 25174, 962, 279000, 7300500, 4.0],
    ['白戸 寛之', 21300, 20780, 426000, 1469, 22213, 22769, 556, 161200, 6603000, 2.5],
    ['入江 隆太', 19700, 19220, 394000, 1359, 20546, 21059, 513, 148800, 6107000, 2.5],
    ['倉本 隆次', 19100, 18620, 382000, 1317, 19904, 20417, 513, 148800, 5921000, 2.6],
    ['日比 大介', 17780, 16940, 355600, 1226, 18108, 19006, 898, 260400, 5511800, 5.0],
    ['本田 文人', 17655, 17465, 353100, 1218, 18669, 18873, 203, 58900, 5473050, 1.1],
    ['新山 正昭', 12300, 12130, 246000, 848, 12967, 13148, 182, 52700, 3813000, 1.4],
  ] as const

  it.each(REAL)('%s の給料表の数値が実物と一致する', (_n, daily, prev, buyout, perDay, prevEff, eff, rDay, rYear, base, up) => {
    const f = paySheetFigures(Number(daily), Number(prev))
    expect(f.leaveBuyout).toBe(buyout)
    expect(Math.round(f.leavePerDay)).toBe(perDay)
    expect(Math.round(f.prevEffectiveDaily)).toBe(prevEff)
    expect(Math.round(f.effectiveDaily)).toBe(eff)
    expect(Math.round(f.raisePerDay)).toBe(rDay)
    expect(f.raisePerYear).toBe(rYear)
    expect(f.baseAnnual).toBe(base)
    expect(Number((f.upRate * 100).toFixed(1))).toBe(up)
  })

  it('ベース年収は 日額 × 310（稼働290 + 有給20）', () => {
    expect(TOTAL_PAID_DAYS).toBe(310)
    expect(baseAnnualWithLeave(23550)).toBe(23550 * 310)
  })

  it('昇給（年）は日額の差 × 310', () => {
    expect(paySheetFigures(23550, 22650).raisePerYear).toBe(900 * 310)
  })
})

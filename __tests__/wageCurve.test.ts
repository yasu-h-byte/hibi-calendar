/**
 * 賃金カーブ（逓減定額モデル）と 2026年10月 一律改定のテスト。
 *
 * 数字が独り歩きしないよう、代表決定時に確認した値をそのまま期待値に置いている。
 * カーブを変更するときはここも一緒に変えること（変えずに落ちたら、それは事故）。
 */

import { describe, it, expect } from 'vitest'
import {
  CURVE_BASE_RAISE, CURVE_DECAY, CURVE_MIN_RAISE,
  curveRaiseAt, curveWage, curveStartFor,
  WAGE_REVISION_2026_10, SCHEDULED_WAGE_CHANGES, revisedHourly, pendingChangesFor, MONTHLY_HOURS,
} from '@/lib/wage-curve'
import { buildWageAnalysis, WAGE_CONTEXT } from '@/lib/wage-analysis'

describe('curveRaiseAt（昇給額 = 160円 − 8円 × 在籍年数）', () => {
  it('定義どおりに逓減する', () => {
    expect(curveRaiseAt(0)).toBe(160)
    expect(curveRaiseAt(1)).toBe(152)
    expect(curveRaiseAt(2)).toBe(144)
    expect(curveRaiseAt(4)).toBe(128)
    expect(curveRaiseAt(9)).toBe(88)
  })

  it('11年目以降は下限80円で頭打ちになる', () => {
    expect(curveRaiseAt(10)).toBe(CURVE_MIN_RAISE)
    expect(curveRaiseAt(11)).toBe(CURVE_MIN_RAISE)
    expect(curveRaiseAt(30)).toBe(CURVE_MIN_RAISE)
  })

  it('定数から計算式どおりに導ける（マジックナンバーになっていない）', () => {
    expect(curveRaiseAt(3)).toBe(CURVE_BASE_RAISE - CURVE_DECAY * 3)
  })
})

describe('curveWage（カーブ上の時給）', () => {
  // 代表決定時（2026-08-12）に確認した到達点。起点1,230円。
  it.each([
    [0, 1230],
    [1, 1390],
    [3, 1686],
    [5, 1950],
    [10, 2470],
    [15, 2870],
  ])('起点1230円・在籍%d年 → %d円', (years, expected) => {
    expect(curveWage(1230, years)).toBe(expected)
  })

  it('端数年は次の昇給額で直線補間する', () => {
    // 3年目→4年目の昇給は136円。その半分だけ進んだ位置
    expect(curveWage(1230, 3.5)).toBeCloseTo(1686 + 136 / 2, 6)
  })

  it('在籍0年以下は起点のまま', () => {
    expect(curveWage(1230, 0)).toBe(1230)
    expect(curveWage(1230, -1)).toBe(1230)
  })

  it('起点が変わってもカーブの形（差分）は変わらない', () => {
    expect(curveWage(1270, 5) - curveWage(1230, 5)).toBe(40)
  })
})

describe('curveStartFor（起点は最賃の10円切上げ）', () => {
  it('東京都最賃1,226円 → 1,230円', () => {
    expect(curveStartFor(1226)).toBe(1230)
  })

  it('ちょうど10円単位ならそのまま', () => {
    expect(curveStartFor(1230)).toBe(1230)
  })
})

describe('SCHEDULED_WAGE_CHANGES（予定されている改定）', () => {
  it('実施日の早い順に並んでいる', () => {
    const days = SCHEDULED_WAGE_CHANGES.map(c => c.effective)
    expect([...days].sort()).toEqual(days)
  })

  it('3号移行は雇用契約書どおり 1,585円（月給221,900 ÷ 所定140時間）', () => {
    const c = SCHEDULED_WAGE_CHANGES.find(x => x.id === 'jisshu3-2026-09')!
    expect(c.effective).toBe('2026-09-21')
    expect(c.targets[205]).toBe(1585)
    expect(c.targets[206]).toBe(1585)
    expect(221900 / MONTHLY_HOURS).toBe(1585)
  })
})

describe('WAGE_REVISION_2026_10（一律9.365%改定）', () => {
  const targets = WAGE_REVISION_2026_10.targets

  it('対象は5名（ゴック・サンは3号移行契約でカバー済みのため含めない）', () => {
    expect(Object.keys(targets)).toHaveLength(5)
    expect(targets[205]).toBeUndefined()
    expect(targets[206]).toBeUndefined()
  })

  it('全員が一律の率で計算されている（10円未満四捨五入）', () => {
    const before: Record<number, number> = {
      107: 1581, 106: 1527, 201: 1513, 203: 1513, 202: 1464,
    }
    for (const [id, after] of Object.entries(targets)) {
      const cur = before[Number(id)]
      expect(Math.round(cur * (1 + WAGE_REVISION_2026_10.rate!))).toBe(after)
    }
  })

  it('ゴック・サンに一律率を当てると3号契約額を下回る（＝適用できない）', () => {
    const uniform = Math.round(1425 * (1 + WAGE_REVISION_2026_10.rate!))
    expect(uniform).toBe(1558)
    expect(uniform).toBeLessThan(1585)
  })

  it('3号移行の上げ幅は10月の一律改定より大きい（外れたことにならない）', () => {
    const jisshu3Rate = 1585 / 1425 - 1
    expect(jisshu3Rate).toBeGreaterThan(WAGE_REVISION_2026_10.rate!)
  })

  it('率はタンの要望額（月+2万円）から逆算した値と一致する', () => {
    // 1527 → 1670 は時給+143円。所定140時間で月額 +20,020円
    expect(targets[106]).toBe(1670)
    expect((targets[106] - 1527) * MONTHLY_HOURS).toBe(20020)
  })
})

describe('revisedHourly（改定後の時給）', () => {
  it('対象者は予定額を返す', () => {
    expect(revisedHourly(106, 1527)).toBe(1670)
  })

  it('3号移行の対象者は契約額1,585円を返す（一律率の1,558円ではない）', () => {
    expect(revisedHourly(205, 1425)).toBe(1585)
    expect(revisedHourly(206, 1425)).toBe(1585)
  })

  it('未反映の予定を列挙できる', () => {
    expect(pendingChangesFor(205, 1425).map(c => c.id)).toEqual(['jisshu3-2026-09'])
    expect(pendingChangesFor(205, 1585)).toEqual([])
    expect(pendingChangesFor(101, 2558)).toEqual([])
  })

  it('対象外は現在の時給をそのまま返す', () => {
    expect(revisedHourly(101, 2558)).toBe(2558)
  })

  it('すでに予定額を上回っていれば引き下げない（マスタ反映後の二重適用防止）', () => {
    expect(revisedHourly(106, 1700)).toBe(1700)
  })

  it('マスタが予定額ちょうどなら差分は0になる（＝反映済みと判定できる）', () => {
    expect(revisedHourly(106, 1670) - 1670).toBe(0)
  })
})

describe('buildWageAnalysis のカーブ・改定フィールド', () => {
  const workers = [
    { id: 106, name: 'タン', visaType: 'tokutei1', hireDate: '2023-05-14', hourlyRate: 1527 },
    { id: 101, name: 'フウ', visaType: 'tokutei2', hireDate: '2016-10-01', hourlyRate: 2558 },
  ]
  const a = buildWageAnalysis(workers, '2026-08-25')
  const tan = a.rows.find(r => r.id === 106)!
  const fuu = a.rows.find(r => r.id === 101)!

  it('カーブ起点は現在の最賃の10円切上げ', () => {
    expect(a.curveStart).toBe(1230)
  })

  it('改定対象を判定できる', () => {
    expect(tan.revisionTarget).toBe(true)
    expect(fuu.revisionTarget).toBe(false)
  })

  it('改定後の時給と上げ幅が入る', () => {
    expect(tan.revised).toBe(1670)
    expect(tan.revisionGain).toBe(143)
    expect(fuu.revisionGain).toBe(0)
  })

  it('カーブとの差は改定で縮む（ただし在籍3.3年ではまだ届かない）', () => {
    expect(tan.devCurve).toBeLessThan(tan.devCurveRevised)
    expect(tan.devCurveRevised).toBeLessThan(0)
  })

  it('年間コストは 上げ幅 × 所定時間 × 12 で積む', () => {
    expect(a.revision.annualCost).toBe(143 * MONTHLY_HOURS * 12)
  })

  it('未反映人数を数えられる', () => {
    expect(a.revision.pending).toBe(1)
  })

  it('事由ごとに内訳が分かれる', () => {
    const withGoc = buildWageAnalysis(
      [...workers, { id: 205, name: 'ゴック', visaType: 'jisshu2', hireDate: '2023-10-23', hourlyRate: 1425 }],
      '2026-08-25',
    )
    const j3 = withGoc.revision.changes.find(c => c.id === 'jisshu3-2026-09')!
    const uni = withGoc.revision.changes.find(c => c.id === 'uniform-2026-10')!
    expect(j3.count).toBe(1)
    expect(j3.annualCost).toBe((1585 - 1425) * MONTHLY_HOURS * 12)
    expect(uni.count).toBe(1) // タンのみ（ゴックは一律改定の対象外）
    expect(withGoc.rows.find(r => r.id === 205)!.changeLabels).toEqual(['技能実習3号 移行'])
  })

  it('マスタ反映後は未反映0・コスト0になる', () => {
    const after = buildWageAnalysis(
      workers.map(w => (w.id === 106 ? { ...w, hourlyRate: 1670 } : w)),
      '2026-08-25',
    )
    expect(after.revision.pending).toBe(0)
    expect(after.revision.annualCost).toBe(0)
  })

  it('実際の新規入社時給（entryWage）を拾う', () => {
    const withNew = buildWageAnalysis(
      [...workers, { id: 207, name: 'フォン', visaType: 'jisshu1', hireDate: '2026-08-01', hourlyRate: 1270 }],
      '2026-08-25',
    )
    expect(withNew.entryWage).toBe(1270)
    // 起点はあくまで最賃連動。入社時給に引きずられない
    expect(withNew.curveStart).toBe(1230)
  })
})

describe('WAGE_CONTEXT（個別事情の注記）', () => {
  const workers = [
    { id: 105, name: 'アイン', visaType: 'tokutei1', hireDate: '2018-11-01', hourlyRate: 2166 },
    { id: 101, name: 'フウ', visaType: 'tokutei2', hireDate: '2016-10-01', hourlyRate: 2558 },
  ]

  it('事情のある人には注記が付く', () => {
    const a = buildWageAnalysis(workers, '2026-08-25')
    expect(a.rows.find(r => r.id === 105)!.context?.label).toBe('再入社')
    expect(a.rows.find(r => r.id === 101)!.context).toBeUndefined()
  })

  it('注記があってもフラグからは除外しない（解消の検討を忘れないため）', () => {
    const a = buildWageAnalysis(workers, '2026-08-25')
    const ain = a.rows.find(r => r.id === 105)!
    // カーブを下回っている事実は消さない
    expect(ain.devCurve).toBeLessThan(0)
  })

  it('serviceYears を入れると在籍年数がその値で上書きされる', () => {
    const orig = { ...WAGE_CONTEXT[105] }
    WAGE_CONTEXT[105] = { ...orig, serviceYears: 5.0 }
    try {
      const a = buildWageAnalysis(workers, '2026-08-25')
      const ain = a.rows.find(r => r.id === 105)!
      expect(ain.years).toBe(5.0)
      // 在籍が短くなればカーブ上の期待値も下がり、差は縮む
      expect(ain.curve).toBe(curveWage(1230, 5))
      expect(ain.devCurve).toBeGreaterThan(0)
    } finally {
      WAGE_CONTEXT[105] = orig
    }
  })
})

describe('basis（集計の基準）の切り替え', () => {
  const workers = [
    { id: 106, name: 'タン', visaType: 'tokutei1', hireDate: '2023-05-14', hourlyRate: 1527 },
    { id: 205, name: 'ゴック', visaType: 'jisshu2', hireDate: '2023-10-23', hourlyRate: 1425 },
    { id: 101, name: 'フウ', visaType: 'tokutei2', hireDate: '2016-10-01', hourlyRate: 2558 },
  ]
  const cur = buildWageAnalysis(workers, '2026-08-25', 20, 'current')
  const rev = buildWageAnalysis(workers, '2026-08-25', 20, 'revised')

  it('current では hourly がマスタの現在値', () => {
    expect(cur.rows.find(r => r.id === 106)!.hourly).toBe(1527)
    expect(cur.rows.find(r => r.id === 205)!.hourly).toBe(1425)
  })

  it('revised では hourly が改定後の額', () => {
    expect(rev.rows.find(r => r.id === 106)!.hourly).toBe(1670)
    expect(rev.rows.find(r => r.id === 205)!.hourly).toBe(1585)
  })

  it('currentHourly は basis に関わらず常にマスタの現在値', () => {
    for (const a of [cur, rev]) {
      expect(a.rows.find(r => r.id === 106)!.currentHourly).toBe(1527)
      expect(a.rows.find(r => r.id === 205)!.currentHourly).toBe(1425)
    }
  })

  it('改定対象外の人は basis で変わらない', () => {
    expect(cur.rows.find(r => r.id === 101)!.hourly).toBe(2558)
    expect(rev.rows.find(r => r.id === 101)!.hourly).toBe(2558)
  })

  it('未反映人数・年間コストは basis で変わらない（どちらもマスタ基準）', () => {
    expect(rev.revision.pending).toBe(cur.revision.pending)
    expect(rev.revision.annualCost).toBe(cur.revision.annualCost)
    expect(rev.revision.pending).toBe(2)
  })

  it('平均・段階平均などの集計も改定後で再計算される', () => {
    expect(rev.overallAvg).toBeGreaterThan(cur.overallAvg)
    // (1670+1585+2558)/3 と (1527+1425+2558)/3 の差 = (143+160)/3
    expect(rev.overallAvg - cur.overallAvg).toBeCloseTo((143 + 160) / 3, 6)
  })

  it('revised では devCurve が改定後の差と一致する', () => {
    const t = rev.rows.find(r => r.id === 106)!
    expect(t.devCurve).toBe(t.devCurveRevised)
  })

  it('current では devCurve が改定前の差になる', () => {
    const t = cur.rows.find(r => r.id === 106)!
    expect(t.devCurve).toBeLessThan(t.devCurveRevised)
  })

  it('既定は current（明示しない呼び出しの挙動を変えない）', () => {
    expect(buildWageAnalysis(workers, '2026-08-25').basis).toBe('current')
  })
})

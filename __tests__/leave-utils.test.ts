import { describe, it, expect } from 'vitest'
import { calcGrantMonthFromHire, calcLegalPL, rateBarColor, getJPHolidays } from '@/lib/leave-utils'

describe('calcGrantMonthFromHire: 入社日+6ヶ月の発生月', () => {
  it('入社月+6ヶ月の月を返す', () => {
    expect(calcGrantMonthFromHire('2025-01-10')).toBe(7)
    expect(calcGrantMonthFromHire('2025-08-01')).toBe(2)  // 年跨ぎ
  })

  it('月末入社でも月計算が壊れない', () => {
    expect(calcGrantMonthFromHire('2025-07-31')).toBe(1)  // 7月+6ヶ月 → 1月
  })

  it('空・不正な日付は null', () => {
    expect(calcGrantMonthFromHire('')).toBeNull()
    expect(calcGrantMonthFromHire('invalid')).toBeNull()
  })
})

describe('calcLegalPL: 法定有給付与日数（労基法テーブル）', () => {
  const hire = '2025-01-01'

  it('勤続6ヶ月未満は付与なし', () => {
    expect(calcLegalPL(hire, '2025-06-30').days).toBe(0)
  })

  it('法定テーブル: 6ヶ月10日 → 以降1年ごとに増加、上限20日', () => {
    expect(calcLegalPL(hire, '2025-07-01').days).toBe(10)  // 6ヶ月
    expect(calcLegalPL(hire, '2026-07-01').days).toBe(11)  // 1年6ヶ月
    expect(calcLegalPL(hire, '2027-07-01').days).toBe(12)  // 2年6ヶ月
    expect(calcLegalPL(hire, '2028-07-01').days).toBe(14)  // 3年6ヶ月
    expect(calcLegalPL(hire, '2029-07-01').days).toBe(16)  // 4年6ヶ月
    expect(calcLegalPL(hire, '2030-07-01').days).toBe(18)  // 5年6ヶ月
    expect(calcLegalPL(hire, '2031-07-01').days).toBe(20)  // 6年6ヶ月
    expect(calcLegalPL(hire, '2040-07-01').days).toBe(20)  // 上限20日
  })

  it('日付の日にちで月数の切り捨てを調整する', () => {
    // 入社1/15 → 7/14 はまだ5ヶ月扱い、7/15 で6ヶ月
    expect(calcLegalPL('2025-01-15', '2025-07-14').days).toBe(0)
    expect(calcLegalPL('2025-01-15', '2025-07-15').days).toBe(10)
  })

  it('勤続年月を返す', () => {
    const r = calcLegalPL(hire, '2026-07-01')
    expect(r.years).toBe(1)
    expect(r.months).toBe(6)
    expect(r.label).toContain('法定11日')
  })

  it('空・不正な日付はゼロ扱い', () => {
    expect(calcLegalPL('', '2026-07-01').days).toBe(0)
    expect(calcLegalPL('invalid', '2026-07-01').days).toBe(0)
  })
})

describe('rateBarColor: 消化率バーの色', () => {
  it('50%以下=緑 / 80%以下=黄 / それ以上=赤', () => {
    expect(rateBarColor(30)).toBe('from-green-400 to-green-500')
    expect(rateBarColor(50)).toBe('from-green-400 to-green-500')
    expect(rateBarColor(70)).toBe('from-yellow-400 to-yellow-500')
    expect(rateBarColor(90)).toBe('from-red-400 to-red-500')
  })
})

describe('getJPHolidays: 日本の祝日（2026年）', () => {
  const h = getJPHolidays(2026)

  it('固定祝日', () => {
    for (const d of ['20260101', '20260211', '20260223', '20260429', '20260503', '20260504', '20260505', '20260811', '20261103', '20261123']) {
      expect(h.has(d), d).toBe(true)
    }
  })

  it('ハッピーマンデー: 成人の日・海の日・敬老の日・スポーツの日', () => {
    expect(h.has('20260112')).toBe(true)  // 1月第2月曜
    expect(h.has('20260720')).toBe(true)  // 7月第3月曜
    expect(h.has('20260921')).toBe(true)  // 9月第3月曜
    expect(h.has('20261012')).toBe(true)  // 10月第2月曜
  })

  it('春分・秋分（概算）', () => {
    expect(h.has('20260321')).toBe(true)
    expect(h.has('20260923')).toBe(true)
  })

  it('平日は含まない', () => {
    expect(h.has('20260210')).toBe(false)
  })
})

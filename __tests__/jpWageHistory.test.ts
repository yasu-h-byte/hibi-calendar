/**
 * ベース年収履歴の転記が正しいかを機械的に検算する。
 *
 * 履歴は給料表のスクリーンショットから転記したもので、目視の読み違いが起きうる。
 * 給料表には「確定日給 × 310 = 最終年度」「改訂前 × 310 = 前年度」という関係が
 * あるので、そこを突き合わせれば読み違いは落ちる。
 */
import { describe, it, expect } from 'vitest'
import { WAGE_HISTORY_SEED, SHEET_2025_10 } from '@/lib/jp-wage-history'
import { baseAnnualWithLeave } from '@/lib/jp-wage'

describe('ベース年収履歴の転記', () => {
  it.each(SHEET_2025_10)('workerId %i: 2026年度 = 確定日給 × 310', (id, daily) => {
    const last = WAGE_HISTORY_SEED[id].find(p => p.year === 2026)!
    expect(last.baseAnnual).toBe(baseAnnualWithLeave(daily))
  })

  it.each(SHEET_2025_10)('workerId %i: 2025年度 = 改訂前 × 310', (id, _d, prev) => {
    const y2025 = WAGE_HISTORY_SEED[id].find(p => p.year === 2025)!
    expect(y2025.baseAnnual).toBe(baseAnnualWithLeave(prev))
  })

  it('年度が昇順で重複していない', () => {
    for (const [id, points] of Object.entries(WAGE_HISTORY_SEED)) {
      const years = points.map(p => p.year)
      expect(years, `worker ${id}`).toEqual([...years].sort((a, b) => a - b))
      expect(new Set(years).size, `worker ${id}`).toBe(years.length)
    }
  })

  it('年収が下がっている年がない（降給していない）', () => {
    for (const [id, points] of Object.entries(WAGE_HISTORY_SEED)) {
      for (let i = 1; i < points.length; i++) {
        expect(points[i].baseAnnual, `worker ${id} / ${points[i].year}年度`)
          .toBeGreaterThanOrEqual(points[i - 1].baseAnnual)
      }
    }
  })

  it('7名分ある', () => {
    expect(Object.keys(WAGE_HISTORY_SEED)).toHaveLength(7)
  })
})

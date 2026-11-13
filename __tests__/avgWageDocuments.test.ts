import { describe, test, expect } from 'vitest'
import { DOCUMENT_JP_POINTS } from '@/lib/avg-wage-documents.server'

// 資料から取り込んだ点の形だけを確かめる（金額そのものは書かない）
describe('平均日給: 資料の点の形', () => {
  test('毎年10月・2018〜2025年・各年に人がいる', () => {
    expect(Object.keys(DOCUMENT_JP_POINTS).sort()).toEqual(['201810', '201910', '202010', '202110', '202210', '202310', '202410', '202510'])
    for (const rows of Object.values(DOCUMENT_JP_POINTS)) expect(rows.length).toBeGreaterThan(5)
  })
  test('同じ年に同じ人が2回出ない・日給は常識の範囲・役員と事務の id は入っていない', () => {
    for (const [ym, rows] of Object.entries(DOCUMENT_JP_POINTS)) {
      const ids = rows.map(r => r[0])
      expect(new Set(ids).size, ym).toBe(ids.length)
      for (const [id, daily] of rows) {
        expect(daily, `${ym} ${id}`).toBeGreaterThan(5000)
        expect(daily, `${ym} ${id}`).toBeLessThan(60000)
        expect([0, 1, 301, 302, 303]).not.toContain(id)
      }
    }
  })
})

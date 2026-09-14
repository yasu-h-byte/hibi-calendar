import { describe, test, expect } from 'vitest'
import { RAISE_TABLE, getRaiseAmount, raiseYearAt } from '@/lib/evaluation-config'
import { curveRaiseAt } from '@/lib/wage-curve'

/**
 * 昇給テーブルを賃金カーブに一本化（2026-09-14）
 */
describe('RAISE_TABLE', () => {
  test('A評価は賃金カーブの昇給額と一致する', () => {
    for (const r of RAISE_TABLE) expect(r.A).toBe(curveRaiseAt(r.year - 1))
    expect(RAISE_TABLE.map(r => r.A)).toEqual([160, 152, 144, 136, 128, 120, 112, 104, 96, 88, 80])
  })
  test('どの年も S > A > B > C、各ランクは年数とともに増えない', () => {
    for (const r of RAISE_TABLE) {
      expect(r.S).toBeGreaterThan(r.A); expect(r.A).toBeGreaterThan(r.B); expect(r.B).toBeGreaterThan(r.C)
    }
    for (let i = 1; i < RAISE_TABLE.length; i++) {
      for (const k of ['S', 'A', 'B', 'C'] as const) expect(RAISE_TABLE[i][k]).toBeLessThanOrEqual(RAISE_TABLE[i - 1][k])
    }
  })
  test('11回目以降は下限（A=80）でキャップ', () => {
    expect(getRaiseAmount('A', 11)).toBe(80)
    expect(getRaiseAmount('A', 15)).toBe(80)
  })
})

describe('raiseYearAt（評価日に最も近い記念日の回数）', () => {
  test('記念日の前に評価: アイン 2018-11-01 入社・2026-09-10 評価 → 8回目（A=104）', () => {
    expect(raiseYearAt('2018-11-01', '2026-09-10')).toBe(8)
    expect(getRaiseAmount('A', raiseYearAt('2018-11-01', '2026-09-10'))).toBe(104)
  })
  test('記念日の後に評価', () => {
    expect(raiseYearAt('2023-05-14', '2026-06-01')).toBe(3)
  })
  test('記念日当日・入社1年未満は1', () => {
    expect(raiseYearAt('2022-10-01', '2026-10-01')).toBe(4)
    expect(raiseYearAt('2026-08-01', '2026-09-01')).toBe(1)
  })
})

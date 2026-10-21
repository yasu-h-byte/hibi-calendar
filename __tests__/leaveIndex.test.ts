/**
 * 有給の索引（lib/leave-index.server.ts・2026-10-21 第 1 段階）の純関数
 */
import { describe, test, expect } from 'vitest'
import { paidLeaveDaysOf, buildLeaveIndexDays, diffLeaveIndex } from '@/lib/leave-index.server'

const att202609 = {
  'ihi_104_202609_1': { w: 0, p: 1 },
  'ihi_104_202609_2': { w: 1 },
  'ihi_tekkotsu_104_202609_1': { w: 0, p: 1 },   // 同じ日に工種サイトの p（1 日と数える）
  'ihi_105_202609_3': { w: 0, p: true },          // 旧データ p:true
  'sasazuka_104_202609_15': { w: 0, p: 1 },
}
const att202610 = { 'ihi_104_202610_20': { w: 0, p: 1 } }

describe('出面から有給の日を取り出す', () => {
  test('同じ日の複数現場は 1 日。他の人は混ざらない。旧データ p:true も拾う', () => {
    expect(paidLeaveDaysOf(att202609 as never, 104)).toEqual(['2026-09-01', '2026-09-15'])
    expect(paidLeaveDaysOf(att202609 as never, 105)).toEqual(['2026-09-03'])
    expect(paidLeaveDaysOf(att202609 as never, 999)).toEqual([])
  })
  test('複数月から 1 人の索引を作る', () => {
    expect(buildLeaveIndexDays({ '202609': att202609, '202610': att202610 } as never, 104))
      .toEqual({ '2026-09-01': 'p', '2026-09-15': 'p', '2026-10-20': 'p' })
  })
})

describe('索引と出面の食い違い', () => {
  test('無い日と余分な日を、調べた月の範囲だけで返す', () => {
    const d = diffLeaveIndex({ '2026-09-01': 'p', '2026-09-30': 'p', '2025-01-05': 'p' }, { '2026-09-01': 'p', '2026-09-15': 'p' }, ['2026-09', '2026-10'])
    expect(d.missing).toEqual(['2026-09-15'])
    expect(d.extra).toEqual(['2026-09-30'])   // 2025-01-05 は範囲外なので数えない
  })
  test('索引が無ければ全部 missing', () => {
    expect(diffLeaveIndex(null, { '2026-09-01': 'p' }, ['2026-09']).missing).toEqual(['2026-09-01'])
  })
})

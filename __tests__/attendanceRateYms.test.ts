/**
 * 出勤率の対象月列挙のテスト
 *
 * 回帰防止: periodEnd が29〜31日のとき、Date.setMonth の繰り上がりで
 *   対象月が1ヶ月抜け落ちるバグ（監査⑦）。整数計算に統一して解消した件。
 */
import { describe, test, expect } from 'vitest'
import { enumerateYmsBack } from '@/lib/attendance-rate'

describe('enumerateYmsBack', () => {
  test('月末31日起点でも対象月が抜け落ちない（監査⑦の回帰防止）', () => {
    // 2026-05-31 から monthsBack=12 →「12ヶ月前(202505)〜当月(202605)」の13ヶ月が連続
    const yms = enumerateYmsBack('2026-05-31', 12)
    expect(yms).toEqual([
      '202505', '202506', '202507', '202508', '202509', '202510', '202511',
      '202512', '202601', '202602', '202603', '202604', '202605',
    ])
    expect(new Set(yms).size).toBe(13)  // 重複・欠落なし
  })

  test('年をまたいでも連続する', () => {
    const yms = enumerateYmsBack('2026-01-31', 3)
    expect(yms).toEqual(['202510', '202511', '202512', '202601'])
  })

  test('月初でも同じ結果（日付に依存しない）', () => {
    expect(enumerateYmsBack('2026-05-01', 12)).toEqual(enumerateYmsBack('2026-05-31', 12))
  })
})

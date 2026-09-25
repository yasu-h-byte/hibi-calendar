/**
 * 経営コックピット連携の合言葉チェック。
 * 未設定・短すぎる・長さ違い・1文字違いはすべて通さない（読むだけの窓口でも経営の数字が出るため）。
 */
import { describe, it, expect } from 'vitest'
import { isValidIntegrationKey } from '@/lib/integration'

const KEY = 'k'.repeat(31) + 'X'

describe('isValidIntegrationKey', () => {
  it('一致すれば通す', () => expect(isValidIntegrationKey(KEY, KEY)).toBe(true))
  it('環境変数が未設定なら通さない', () => expect(isValidIntegrationKey(KEY, undefined)).toBe(false))
  it('合言葉が16文字未満の設定なら通さない', () => expect(isValidIntegrationKey('short', 'short')).toBe(false))
  it('ヘッダが無ければ通さない', () => expect(isValidIntegrationKey(null, KEY)).toBe(false))
  it('長さが違えば通さない', () => expect(isValidIntegrationKey(KEY + 'a', KEY)).toBe(false))
  it('1文字違いは通さない', () => expect(isValidIntegrationKey('k'.repeat(31) + 'Y', KEY)).toBe(false))
})

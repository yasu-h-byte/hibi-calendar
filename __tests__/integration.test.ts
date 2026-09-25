/**
 * 経営コックピット連携の合言葉チェック。
 * 未設定・短すぎる・長さ違い・1文字違いはすべて通さない（読むだけの窓口でも経営の数字が出るため）。
 */
import { describe, it, expect } from 'vitest'
import { isValidIntegrationKey } from '@/lib/integration'
import { summarizePeerInvoiceSites, type PeerInvoiceLine } from '@/lib/peer-invoice'

const KEY = 'k'.repeat(31) + 'X'

describe('isValidIntegrationKey', () => {
  it('一致すれば通す', () => expect(isValidIntegrationKey(KEY, KEY)).toBe(true))
  it('環境変数が未設定なら通さない', () => expect(isValidIntegrationKey(KEY, undefined)).toBe(false))
  it('合言葉が16文字未満の設定なら通さない', () => expect(isValidIntegrationKey('short', 'short')).toBe(false))
  it('ヘッダが無ければ通さない', () => expect(isValidIntegrationKey(null, KEY)).toBe(false))
  it('長さが違えば通さない', () => expect(isValidIntegrationKey(KEY + 'a', KEY)).toBe(false))
  it('1文字違いは通さない', () => expect(isValidIntegrationKey('k'.repeat(31) + 'Y', KEY)).toBe(false))
})

describe('summarizePeerInvoiceSites（peerInvoices[].sites の内訳集計）', () => {
  it('同じ現場の鳶・土工の2行を1件に合算する', () => {
    const lines: PeerInvoiceLine[] = [
      { siteId: 'siteA', siteName: '現場A', role: '鳶', days: 5, rate: 28000, amount: 140000 },
      { siteId: 'siteA', siteName: '現場A', role: '土工', days: 1, rate: 22000, amount: 22000 },
      { siteId: 'siteB', siteName: '現場B', role: '鳶', days: 2, rate: 28000, amount: 56000 },
    ]
    expect(summarizePeerInvoiceSites(lines)).toEqual([
      { siteId: 'siteA', siteName: '現場A', amount: 162000 },
      { siteId: 'siteB', siteName: '現場B', amount: 56000 },
    ])
  })
  it('明細が無ければ空配列', () => {
    expect(summarizePeerInvoiceSites([])).toEqual([])
  })
})

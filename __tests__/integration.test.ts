/**
 * 経営コックピット連携の合言葉チェック。
 * 未設定・短すぎる・長さ違い・1文字違いはすべて通さない（読むだけの窓口でも経営の数字が出るため）。
 */
import { describe, it, expect } from 'vitest'
import { isValidIntegrationKey, paperInvoiceToIntegration } from '@/lib/integration'
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

describe('paperInvoiceToIntegration（紙の控えを経営コックピットへ・HFU → 日比建設 の9月分）', () => {
  const sites = [
    { id: 'sasazuka', name: '笹塚駅南口東地区開発計画' },
    { id: 'ihi', name: 'IHIエアロスペース第4工場建設工事' },
  ]
  const terms = { closing: 'end' as const, payMonthOffset: 2 as const, payDay: 10 }

  it('発行日・支払期日・税抜/税/税込をそのまま渡し、現場は明細の現場名の前方一致で引き当てる', () => {
    const r = paperInvoiceToIntegration({
      companyId: '__hfu_to_hibi__', companyName: 'HFU → 日比建設', ym: '202609', no: '', issueDate: '2026-09-30',
      subtotal: 2360344, tax: 236034, total: 2596378,
      lines: [
        { site: '笹塚駅南口東地区', item: '鳶職', qty: 78.6, unit: '人工', rate: 30000, amount: 2358000 },
        { site: '笹塚駅南口東地区', item: '鳶職 残業', qty: 0.5, unit: 'h', rate: 4688, amount: 2344 },
        { site: '不明な現場', item: '式', qty: 1, unit: '式', rate: 100, amount: 100 },
      ],
    }, sites, terms)
    expect(r.source).toBe('paper')
    expect(r.status).toBe('issued')
    expect(r.no).toBe('')
    expect(r.issueDate).toBe('2026-09-30')
    expect(r.dueDate).toBe('2026-11-10')
    expect([r.subtotal, r.tax, r.total]).toEqual([2360344, 236034, 2596378])
    expect(r.sites).toEqual([
      { siteId: 'sasazuka', siteName: '笹塚駅南口東地区開発計画', amount: 2360344 },
      { siteId: '', siteName: '不明な現場', amount: 100 },
    ])
  })

  it('発行日が無ければ月末、税抜が無ければ 税込÷1.1 で補う', () => {
    const r = paperInvoiceToIntegration({ companyId: 'x', companyName: 'x', ym: '202609', total: 1100, lines: null }, sites, undefined)
    expect(r.issueDate).toBe('2026-09-30')
    expect([r.subtotal, r.tax, r.total]).toEqual([1000, 100, 1100])
    expect(r.sites).toEqual([])
  })
})

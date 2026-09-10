import { describe, test, expect } from 'vitest'
import { getSiteRates, siteBaseRatio, INTERMEDIARY_BASE_RATIO, type MainData } from '@/lib/compute'

/**
 * 応援現場の単価は直接受取（100%）（2026-09-11）
 *
 * 直現場は元請け（山岡）経由で常用単価の85%が受取。応援現場は元接払いなので
 * 入力した単価（28,000・30,000など）がそのまま受取額になる。
 */
const main = {
  defaultRates: { tobiRate: 38000, dokoRate: 30000 },
  sites: [
    { id: 'direct1', name: '直', start: '', end: '', foreman: 0, archived: false, siteType: 'direct',
      rates: [{ from: '202510', tobiRate: 36000, dokoRate: 28000 }] },
    { id: 'support1', name: '応援', start: '', end: '', foreman: 0, archived: false, siteType: 'support',
      rates: [{ from: '202509', tobiRate: 28000, dokoRate: 25000 }, { from: '202511', tobiRate: 30000, dokoRate: 26000 }] },
    { id: 'support-norate', name: '応援(単価未設定)', start: '', end: '', foreman: 0, archived: false, siteType: 'support', rates: [] },
    { id: 'legacy', name: '種別未設定', start: '', end: '', foreman: 0, archived: false,
      rates: [{ from: '202510', tobiRate: 36000, dokoRate: 28000 }] },
  ],
} as unknown as MainData

describe('siteBaseRatio', () => {
  test('direct / 未設定は 0.85、support は 1.0', () => {
    expect(siteBaseRatio({ siteType: 'direct' })).toBe(INTERMEDIARY_BASE_RATIO)
    expect(siteBaseRatio(undefined)).toBe(0.85)
    expect(siteBaseRatio({ siteType: 'support' })).toBe(1)
  })
})

describe('getSiteRates', () => {
  test('直現場は常用単価の85%が受取', () => {
    const r = getSiteRates(main, 'direct1', '202510')
    expect(r.tobiRate).toBe(36000)
    expect(r.tobiBase).toBe(30600)
    expect(r.dokoBase).toBe(23800)
    expect(r.baseRatio).toBe(0.85)
  })
  test('応援現場は入力した単価がそのまま受取（期間別も有効）', () => {
    expect(getSiteRates(main, 'support1', '202510').tobiBase).toBe(28000)
    expect(getSiteRates(main, 'support1', '202510').dokoBase).toBe(25000)
    expect(getSiteRates(main, 'support1', '202511').tobiBase).toBe(30000)
    expect(getSiteRates(main, 'support1').baseRatio).toBe(1)
  })
  test('応援現場で単価未設定ならデフォルト単価を100%で使う', () => {
    const r = getSiteRates(main, 'support-norate', '202510')
    expect(r.tobiBase).toBe(38000)
  })
  test('種別未設定の旧現場と現場指定なしは従来どおり85%', () => {
    expect(getSiteRates(main, 'legacy', '202510').tobiBase).toBe(30600)
    expect(getSiteRates(main).tobiBase).toBe(32300)
  })
})

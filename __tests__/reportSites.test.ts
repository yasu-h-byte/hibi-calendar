/**
 * 集計画面に出す現場の決まり（lib/report-sites.ts）と、現場・取引先の削除の確認（lib/master-refs.ts）
 * 2026-10-02 総合点検
 */
import { describe, test, expect } from 'vitest'
import { reportSitesForPeriod, siteHasActivity } from '@/lib/report-sites'
import { siteReferenceReasons, subconReferenceReasons } from '@/lib/master-refs'
import { shiftYm } from '@/lib/month-nav'

const main = {
  sites: [
    { id: 'live', name: '稼働中', archived: false },
    { id: 'old_work', name: '終了・人工あり', archived: true },
    { id: 'old_bill', name: '終了・請求額だけ', archived: true },
    { id: 'old_cost', name: '終了・原価だけ', archived: true },
    { id: 'old_none', name: '終了・なにもない', archived: true },
  ],
  billing: { old_bill_202608: [5000000], old_none_202605: [1] },
}
const act: Record<string, { work: number; subWork: number; cost: number; subCost: number }> = {
  old_work: { work: 3, subWork: 0, cost: 0, subCost: 0 },
  old_cost: { work: 0, subWork: 0, cost: 120000, subCost: 0 },
}

describe('reportSitesForPeriod', () => {
  test('終了していない現場は常に。終了した現場は期間に人工・原価・請求額のどれかがあるときだけ', () => {
    const ids = reportSitesForPeriod(main, ['202608'], id => act[id]).map(s => s.id)
    expect(ids).toEqual(['live', 'old_work', 'old_bill', 'old_cost'])
  })
  test('請求額は期間の月だけ見る（別の月の請求額では含めない）', () => {
    expect(siteHasActivity(main, 'old_none', ['202608'], undefined)).toBe(false)
    expect(siteHasActivity(main, 'old_none', ['202605'], undefined)).toBe(true)
  })
})

describe('siteReferenceReasons / subconReferenceReasons', () => {
  const atts = [
    { ym: '202608', d: { 'site_1_101_202608_3': { w: 1 }, 'other_101_202608_4': { w: 1 } }, sd: { 'site_1_abc_202608_5': { n: 1, on: 0 }, 'site_1_________99u1_202608_6': { n: 1, on: 0 } } },
  ]
  const subconIds = ['abc', '________99u1']
  test('現場: 出面・請求額・請求書から参照があれば理由を返し、無ければ空', () => {
    const r = siteReferenceReasons({ siteId: 'site_1', atts, billing: { site_1_202607: [100], site_1_202606: [0] }, peerInvoices: [{ no: 'HC-202607-01', lines: [{ siteId: 'site_1' }] }], subconIds })
    expect(r.join('\n')).toContain('2026年8月（3件）')
    expect(r.join('\n')).toContain('2026年7月')
    expect(r.join('\n')).not.toContain('2026年6月')
    expect(r.join('\n')).toContain('HC-202607-01')
    expect(siteReferenceReasons({ siteId: 'nothing', atts, billing: {}, peerInvoices: [], subconIds })).toEqual([])
  })
  test('取引先: 外注の出面（「_」入りの id も）・請負体制・配置・請求書・紙の請求書', () => {
    const sites = [{ id: 'site_1', name: '川崎', ownerId: '________99u1' }, { id: 'site_2', name: '笹塚', primeId: 'abc' }]
    const r1 = subconReferenceReasons({ subconId: '________99u1', atts, sites, assign: { site_2: { subcons: ['________99u1'] } }, peerInvoices: [], paperInvoices: [], subconIds })
    expect(r1.join('\n')).toContain('外注の出面が入っています: 2026年8月（1件）')
    expect(r1.join('\n')).toContain('請負体制')
    expect(r1.join('\n')).toContain('配置に入っています: 笹塚')
    const r2 = subconReferenceReasons({ subconId: 'abc', atts, sites, assign: {}, peerInvoices: [{ no: 'HC-1', companyId: 'abc' }], paperInvoices: [{ ym: '202609', companyId: 'abc' }], subconIds })
    expect(r2.join('\n')).toContain('請求書の宛先')
    expect(r2.join('\n')).toContain('紙の請求書')
    expect(subconReferenceReasons({ subconId: 'new', atts, sites, assign: {}, peerInvoices: [], paperInvoices: [], subconIds })).toEqual([])
  })
})

describe('shiftYm', () => {
  test('年をまたぐ', () => {
    expect(shiftYm('202601', -1)).toBe('202512')
    expect(shiftYm('202612', 1)).toBe('202701')
    expect(shiftYm('202606', 7)).toBe('202701')
  })
})

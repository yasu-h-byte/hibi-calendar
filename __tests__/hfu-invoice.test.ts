/**
 * HFU → 日比建設 の請求書（lib/hfu-invoice.ts）の検証テスト
 *
 * 確認すること:
 *   - HFU 所属の作業員だけを数える（日比建設所属・外注は入らない）
 *   - 自社現場・応援現場とも全現場が対象
 *   - 人工 × 社内単価。残業は外国人 7h で1人工に換算して足す
 *   - 有給・休業補償(0.6)・出向者は除外。出面明細の人工と本体の人工が一致する
 *   - 宛先は日比建設・支払期日は設定の支払条件
 */
import { describe, test, expect } from 'vitest'
import type { MainData } from '@/lib/compute'
import { buildHfuInvoiceDraft, checkHfuRates, HFU_INVOICE_COMPANY_ID } from '@/lib/hfu-invoice'
import type { AttendanceEntry } from '@/types'

const ym = '202609'

function buildMain(overrides: Record<string, unknown>): MainData {
  return {
    workers: [], sites: [], subcons: [],
    assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {}, nightDays: {},
    ...overrides,
  } as unknown as MainData
}

const worker = (id: number, name: string, org: string, visa: string, job: string) =>
  ({ id, name, org, visa, job, rate: 0, otMul: 1.25, hireDate: '2020-01-01', token: '' })

const entries = (siteId: string, wid: number, days: number[], e: AttendanceEntry = { w: 1 }) =>
  Object.fromEntries(days.map(d => [`${siteId}_${wid}_${ym}_${d}`, { ...e }])) as Record<string, AttendanceEntry>

const main = buildMain({
  workers: [
    worker(201, 'グエン', 'hfu', 'jisshu', 'tobi'),
    worker(202, 'チャン', 'HFU', 'tokutei', 'doko'),
    worker(10, '日比 太郎', 'hibi', 'none', 'tobi'),
  ],
  sites: [
    { id: 'own', name: '自社現場', start: '', end: '', foreman: 0, archived: false },
    { id: 'sup', name: '応援現場', start: '', end: '', foreman: 0, archived: false, siteType: 'support' },
  ],
  subcons: [{ id: 'gaichu', name: '村田工業', type: '鳶業者', rate: 20000, otRate: 3500, note: '' }],
  companyProfile: {
    name: '株式会社日比建設', nameEn: 'HIBI CONSTRUCTION', postal: '204-0000', address: '東京都清瀬市', tel: '',
    invoiceRegNo: 'T1', bank: { bankName: 'x', branch: 'x', accountType: '普通', accountNo: '1', holder: 'x' }, invoicePrefix: 'HC',
  },
  hfuInvoice: {
    profile: { name: 'HFU', nameEn: '', postal: '', address: 'x', tel: '', invoiceRegNo: 'T2', bank: { bankName: 'x', branch: 'x', accountType: '普通', accountNo: '2', holder: 'x' }, invoicePrefix: 'HFU' },
    tobiRate: 20000, dokoRate: 15000,
    paymentTerms: { closing: 'end', payMonthOffset: 1, payDay: 25 },
  },
})

const attD: Record<string, AttendanceEntry> = {
  ...entries('own', 201, [1, 2, 3]),
  ...entries('own', 201, [4], { w: 1, o: 3.5 }),      // 残業 3.5h → 0.5人工
  ...entries('own', 201, [5], { w: 1, p: 1 }),        // 有給 → 除外
  ...entries('sup', 201, [7, 8]),
  ...entries('sup', 202, [7, 8, 9]),
  ...entries('sup', 202, [10], { w: 0.6 }),           // 休業補償 → 除外
  ...entries('own', 10, [1, 2, 3]),                   // 日比建設所属 → 入らない
}

describe('buildHfuInvoiceDraft', () => {
  const draft = buildHfuInvoiceDraft(main, attD, ym)!

  test('宛先は日比建設・kind は hfu', () => {
    expect(draft.kind).toBe('hfu')
    expect(draft.companyId).toBe(HFU_INVOICE_COMPANY_ID)
    expect(draft.companyName).toBe('株式会社日比建設')
    expect(draft.company.address).toBe('東京都清瀬市')
  })

  test('HFU の人だけ・全現場・人工×社内単価（残業は7hで1人工換算）', () => {
    expect(draft.lines).toEqual([
      { siteId: 'sup', siteName: '応援現場', role: '鳶', days: 2, rate: 20000, amount: 40000 },
      { siteId: 'sup', siteName: '応援現場', role: '土工', days: 3, rate: 15000, amount: 45000 },
      { siteId: 'own', siteName: '自社現場', role: '鳶', days: 4.5, rate: 20000, amount: 90000 },
    ].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ja')))
    expect(draft.subtotal).toBe(175000)
    expect(draft.tax).toBe(17500)
    expect(draft.total).toBe(192500)
  })

  test('出面明細に日比建設所属の人は出ない・明細の人工と本体の人工（残業換算前）が一致', () => {
    const labels = draft.detail.flatMap(d => d.rows.map(r => r.label))
    expect(labels).not.toContain('日比 太郎')
    const own = draft.detail.find(d => d.siteId === 'own')!
    expect(own.siteTotal).toBe(4)
    expect(own.rows[0].cells[4].ot).toBe(3.5)
    expect(own.rows[0].cells[5]).toBeUndefined()
  })

  test('支払期日は設定の支払条件（翌月25日）', () => {
    expect(draft.dueDate).toBe('2026-10-23') // 2026-10-25 は日曜 → 23日(金)
  })

  test('HFU の人工が無い月は null', () => {
    expect(buildHfuInvoiceDraft(main, entries('own', 10, [1]), ym)).toBeNull()
  })

  test('出向者は除外', () => {
    const m2 = buildMain({ ...main, assign: { own: { workers: [201], subcons: [], dispatch: [201] } } })
    const d2 = buildHfuInvoiceDraft(m2, attD, ym)!
    expect(d2.detail.find(d => d.siteId === 'own')).toBeUndefined()
  })
})

describe('checkHfuRates', () => {
  test('単価が未入力なら発行不可', () => {
    expect(checkHfuRates(null).ok).toBe(false)
    expect(checkHfuRates({ ...main.hfuInvoice!, dokoRate: 0 }).ok).toBe(false)
    expect(checkHfuRates(main.hfuInvoice).ok).toBe(true)
  })
})

/**
 * 経営コックピット連携の合言葉チェック。
 * 未設定・短すぎる・長さ違い・1文字違いはすべて通さない（読むだけの窓口でも経営の数字が出るため）。
 */
import { describe, it, expect } from 'vitest'
import { isValidIntegrationKey, paperInvoiceToIntegration, buildWorkerDays } from '@/lib/integration'
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

describe('buildWorkerDays（作業員1人ずつの出た日数・有給・待機・帰国）', () => {
  // 出面の台帳（main.workers）の項目名: org / visa / job
  const workers = [
    { id: 10, org: 'hibi', visa: 'none', job: 'tobi', hireDate: '2020-04-01' },
    { id: 11, org: 'hfu', visa: 'jisshu2', job: 'tobi', hireDate: '2024-08-01' },
    { id: 12, org: 'hibi', visa: 'tokutei1', job: 'tobi', hireDate: '2019-01-10' },
    { id: 13, org: 'hibi', visa: 'none', job: 'jimu', hireDate: '2026-06-01' },
    { id: 14, org: 'hibi', visa: 'none', job: 'tobi', hireDate: '2015-04-01', retired: '2027-01-20' },
    { id: 15, org: 'hibi', visa: 'none', job: 'tobi', hireDate: '2027-04-01' },
    { id: 16, org: 'hibi', visa: 'none', job: 'tobi', retired: 'true' },
  ]
  const byWorker = {
    10: { work: 22.5, plUsed: 1, compDays: 0 },
    11: { work: 8, plUsed: 0, compDays: 2 },
    12: { work: 0, plUsed: 0, compDays: 0 },
  }
  const homeLeaves = [
    // 月をまたぐ帰国（2月の中に切り取る）
    { workerId: 11, startDate: '2027-01-25', endDate: '2027-02-10' },
    // 同じ人の重なった申請（二重に数えない）
    { workerId: 11, startDate: '2027-02-08', endDate: '2027-02-12' },
    // 月をまるごと
    { workerId: 12, startDate: '2027-01-15', endDate: '2027-03-05' },
    // 別の月
    { workerId: 10, startDate: '2027-05-01', endDate: '2027-05-20' },
  ]
  const rows = buildWorkerDays(workers, byWorker, homeLeaves, '202702')
  const of = (id: number) => rows.find(r => r.id === id)

  it('出た日数・有給・待機をそのまま返す', () => {
    expect(of(10)).toMatchObject({ company: 'hbk', nationality: 'jp', field: true, active: true, workDays: 22.5, paidLeaveDays: 1, standbyDays: 0, homeLeaveDays: 0, homeLeaves: [] })
  })
  it('月をまたぐ帰国は月の中に切り取り、重なった申請は二重に数えない', () => {
    expect(of(11)).toMatchObject({ company: 'hfu', nationality: 'vn', workDays: 8, standbyDays: 2, homeLeaveDays: 12 })
    expect(of(11)!.homeLeaves).toEqual([
      { startDate: '2027-02-01', endDate: '2027-02-10' },
      { startDate: '2027-02-08', endDate: '2027-02-12' },
    ])
  })
  it('月をまるごと帰国している人は、その月の日数ぶん', () => {
    expect(of(12)).toMatchObject({ workDays: 0, homeLeaveDays: 28 })
  })
  it('所定日数: 出た現場のカレンダーの日数（複数は大きいほう）→ 無ければ全社 → 無ければ null', () => {
    const w = [{ id: 31, org: 'hibi', visa: 'none', job: 'tobi' }, { id: 32, org: 'hfu', visa: 'jisshu2', job: 'tobi' }, { id: 33, org: 'hibi', visa: 'none', job: 'tobi' }]
    const by = { 31: { work: 20, plUsed: 0, compDays: 0, sites: ['a', 'b'] }, 32: { work: 18, plUsed: 0, compDays: 0, sites: ['c'] } }
    const r = buildWorkerDays(w, by, [], '202702', { company: 21, bySite: { a: 20, b: 22 } })
    expect(r.find(x => x.id === 31)!.prescribedDays).toBe(22)
    expect(r.find(x => x.id === 32)!.prescribedDays).toBe(21)
    expect(r.find(x => x.id === 33)!.prescribedDays).toBe(21)
    expect(buildWorkerDays(w, by, [], '202702')[0].prescribedDays).toBeNull()
  })
  it('事務は field: false', () => expect(of(13)).toMatchObject({ field: false, active: true, job: 'jimu' }))
  it('人事の台帳の項目名（company / visaType / jobType）でも同じに読める', () => {
    const r = buildWorkerDays([{ id: 21, company: 'HFU', visaType: 'jisshu1', jobType: 'tobi', hireDate: '2026-10-26' }], {}, [], '202702')
    expect(r[0]).toMatchObject({ company: 'hfu', nationality: 'vn', job: 'tobi', field: true })
  })
  it('月の初めより前に退職した人・まだ入社していない人・古い退職の印の人は返さない', () => {
    expect(of(14)).toBeUndefined()
    expect(of(15)).toBeUndefined()
    expect(of(16)).toBeUndefined()
  })
  it('退職した月には居る（月の初め以降の退職）', () => {
    expect(buildWorkerDays(workers, {}, [], '202701').find(r => r.id === 14)).toMatchObject({ active: true })
  })
})

/**
 * HFU → 日比建設 の請求書（lib/hfu-invoice.ts）の検証テスト
 *
 * 確認すること:
 *   - HFU 所属の作業員だけを数える（日比建設所属・外注は入らない）
 *   - 自社現場・応援現場とも全現場が対象
 *   - 人工 × 社内単価。残業は「時間 × 単価÷8×1.25」の別行（従来の手作り請求書と同じ）
 *   - 有給・休業補償(0.6)・出向者は除外。出面明細の人工と本体の人工が一致する
 *   - 宛先は日比建設・支払期日は設定の支払条件
 *   - 待機料（2026年10月分〜）: 現場の都合で休ませた日（0.6補）は 日数 × 単価 × 率（既定60%）の別行。人工には数えない
 */
import { describe, test, expect } from 'vitest'
import type { MainData } from '@/lib/compute'
import { buildHfuInvoiceDraft, checkHfuRates, hfuOtRate, hfuStandbyRate, HFU_INVOICE_COMPANY_ID, HFU_STANDBY_FROM_YM } from '@/lib/hfu-invoice'
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
  ...entries('own', 201, [4], { w: 1, o: 3.5 }),      // 残業 3.5h → 残業の行
  ...entries('own', 201, [5], { w: 1, p: 1 }),        // 有給 → 除外
  ...entries('sup', 201, [7, 8]),
  ...entries('sup', 202, [7, 8, 9]),
  ...entries('sup', 202, [10], { w: 0.6 }),           // 休業補償 → 除外
  ...entries('own', 10, [1, 2, 3]),                   // 日比建設所属 → 入らない
}

describe('buildHfuInvoiceDraft', () => {
  const draft = buildHfuInvoiceDraft(main, attD, ym)!

  test('Firestore に書ける形（値に undefined を含まない。2026-10-21 発行が 500 になった回帰）', () => {
    // toStrictEqual は「undefined の項目がある」と「項目が無い」を区別する。JSON を通すと undefined は消えるので、
    // 元と一致しなければ undefined が混ざっている（Firestore Admin SDK は undefined を含む書き込みを例外にする）
    expect(JSON.parse(JSON.stringify(draft))).toStrictEqual(draft)
    const cells = draft.detail.flatMap(d => d.rows.flatMap(r => Object.values(r.cells)))
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(Object.values(c)).not.toContain(undefined)
  })

  test('宛先は日比建設・kind は hfu', () => {
    expect(draft.kind).toBe('hfu')
    expect(draft.companyId).toBe(HFU_INVOICE_COMPANY_ID)
    expect(draft.companyName).toBe('株式会社日比建設')
    expect(draft.company.address).toBe('東京都清瀬市')
  })

  test('HFU の人だけ・全現場・人工×社内単価、残業は時間×残業単価の別行', () => {
    const bySite = (id: string) => draft.lines.filter(l => l.siteId === id)
    expect(bySite('own')).toEqual([
      { siteId: 'own', siteName: '自社現場', role: '鳶', days: 4, rate: 20000, amount: 80000 },
      { siteId: 'own', siteName: '自社現場', role: '鳶', unit: 'h', days: 3.5, rate: 3125, amount: 10938 },
    ])
    expect(bySite('sup')).toEqual([
      { siteId: 'sup', siteName: '応援現場', role: '鳶', days: 2, rate: 20000, amount: 40000 },
      { siteId: 'sup', siteName: '応援現場', role: '土工', days: 3, rate: 15000, amount: 45000 },
    ])
    expect(draft.subtotal).toBe(175938)
    expect(draft.tax).toBe(17593)
    expect(draft.total).toBe(193531)
  })

  test('従来の請求書（2025-12 分）と同じ計算: 鳶 94人工×30,000 ＋ 残業 4h×4,688 → 税込 3,122,627', () => {
    expect(hfuOtRate(30000)).toBe(4688)
    const days = Array.from({ length: 94 }, (_, i) => i)
    const m = buildMain({ ...main, hfuInvoice: { ...main.hfuInvoice!, tobiRate: 30000 } })
    // 94人工 = 4人が 23〜24日ずつ（1日1人工）。残業は合計 4h
    const att: Record<string, AttendanceEntry> = {}
    const ws = [201, 301, 302, 303]
    m.workers.push(...[301, 302, 303].map(id => worker(id, `W${id}`, 'hfu', 'jisshu', 'tobi')) as never[])
    days.forEach(i => { att[`own_${ws[i % 4]}_${ym}_${Math.floor(i / 4) + 1}`] = { w: 1, o: i < 2 ? 2 : 0 } })
    const d = buildHfuInvoiceDraft(m, att, ym)!
    expect(d.lines.map(l => [l.unit || 'd', l.days, l.rate, l.amount])).toEqual([['d', 94, 30000, 2820000], ['h', 4, 4688, 18752]])
    expect(d.subtotal).toBe(2838752)
    expect(d.tax).toBe(283875)
    expect(d.total).toBe(3122627)
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

describe('待機料（現場の都合で休ませた日・2026年10月分〜）', () => {
  const ym10 = '202610'
  const att10 = Object.fromEntries(Object.entries(attD).map(([k, v]) => [k.replace(ym, ym10), v])) as Record<string, AttendanceEntry>

  test('開始月は 2026年10月分。9月分は従来どおり 0.6補 を請求に入れない', () => {
    expect(HFU_STANDBY_FROM_YM).toBe('202610')
    expect(buildHfuInvoiceDraft(main, attD, ym)!.lines.some(l => l.unit === 'standby')).toBe(false)
    const sep = buildHfuInvoiceDraft(main, attD, ym)!.detail.find(d => d.siteId === 'sup')!
    expect(sep.rows.find(r => r.label === 'チャン')!.cells[10]).toBeUndefined()
    expect(sep.standbyDays).toBeUndefined()
  })

  test('単価 = 1人工の単価 × 率（円未満四捨五入）', () => {
    expect(hfuStandbyRate(30000, 60)).toBe(18000)
    expect(hfuStandbyRate(15000, 60)).toBe(9000)
    expect(hfuStandbyRate(12345, 60)).toBe(7407)
  })

  test('10月分: 0.6補 の日が「待機料」の行（日数 × 単価×60%）になり、人工の行は変わらない', () => {
    const d = buildHfuInvoiceDraft(main, att10, ym10)!
    const sup = d.lines.filter(l => l.siteId === 'sup')
    expect(sup).toEqual([
      { siteId: 'sup', siteName: '応援現場', role: '鳶', days: 2, rate: 20000, amount: 40000 },
      { siteId: 'sup', siteName: '応援現場', role: '土工', days: 3, rate: 15000, amount: 45000 },
      { siteId: 'sup', siteName: '応援現場', role: '土工', unit: 'standby', days: 1, rate: 9000, amount: 9000 },
    ])
    expect(d.subtotal).toBe(175938 + 9000)
    expect(JSON.parse(JSON.stringify(d))).toStrictEqual(d)
  })

  test('明細: 待機の日は「待」のセル（人工 0）で、人工の合計には入らず、待機の日数は別に数える', () => {
    const d = buildHfuInvoiceDraft(main, att10, ym10)!
    const sup = d.detail.find(s => s.siteId === 'sup')!
    const chan = sup.rows.find(r => r.label === 'チャン')!
    expect(chan.cells[10]).toEqual({ md: 0, standby: true })
    expect(chan.total).toBe(3)
    expect(chan.standbyDays).toBe(1)
    expect(sup.siteTotal).toBe(5)
    expect(sup.standbyDays).toBe(1)
    expect(sup.dayTotals[10]).toBeUndefined()
    // 人工の行の合計 = 明細の人工の合計（待機は入らない）
    const lineDays = d.lines.filter(l => !l.unit).reduce((s, l) => s + l.days, 0)
    const detailDays = d.detail.reduce((s, x) => s + x.siteTotal, 0)
    expect(lineDays).toBe(detailDays)
  })

  test('待機だけの現場・待機だけの人も請求に出る', () => {
    const only = entries('sup', 202, [1, 2], { w: 0.6 })
    const d = buildHfuInvoiceDraft(main, Object.fromEntries(Object.entries(only).map(([k, v]) => [k.replace(ym, ym10), v])), ym10)!
    expect(d.lines).toEqual([{ siteId: 'sup', siteName: '応援現場', role: '土工', unit: 'standby', days: 2, rate: 9000, amount: 18000 }])
    expect(d.detail[0].siteTotal).toBe(0)
    expect(d.detail[0].standbyDays).toBe(2)
  })

  test('率の設定: 未保存は 60%・変えればその率・0 なら待機料の行を出さない', () => {
    const at = (pct: number | undefined) => buildHfuInvoiceDraft(buildMain({ ...main, hfuInvoice: { ...main.hfuInvoice!, standbyRatePct: pct } }), att10, ym10)!
    expect(at(undefined).lines.find(l => l.unit === 'standby')!.rate).toBe(9000)
    expect(at(50).lines.find(l => l.unit === 'standby')!.rate).toBe(7500)
    const off = at(0)
    expect(off.lines.some(l => l.unit === 'standby')).toBe(false)
    expect(off.detail.find(s => s.siteId === 'sup')!.rows.find(r => r.label === 'チャン')!.cells[10]).toBeUndefined()
    expect(off.subtotal).toBe(175938)
  })

  test('待機料の単価が無い（職種の単価 0）なら発行不可', () => {
    const noDoko = buildMain({ ...main, hfuInvoice: { ...main.hfuInvoice!, dokoRate: 0 } })
    const only = Object.fromEntries(Object.entries(entries('sup', 202, [1], { w: 0.6 })).map(([k, v]) => [k.replace(ym, ym10), v]))
    expect(checkHfuRates(buildHfuInvoiceDraft(noDoko, only, ym10)!)).toEqual({ ok: false, error: expect.stringContaining('土工') })
  })
})

describe('checkHfuRates', () => {
  test('使う単価が未入力なら発行不可・使わない土工の単価は空でもよい', () => {
    const noDoko = buildMain({ ...main, hfuInvoice: { ...main.hfuInvoice!, dokoRate: 0 } })
    expect(checkHfuRates(buildHfuInvoiceDraft(noDoko, attD, ym)!)).toEqual({ ok: false, error: expect.stringContaining('土工') })
    expect(checkHfuRates(buildHfuInvoiceDraft(noDoko, entries('own', 201, [1]), ym)!).ok).toBe(true)
    expect(checkHfuRates(buildHfuInvoiceDraft(main, attD, ym)!).ok).toBe(true)
  })
})

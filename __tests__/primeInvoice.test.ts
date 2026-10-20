/**
 * 一次（山岡建設工業など）への請求書（lib/prime-invoice.ts・2026-10-20）。
 * 数字・名前はすべて架空（実在の人の給与を書かない・CLAUDE.md「給与の取り扱い」）。
 */
import { describe, test, expect } from 'vitest'
import type { MainData } from '@/lib/compute'
import {
  parseMoneyToken, parseGcStatement, parseMemo, looksLikeGcStatement, looksLikeMemo, computeSheetAmounts, buildSheet, recomputeSheet,
  assembleSheets, matchMemoToSheet, sumSheets, primePeriodOf, primeBillingPeriodOf, defaultPrimeInvoiceDate, reiwaDate, primeOtRate,
  aggregatePrimeManDays, checkPrimeOverall, memoManDayRows, maskPrimeBundleForViewer, sanitizeSheetEdit, parseRatioPercent, comparePrimeWithRemittance, PRIME_INVOICE_RATIO,
  type GcStatement, type MemoParsed, type PrimeInvoiceBundle,
} from '@/lib/prime-invoice'

// ── 大林組の控え（架空の数字）: pdfjs が行ごとに並べた形 ──
function gcLines(over: Partial<{ trade: string; code: string; docNo: string; amount: string; tax: string; total: string }> = {}): string[][] {
  const o = { trade: 'テスト仮設鳶・土工手間', code: '31100000', docNo: '300001', amount: '¥10,000,000', tax: '¥1,000,000', total: '¥11,000,000', ...over }
  return [
    ['請 求 書', '（控え）'],
    ['工事コード/受注者工事コード', '11AB00000', '/', '出来高調査回数', '3', '出来高調査日', '2026', '年', '09', '月', '30', '日'],
    ['帳票No/帳票年月日/注文番号', o.docNo, '/', '2026', '年', '10', '月', '15', '日', '/', o.docNo, '今回迄の請求回数', '3', '請求予定年月'],
    ['受注者コード', '222000000000', '発注者名', '株式会社大林組'],
    ['会社名', '山岡建設工業株式会社', '発注者担当住所', '東京都港区'],
    ['電話番号', '工事場所受渡し場所名称', 'テスト地区開発計画', '施工業務'],
    ['取引件名コード', o.code, '工事場所電話番号', '03-0000-0000'],
    ['取引件名', o.trade],
    ['工事・納期開始日', '2025', '年', '09', '月', '15', '日', '契約金額計', '¥100,000,000', '契約金額計調整額', '¥0'],
    ['今回迄累積請求金額計', '¥50,000,000', '今回迄累積請求保留金額計', '¥0'],
    ['今回請求金額計(調整前)', o.amount, '今回請求金額計調整額', '¥0'],
    ['今回請求金額計', o.amount, '消費税額(調整前)', o.tax],
    ['消費税額調整額', '¥0'],
    ['最終帳票金額', o.total, '消費税額', o.tax],
    ['消費税率', '検査完了予定日'],
  ]
}

// ── 山岡の控除計算書（架空の数字）。他社借受 1名（佐々木・テスト建設）と、出向者（田中）の給与控除 ──
function memoLines(): string[][] {
  return [
    ['所属元の異なる借受職人給与の控除（8/21～9/20）'],
    ['■大林組への請求額', '【テスト仮設工事（税別）】'],
    ['単位', '常傭単価', '金額', '大林組'],
    ['鳶工', '100.50', '人', '36,000', '＝', '3,618,000'],
    ['残業', '8.0', 'H', '5,625', '＝', '45,000', '山岡'],
    ['土工', '200.00', '人', '28,000', '＝', '5,600,000'],
    ['残業', '120.0', 'H', '4,375', '＝', '525,000'],
    ['値引き'],
    ['計', '9,788,000'],
    ['佐々木分出面（8/21～9/20）', '※21日～31日と翌月1日～20日に分けて計算'],
    ['この人工を上記契約工数から差し引く', '佐々木給与（8/21～9/20）'],
    ['単位', '常傭単価', '金額'],
    ['鳶工', '2', '人', '36,000', '＝', '72,000', '人工', '2', '人工', '20,000', '＝', '40,000'],
    ['設', '残業', 'H', '5,625', '＝', '0', '５H勤務', '0', '日', '15,000', '＝', '0'],
    ['計', '72,000', '→×85％=', '61,200', '残業・40H超', '0', 'H', '3,000', '＝', '0'],
    ['計', '40,000'],
    ['佐々木分差引'],
    ['▲ 40,000', '＝', '21,200', 'テスト建設支払額（税別）'],
    ['※佐々木分人工控除後の人工', '田中分給与（8/21～9/20）'],
    ['鳶工', '98.50', '人', '36,000', '＝', '3,546,000', '人工', '20', '人工', '20,000', '＝', '400,000'],
    ['残業', '8.00', 'H', '5,625', '＝', '45,000', '残業・40H超', '10', 'H', '4,000', '＝', '40,000'],
    ['土工', '200.00', '人', '28,000', '＝', '5,600,000', '計', '440,000'],
    ['残業', '120.00', 'H', '4,375', '＝', '525,000', '田中分差引'],
    ['計', '9,716,000', '→×85％=', '8,258,600', '→', '▲ 440,000', '＝', '7,818,600', '日比建設支払額（税別）'],
  ]
}

describe('数字の読み取り', () => {
  test('¥・カンマ・▲・小数', () => {
    expect(parseMoneyToken('¥13,123,000')).toBe(13123000)
    expect(parseMoneyToken('¥-760')).toBe(-760)
    expect(parseMoneyToken('▲ 604,743')).toBe(604743)
    expect(parseMoneyToken('182.25')).toBe(182.25)
    expect(parseMoneyToken('１２，３４５')).toBe(12345)
    expect(parseMoneyToken('人')).toBeNull()
    expect(parseMoneyToken(undefined)).toBeNull()
  })
})

describe('大林組の控えの読み取り', () => {
  test('工種・帳票No・日付・金額を取り出す', () => {
    const lines = gcLines()
    expect(looksLikeGcStatement(lines)).toBe(true)
    expect(looksLikeMemo(lines)).toBe(false)
    const r = parseGcStatement(lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.statement).toMatchObject({
      tradeName: 'テスト仮設鳶・土工手間', tradeCode: '31100000', docNo: '300001', billDate: '2026-10-15', surveyDate: '2026-09-30',
      projectName: 'テスト地区開発計画 施工業務', gcName: '株式会社大林組', contractorName: '山岡建設工業株式会社',
      amount: 10000000, tax: 1000000, total: 11000000, round: 3, contractTotal: 100000000, cumulative: 50000000,
    })
  })
  test('「今回請求金額計(調整前)」ではなく「今回請求金額計」を取る', () => {
    const lines = gcLines({ amount: '¥2,984,000', tax: '¥298,400', total: '¥3,282,400' })
    lines[10] = ['今回請求金額計(調整前)', '¥9,999,999', '今回請求金額計調整額', '¥0']
    const r = parseGcStatement(lines)
    expect(r.ok && r.statement.amount).toBe(2984000)
  })
  test('控えの形でなければ読まない', () => {
    expect(parseGcStatement([['請求書'], ['合計', '1,000']]).ok).toBe(false)
    expect(parseGcStatement(gcLines().filter(l => l[0] !== '取引件名')).ok).toBe(false)
  })
})

describe('山岡の控除計算書の読み取り', () => {
  test('内訳・他社借受・給与控除・支払額', () => {
    const lines = memoLines()
    expect(looksLikeMemo(lines)).toBe(true)
    expect(looksLikeGcStatement(lines)).toBe(false)
    const r = parseMemo(lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.memo
    expect(m.tradeLabel).toBe('テスト仮設工事')
    expect(m.periodLabel).toBe('8/21~9/20')
    expect(m.gcTotal).toBe(9788000)
    expect(m.gcLines.map(l => [l.item, l.qty, l.unit, l.rate, l.amount])).toEqual([
      ['鳶工', 100.5, '人', 36000, 3618000], ['残業', 8, 'H', 5625, 45000], ['土工', 200, '人', 28000, 5600000], ['残業', 120, 'H', 4375, 525000],
    ])
    expect(m.borrowed).toHaveLength(1)
    expect(m.borrowed[0]).toMatchObject({ name: '佐々木', companyName: 'テスト建設', amount: 72000, ratioAmount: 61200, wage: 40000, payable: 21200 })
    expect(m.borrowed[0].lines.map(l => l.amount)).toEqual([72000, 0])
    // 「田中分差引」が人工の行と同じ行にあっても名前だけ取る
    expect(m.hibi).toEqual({ base: 9716000, ratioAmount: 8258600, wageName: '田中', wage: 440000, payable: 7818600 })
  })
  test('給与の控除が無い月（▲ が無い）は 0', () => {
    const lines = memoLines().slice(0, 9)
    lines.push(['計', '9,788,000', '→×85％=', '8,319,800', '＝', '8,319,800', '日比建設支払額（税別）'])
    const r = parseMemo(lines)
    expect(r.ok && r.memo.hibi).toEqual({ base: 9788000, ratioAmount: 8319800, wageName: '', wage: 0, payable: 8319800 })
    expect(r.ok && r.memo.borrowed).toEqual([])
  })
  test('日比建設支払額の行が無ければ読めない', () => {
    const r = parseMemo(memoLines().slice(0, 18))
    expect(r.ok).toBe(false)
  })
})

describe('請求額の計算（85%・切り出し・控除）', () => {
  test('式: floor((大林 − 他社借受) × 85%) − 給与', () => {
    expect(PRIME_INVOICE_RATIO).toBe(0.85)
    expect(computeSheetAmounts({ gcAmount: 9788000, borrowed: [{ name: 'a', companyName: '', amount: 72000 }], wageDeductions: [{ name: 'b', amount: 440000 }] }))
      .toEqual({ base: 9716000, ratioAmount: 8258600, amount: 7818600, tax: 781860, total: 8600460 })
    // 端数は切り捨て（1,000円単位の85%は50円単位なので通常は出ない）
    expect(computeSheetAmounts({ gcAmount: 1001, borrowed: [], wageDeductions: [] })).toMatchObject({ ratioAmount: 850, amount: 850, tax: 85 })
  })
  test('割合は発行ごとに変えられる（IHI の 90% の月。2026-10-20 代表）', () => {
    expect(computeSheetAmounts({ gcAmount: 9032000, borrowed: [], wageDeductions: [] }, 0.9)).toEqual({ base: 9032000, ratioAmount: 8128800, amount: 8128800, tax: 812880, total: 8941680 })
    expect(parseRatioPercent('90')).toBe(0.9)
    expect(parseRatioPercent('85')).toBe(0.85)
    expect(parseRatioPercent('87.5')).toBe(0.875)
    expect(parseRatioPercent('0')).toBeNull()
    expect(parseRatioPercent('101')).toBeNull()
    expect(parseRatioPercent('abc')).toBeNull()
    const st = (parseGcStatement(gcLines({ amount: '¥9,788,000', tax: '¥978,800', total: '¥10,766,800' })) as { ok: true; statement: GcStatement }).statement
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo
    // 90% で組むと、メモ（85%）とは合わない注意が出て、85% の差の注意は出ない
    const s90 = assembleSheets([{ st, file: 'a' }], [{ memo, file: 'm' }], 0.9).sheets[0]
    expect(s90.amount).toBe(Math.floor((9788000 - 72000) * 0.9) - 440000)
    expect(s90.warnings.some(w => w.includes('割合が 90%'))).toBe(true)
    expect(s90.warnings.some(w => w.includes('円の差があります'))).toBe(false)
    // 85% に戻すと注意が消える
    const back = recomputeSheet(s90, 0.85)
    expect(back.amount).toBe(7818600)
    expect(back.warnings).toEqual([])
  })
  test('控えとメモからの1枚: メモの支払額と一致すれば注意なし', () => {
    const st = (parseGcStatement(gcLines({ amount: '¥9,788,000', tax: '¥978,800', total: '¥10,766,800' })) as { ok: true; statement: GcStatement }).statement
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo
    const s = buildSheet(st, memo, { statementFile: 'a.pdf', memoFile: 'm.pdf' })
    expect(s.amount).toBe(7818600)
    expect(s.memoPayable).toBe(7818600)
    expect(s.wageDeductions).toEqual([{ name: '田中', amount: 440000 }])
    expect(s.borrowed).toEqual([{ name: '佐々木', companyName: 'テスト建設', amount: 72000 }])
    expect(s.warnings).toEqual([])
    expect(s.source).toBe('parsed')
  })
  test('メモの金額が控えと違う・支払額が合わないときは注意を出す', () => {
    const st = (parseGcStatement(gcLines()) as { ok: true; statement: GcStatement }).statement   // 10,000,000
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo                 // 9,788,000
    const s = buildSheet(st, memo, { statementFile: 'a.pdf', memoFile: 'm.pdf' })
    expect(s.warnings.some(w => w.includes('控えの今回請求金額計'))).toBe(true)
    expect(s.warnings.some(w => w.includes('日比建設支払額'))).toBe(true)
  })
  test('手で直したら計算し直す（給与も消費税も）', () => {
    const st = (parseGcStatement(gcLines()) as { ok: true; statement: GcStatement }).statement
    const s = buildSheet(st, null, { statementFile: 'a.pdf', memoFile: null })
    expect(s.amount).toBe(8500000)
    const r = recomputeSheet({ ...s, gcAmount: 2000000, wageDeductions: [{ name: 'x', amount: 100000 }] })
    expect(r).toMatchObject({ gcAmount: 2000000, gcTax: 200000, gcTotal: 2200000, base: 2000000, ratioAmount: 1700000, amount: 1600000, tax: 160000, total: 1760000 })
  })
})

describe('控えとメモの組み合わせ', () => {
  const st = (over: Parameters<typeof gcLines>[0]) => (parseGcStatement(gcLines(over)) as { ok: true; statement: GcStatement }).statement
  test('メモは金額の一致する控えに付く（工種名が違っても）', () => {
    const a = st({ trade: 'ＬＣ・ＷＰＦ足場', code: '1', docNo: '326046', amount: '¥2,984,000', tax: '¥298,400', total: '¥3,282,400' })
    const b = st({ trade: '地上仮設整備鳶・土工手間', code: '2', docNo: '311022', amount: '¥9,788,000', tax: '¥978,800', total: '¥10,766,800' })
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo
    expect(matchMemoToSheet(memo, [a, b])).toBe(1)
    const r = assembleSheets([{ st: a, file: 'a' }, { st: b, file: 'b' }], [{ memo, file: 'm' }])
    expect(r.warnings).toEqual([])
    // 帳票No 順
    expect(r.sheets.map(s => s.docNo)).toEqual(['311022', '326046'])
    expect(r.sheets[0].memoFile).toBe('m')
    expect(r.sheets[1].memoFile).toBeNull()
    expect(sumSheets(r.sheets)).toEqual({ subtotal: 7818600 + 2536400, tax: 781860 + 253640, total: 7818600 + 2536400 + 781860 + 253640 })
  })
  test('金額が合わなければ工種名で探し、それも無ければ注意', () => {
    const a = st({ trade: 'テスト仮設工事', amount: '¥5,000,000', tax: '¥500,000', total: '¥5,500,000' })
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo
    expect(matchMemoToSheet(memo, [a])).toBe(0)
    const other = st({ trade: 'コンクリート打設工事', amount: '¥5,000,000', tax: '¥500,000', total: '¥5,500,000' })
    expect(matchMemoToSheet(memo, [other])).toBe(-1)
    const r = assembleSheets([{ st: other, file: 'o' }], [{ memo, file: 'm' }])
    expect(r.warnings.some(w => w.includes('どの工種の控えに当たるか'))).toBe(true)
    expect(r.sheets[0].memo).toBeNull()
  })
  test('同じ控えを2回入れたら注意', () => {
    const a = st({})
    const r = assembleSheets([{ st: a, file: 'a' }, { st: a, file: 'a2' }], [])
    expect(r.warnings.some(w => w.includes('2枚あります'))).toBe(true)
  })
})

describe('期間・日付', () => {
  test('人工の期間は前月21日〜当月20日、請求書の期間は対象月の1日〜末日、請求年月日は翌月15日', () => {
    expect(primePeriodOf('202609')).toEqual({ from: '2026-08-21', to: '2026-09-20', fromYm: '202608', toYm: '202609' })
    expect(primePeriodOf('202601')).toEqual({ from: '2025-12-21', to: '2026-01-20', fromYm: '202512', toYm: '202601' })
    expect(primeBillingPeriodOf('202602')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(defaultPrimeInvoiceDate('202612')).toBe('2027-01-15')
    expect(reiwaDate('2026-10-15')).toBe('令和8年10月15日')
    expect(reiwaDate('2019-05-01')).toBe('令和元年5月1日')
    expect(primeOtRate(36000)).toBe(5625)
    expect(primeOtRate(28000)).toBe(4375)
  })
})

describe('出面との検算（前月21日〜当月20日）', () => {
  const main = {
    workers: [
      { id: 1, name: '鳶A', job: 'tobi', visa: 'engineer', rate: 0, otMul: 1.25, hireDate: '2020-01-01', org: 'hibi' },
      { id: 2, name: '土工B', job: 'doko', visa: 'engineer', rate: 0, otMul: 1.25, hireDate: '2020-01-01', org: 'hibi' },
      { id: 3, name: '出向C', job: 'shokucho', visa: 'none', rate: 0, otMul: 1.25, hireDate: '2020-01-01', org: 'hibi', dispatchTo: '山岡建設工業' },
      { id: 4, name: '事務D', job: 'jimu', visa: 'none', rate: 0, otMul: 1.25, hireDate: '2020-01-01', org: 'hibi' },
    ],
    sites: [
      { id: 'site1', name: 'テスト現場', start: '2025-01', end: '', foreman: 3, archived: false, rates: [{ from: '202501', tobiRate: 36000, dokoRate: 28000 }] },
      { id: 'site1_steel', name: 'テスト現場（鉄骨）', start: '2025-01', end: '', foreman: 3, archived: false, parentId: 'site1', workType: '鉄骨' },
      { id: 'other', name: '別の現場', start: '2025-01', end: '', foreman: 3, archived: false },
    ],
    subcons: [{ id: 'sub_doko', name: '土工業者X', type: '土工業者', rate: 0, otRate: 0, note: '' }],
    assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
    defaultRates: { tobiRate: 38000, dokoRate: 30000 }, mforeman: {}, nightDays: {},
  } as unknown as MainData
  const attD = {
    'site1_1_202608_20': { w: 1 },           // 8/20 は期間外
    'site1_1_202608_21': { w: 1, o: 2 },     // 8/21 から
    'site1_1_202609_20': { w: 1 },           // 9/20 まで
    'site1_1_202609_21': { w: 1 },           // 9/21 は期間外
    'site1_steel_1_202609_10': { w: 0.5 },   // 工種サイトも足す
    'site1_2_202609_01': { w: 1, o: 1.5 },
    'site1_3_202609_02': { w: 1 },           // 出向者も含める
    'site1_4_202609_03': { w: 1 },           // 事務は鳶土工でないので除外
    'site1_1_202609_05': { w: 1, p: 1 },     // 有給は除外
    'other_1_202609_06': { w: 1 },           // 別の現場
  } as never
  const attSD = { 'site1_sub_doko_202609_04': { n: 2, on: 3 } }
  test('人工・残業・金額・人工のある日', () => {
    const agg = aggregatePrimeManDays(main, attD, attSD, ['site1', 'site1_steel'], '202609')
    expect(agg.period).toEqual({ from: '2026-08-21', to: '2026-09-20' })
    expect(agg.tobiDays).toBe(3.5)      // 8/21・9/20・鉄骨 0.5・出向者 1
    expect(agg.tobiOtH).toBe(2)
    expect(agg.dokoDays).toBe(3)        // 土工B 1 ＋ 外注 2
    expect(agg.dokoOtH).toBe(4.5)
    expect(agg.rates).toEqual({ tobiRate: 36000, dokoRate: 28000, tobiOtRate: 5625, dokoOtRate: 4375 })
    expect(agg.amount).toBe(Math.round(3.5 * 36000 + 2 * 5625 + 3 * 28000 + 4.5 * 4375))
    expect(agg.rows.find(r => r.key === 'w3')?.dispatched).toBe(true)
    expect(agg.rows.find(r => r.key === 's sub_doko'.replace(' ', ''))?.isSubcon).toBe(true)
    expect(agg.rows.some(r => r.key === 'w4')).toBe(false)
    expect(agg.activeDays).toEqual([{ ym: '202608', day: 21 }, { ym: '202609', day: 1 }, { ym: '202609', day: 2 }, { ym: '202609', day: 4 }, { ym: '202609', day: 10 }, { ym: '202609', day: 20 }])
  })
  test('全枚の合計 vs 出面の総人工 × 常用単価（2026-10-20 代表: メモは手間契約1本分なので比べない）', () => {
    const agg = aggregatePrimeManDays(main, attD, attSD, ['site1', 'site1_steel'], '202609')
    // 出面ベース = 3.5×36,000 + 2×5,625 + 3×28,000 + 4.5×4,375 = 240,938
    const o = checkPrimeOverall([{ gcAmount: 200000 }, { gcAmount: 40000 }], agg)
    expect(o).toMatchObject({ gcTotal: 240000, sheetCount: 2, deduraAmount: agg.amount, diff: agg.amount - 240000, totalDays: 6.5, tobiDays: 3.5, dokoDays: 3 })
    expect(o.diffRate).toBeCloseTo(938 / 240000, 6)
    expect(o.tone).toBe('ok')
    expect(o.perManDay).toBe(Math.round(240000 / 6.5))
    expect(checkPrimeOverall([{ gcAmount: 300000 }], agg).tone).toBe('bad')      // −20%
    expect(checkPrimeOverall([{ gcAmount: 225000 }], agg).tone).toBe('warn')     // +7%
    expect(checkPrimeOverall([], agg)).toMatchObject({ gcTotal: 0, diffRate: null, tone: 'none' })
  })
  test('控除計算書の内訳（参考）: 残業は鳶の次・土工の次で割り当て', () => {
    const memo = (parseMemo(memoLines()) as { ok: true; memo: MemoParsed }).memo
    expect(memoManDayRows(memo).map(r => [r.label, r.qty, r.unit, r.rate, r.amount])).toEqual([
      ['鳶 人工', 100.5, '人', 36000, 3618000], ['鳶 残業', 8, 'H', 5625, 45000], ['土工 人工', 200, '人', 28000, 5600000], ['土工 残業', 120, 'H', 4375, 525000],
    ])
    expect(memoManDayRows(null)).toEqual([])
  })
})

describe('支払内訳書との突き合わせ（入金のチェック）', () => {
  test('発行済みの税込合計 vs 振込額', () => {
    expect(comparePrimeWithRemittance([{ total: 11571127 }, { total: 2129930 }], [{ total: 13701057 }])).toMatchObject({ invoiceTotal: 13701057, invoiceCount: 2, remittanceTotal: 13701057, remittanceCount: 1, diff: 0, result: 'match' })
    expect(comparePrimeWithRemittance([{ total: 1000000 }], [{ total: 999560 }]).result).toBe('close')     // 振込手数料など 1,000円以内
    expect(comparePrimeWithRemittance([{ total: 1000000 }], [{ total: 900000 }])).toMatchObject({ diff: -100000, result: 'diff' })
    expect(comparePrimeWithRemittance([], [{ total: 900000 }]).result).toBe('noInvoice')
    expect(comparePrimeWithRemittance([{ total: 1000000 }], []).result).toBe('noRemittance')
    // 振込額が未入力（0）の内訳書は「届いた」とだけ数える
    expect(comparePrimeWithRemittance([{ total: 1000000 }], [{ total: 0 }])).toMatchObject({ remittanceCount: 1, remittanceTotal: 0, result: 'noRemittance' })
  })
})

describe('給与の伏せ字と手入力の確認', () => {
  test('pay.view の無い人には控除の給与額と控除計算書を見せない', () => {
    const b = {
      sheets: [{ wageDeductions: [{ name: '田中', amount: 440000 }], ratioAmount: 8258600, base: 9716000, memoPayable: 7818600, memo: {} as MemoParsed, amount: 7818600 }],
      files: [{ path: 'a', name: 'a.pdf', contentType: 'application/pdf', size: 1, kind: 'statement' }, { path: 'm', name: 'm.pdf', contentType: 'application/pdf', size: 1, kind: 'memo' }],
    } as unknown as Pick<PrimeInvoiceBundle, 'sheets' | 'files'>
    const m = maskPrimeBundleForViewer(b)
    expect(m.wageMasked).toBe(true)
    expect(m.sheets[0].wageDeductions).toEqual([{ name: '田中', amount: 0 }])
    expect(m.sheets[0].ratioAmount).toBe(0)
    expect(m.sheets[0].memo).toBeNull()
    expect(m.sheets[0].amount).toBe(7818600)   // 請求額そのものは残す
    expect(m.files.map(f => f.kind)).toEqual(['statement'])
  })
  test('手で直す内容の確認', () => {
    expect(sanitizeSheetEdit({ tradeName: ' 仮設 ', gcAmount: '1,000,000', borrowed: [{ name: '佐々木', companyName: 'テスト建設', amount: '36,000' }, { name: '', amount: '' }], wageDeductions: [{ name: '田中', amount: 100000 }] }))
      .toEqual({ ok: true, sheet: { tradeName: '仮設', tradeCode: '', docNo: '', billDate: '', gcAmount: 1000000, borrowed: [{ name: '佐々木', companyName: 'テスト建設', amount: 36000 }], wageDeductions: [{ name: '田中', amount: 100000 }] } })
    expect(sanitizeSheetEdit({ tradeName: '', gcAmount: 1 }).ok).toBe(false)
    expect(sanitizeSheetEdit({ tradeName: 'x', gcAmount: 0 }).ok).toBe(false)
    expect(sanitizeSheetEdit({ tradeName: 'x', gcAmount: 10, borrowed: [{ name: 'a', amount: 'abc' }] }).ok).toBe(false)
    expect(sanitizeSheetEdit({ tradeName: 'x', gcAmount: 10, wageDeductions: [{ name: '', amount: 5 }] }).ok).toBe(false)
  })
})

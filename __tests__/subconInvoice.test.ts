/**
 * 受け取った外注の請求書と出面 × 単価の見比べ（lib/subcon-invoice.ts・2026-10-05）
 */
import { describe, test, expect } from 'vitest'
import { compareSubconInvoice, invoiceExTax, subconTotalsError, missingSubconInvoices, explainSubconDiff, type SubconExpected } from '@/lib/subcon-invoice'

const exp = (cost: number, workDays = 10): SubconExpected => ({ workDays, otCount: 0, cost, sites: [] })

describe('invoiceExTax', () => {
  test('税抜小計があればそれ、無ければ税込 ÷ 1.1', () => {
    expect(invoiceExTax({ subtotal: 300000, total: 330000 })).toEqual({ value: 300000, estimated: false })
    expect(invoiceExTax({ total: 330000 })).toEqual({ value: 300000, estimated: true })
  })
})

describe('compareSubconInvoice', () => {
  test('1円も違わなければ一致', () => {
    expect(compareSubconInvoice([{ subtotal: 300000, total: 330000 }], exp(300000)).result).toBe('match')
  })
  test('1万円以内はほぼ一致', () => {
    const c = compareSubconInvoice([{ subtotal: 309000, total: 339900 }], exp(300000))
    expect(c.result).toBe('close')
    expect(c.diff).toBe(9000)
  })
  test('3%以内も（大きい外注先）ほぼ一致', () => {
    expect(compareSubconInvoice([{ subtotal: 2_050_000, total: 2_255_000 }], exp(2_000_000)).result).toBe('close')
  })
  test('両方を超えれば差あり（請求書 − 出面）', () => {
    const c = compareSubconInvoice([{ subtotal: 900000, total: 990000 }], exp(300000 * 1))
    expect(c.result).toBe('diff')
    expect(c.diff).toBe(600000)
  })
  test('同じ外注先の2枚は合算', () => {
    const c = compareSubconInvoice([{ subtotal: 100000, total: 110000 }, { subtotal: 200000, total: 220000 }], exp(300000))
    expect(c.invoiceExTax).toBe(300000)
    expect(c.result).toBe('match')
  })
  test('出面に人工が無い外注先は一致にしない', () => {
    expect(compareSubconInvoice([{ total: 110000 }], undefined).result).toBe('noWork')
  })
})

describe('subconTotalsError', () => {
  test('両方入っていて合わなければ止める', () => {
    expect(subconTotalsError({ subtotal: 100, tax: 10, total: 110 })).toBeNull()
    expect(subconTotalsError({ subtotal: 100, tax: 10, total: 111 })).not.toBeNull()
    expect(subconTotalsError({ subtotal: 100, total: 999 })).toBeNull()
  })
})

describe('missingSubconInvoices', () => {
  test('人工があって請求書が無い外注先だけ。単価0（元請が直接払う）は出さない', () => {
    const m = missingSubconInvoices(
      { a: exp(500000), b: exp(300000), c: exp(0, 108) },
      [{ companyId: 'b' }],
      { a: '吉本建設工業', b: '村田工業', c: '鈴高組（土工）' },
    )
    expect(m.map(x => x.companyName)).toEqual(['吉本建設工業'])
  })
})

describe('explainSubconDiff（差を人工・残業で言い換える）', () => {
  const ex = (rate: number, otRate: number): Pick<SubconExpected, 'sites'> => ({ sites: [{ siteId: 's', siteName: 'S', workDays: 20, otCount: 0, cost: 20 * rate, rate, otRate }] })
  test('ちょうど人工の整数個', () => {
    expect(explainSubconDiff(-26000, ex(26000, 4063))).toBe('−1人工分')
    expect(explainSubconDiff(52000, ex(26000, 4063))).toBe('+2人工分')
  })
  test('人工 ＋ 残業 h（0.5h 刻み・1円以内）', () => {
    expect(explainSubconDiff(-30063, ex(26000, 4063))).toBe('−1人工 ＋ 残業1h 分')
    expect(explainSubconDiff(-2032, ex(26000, 4063))).toBe('−残業0.5h 分')   // 4063 × 0.5 = 2031.5 → 1円以内
  })
  test('説明できないときは約◯人工分、差が無ければ null', () => {
    expect(explainSubconDiff(-15000, ex(26000, 4063))).toBe('約 −0.6人工分')
    expect(explainSubconDiff(0, ex(26000, 4063))).toBeNull()
    expect(explainSubconDiff(-1, ex(26000, 4063))).toBeNull()        // 端数は言い換えない
    expect(explainSubconDiff(-26000, { sites: [] })).toBeNull()
    expect(explainSubconDiff(-26000, ex(0, 0))).toBeNull()
  })
  test('単価は人工の多い現場のもの', () => {
    const two: Pick<SubconExpected, 'sites'> = { sites: [{ siteId: 'a', siteName: 'A', workDays: 2, otCount: 0, cost: 60000, rate: 30000, otRate: 4688 }, { siteId: 'b', siteName: 'B', workDays: 20, otCount: 0, cost: 520000, rate: 26000, otRate: 4063 }] }
    expect(explainSubconDiff(-26000, two)).toBe('−1人工分')
  })
})

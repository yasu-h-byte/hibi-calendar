/**
 * 受け取った外注の請求書と出面 × 単価の見比べ（lib/subcon-invoice.ts・2026-10-05）
 */
import { describe, test, expect } from 'vitest'
import { compareSubconInvoice, invoiceExTax, subconTotalsError, missingSubconInvoices, type SubconExpected } from '@/lib/subcon-invoice'

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

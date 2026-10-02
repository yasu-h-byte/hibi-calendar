/**
 * 紙の請求書の確認（lib/paper-invoice.ts・2026-10-02 総合点検）
 *   - 税抜小計＋消費税＝税込合計
 *   - システムで発行済み・承認待ちの会社・月には入れない（逆方向の二重請求）
 *   - 同じ会社に2枚以上あるときは合算で見比べる
 */
import { describe, test, expect } from 'vitest'
import { paperTotalsError, systemDoubleBillingError, mergePaperInvoices, comparePaperWithSystem } from '@/lib/paper-invoice'

describe('paperTotalsError', () => {
  test('両方入っていて合わないときだけ理由を返す', () => {
    expect(paperTotalsError({ subtotal: 100000, tax: 10000, total: 110000 })).toBeNull()
    expect(paperTotalsError({ subtotal: 100000, tax: 10000, total: 110001 })).toContain('合いません')
    expect(paperTotalsError({ subtotal: null, tax: 10000, total: 110001 })).toBeNull()
    expect(paperTotalsError({ total: 110001 })).toBeNull()
  })
})

describe('systemDoubleBillingError', () => {
  const recs = [
    { companyId: 'a', ym: '202609', status: 'issued', no: 'HC-202609-01' },
    { companyId: 'b', ym: '202609', status: 'pending' },
    { companyId: 'c', ym: '202609', status: 'void', no: 'HC-202609-02' },
    { companyId: 'a', ym: '202608', status: 'rejected' },
  ]
  test('発行済み・承認待ちは止める。取り消し・差し戻し・別の月は止めない', () => {
    expect(systemDoubleBillingError(recs, '202609', 'a')).toContain('HC-202609-01')
    expect(systemDoubleBillingError(recs, '202609', 'b')).toContain('承認待ち')
    expect(systemDoubleBillingError(recs, '202609', 'c')).toBeNull()
    expect(systemDoubleBillingError(recs, '202608', 'a')).toBeNull()
    expect(systemDoubleBillingError(recs, '202609', 'zzz')).toBeNull()
  })
})

describe('mergePaperInvoices', () => {
  test('合算は小計・税・合計を足し、どれかに無ければ null。明細は全部にあるときだけつなぐ', () => {
    const m = mergePaperInvoices([
      { subtotal: 100, tax: 10, total: 110, lines: [{ site: 'a', item: '鳶', qty: 2, unit: '人工', rate: 50, amount: 100 }] },
      { subtotal: 200, tax: 20, total: 220, lines: [{ site: 'b', item: '鳶', qty: 4, unit: '人工', rate: 50, amount: 200 }] },
    ])
    expect(m).toMatchObject({ subtotal: 300, tax: 30, total: 330 })
    expect(m.lines?.length).toBe(2)
    const m2 = mergePaperInvoices([{ subtotal: 100, tax: 10, total: 110, lines: null }, { subtotal: null, tax: null, total: 220 }])
    expect(m2).toEqual({ subtotal: null, tax: null, total: 330, lines: null })
  })
  test('合算で見比べると、2枚に分けた紙がシステムの月合計と一致する', () => {
    const sys = { source: 'draft' as const, subtotal: 300, tax: 30, total: 330, lines: [{ siteId: 'a', siteName: 'a', role: '鳶' as const, days: 6, rate: 50, amount: 300 }] }
    const p1 = { subtotal: 100, tax: 10, total: 110, lines: [{ site: 'a', item: '鳶', qty: 2, unit: '人工', rate: 50, amount: 100 }] }
    const p2 = { subtotal: 200, tax: 20, total: 220, lines: [{ site: 'b', item: '鳶', qty: 4, unit: '人工', rate: 50, amount: 200 }] }
    expect(comparePaperWithSystem(p1, sys).match).toBe(false)
    const g = comparePaperWithSystem(mergePaperInvoices([p1, p2]), sys)
    expect(g.match).toBe(true)
    expect(g.paperDays).toBe(6)
  })
})

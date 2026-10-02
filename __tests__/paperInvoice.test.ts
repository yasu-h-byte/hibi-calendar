/**
 * 紙（手作り）で出した請求書とシステムの見比べ（lib/paper-invoice.ts・2026-10-02）
 */
import { describe, test, expect } from 'vitest'
import {
  comparePaperWithSystem, sanitizePaperLines, parsePaperNumber, isBlankNumberInput,
  paperDoubleBillingError, paperSummaryFor, PAPER_INVOICE_DOC_ID_RE, type SystemInvoiceFigures,
} from '@/lib/paper-invoice'

// HFU → 日比建設 2025年12月分（手作りの現物: 鳶 94人工×30,000 ＋ 残業 4h×4,688 ＝ 税込 3,122,627円）
const sysHfu: SystemInvoiceFigures = {
  source: 'draft', subtotal: 2838752, tax: 283875, total: 3122627,
  lines: [
    { siteId: 's', siteName: '笹塚', role: '鳶', days: 94, rate: 30000, amount: 2820000 },
    { siteId: 's', siteName: '笹塚', role: '鳶', unit: 'h', days: 4, rate: 4688, amount: 18752 },
  ],
}

describe('comparePaperWithSystem', () => {
  test('同じ数字なら一致', () => {
    const c = comparePaperWithSystem({
      total: 3122627, subtotal: 2838752, tax: 283875,
      lines: [
        { site: '笹塚', item: '鳶', qty: 94, unit: '人工', rate: 30000, amount: 2820000 },
        { site: '笹塚', item: '鳶 残業', qty: 4, unit: 'h', rate: 4688, amount: 18752 },
      ],
    }, sysHfu)
    expect(c.match).toBe(true)
    expect(c.totalDiff).toBe(0)
    expect(c.paperDays).toBe(94)
    expect(c.systemDays).toBe(94)
    expect(c.paperOtHours).toBe(4)
    expect(c.systemOtHours).toBe(4)
  })
  test('差は「紙 − システム」。明細・小計が無ければ null', () => {
    const c = comparePaperWithSystem({ total: 3155627 }, sysHfu)
    expect(c.match).toBe(false)
    expect(c.totalDiff).toBe(33000)
    expect(c.subtotalDiff).toBeNull()
    expect(c.paperDays).toBeNull()
  })
  test('システムに請求が無い月は一致にしない', () => {
    const c = comparePaperWithSystem({ total: 100 }, { source: 'none', subtotal: 0, tax: 0, total: 0, lines: [] })
    expect(c.systemMissing).toBe(true)
    expect(c.match).toBe(false)
  })
})

describe('sanitizePaperLines', () => {
  test('空行は捨て、カンマ・円の付いた数字は読む', () => {
    const r = sanitizePaperLines([
      { site: '川崎', item: '鳶', qty: '10', unit: '人工', rate: '30,000', amount: '300,000円' },
      { site: '', item: '', qty: '', unit: '人工', rate: '', amount: '' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lines).toEqual([{ site: '川崎', item: '鳶', qty: 10, unit: '人工', rate: 30000, amount: 300000 }])
  })
  test('読めない数字はエラー', () => {
    expect(sanitizePaperLines([{ site: '川崎', item: '鳶', qty: 'じゅう', unit: '人工', rate: 1, amount: 1 }]).ok).toBe(false)
  })
})

describe('parsePaperNumber（NFKC）', () => {
  test('全角数字・全角カンマ・円・¥・空白を読む', () => {
    expect(parsePaperNumber('３００，０００円')).toBe(300000)
    expect(parsePaperNumber('￥4,366,313')).toBe(4366313)
    expect(parsePaperNumber(' 1 2 3 ')).toBe(123)
    expect(parsePaperNumber('１２．５')).toBe(12.5)
    expect(parsePaperNumber('−5,000')).toBe(-5000)
    expect(parsePaperNumber(30000)).toBe(30000)
  })
  test('読めないものは NaN、空欄は 0（空欄かどうかは isBlankNumberInput で見る）', () => {
    expect(parsePaperNumber('じゅう')).toBeNaN()
    expect(parsePaperNumber('1万')).toBeNaN()
    expect(parsePaperNumber('')).toBe(0)
    expect(isBlankNumberInput('')).toBe(true)
    expect(isBlankNumberInput('　')).toBe(true)
    expect(isBlankNumberInput(undefined)).toBe(true)
    expect(isBlankNumberInput('0')).toBe(false)
    expect(isBlankNumberInput(0)).toBe(false)
  })
})

describe('sanitizePaperLines（空行の決まり）', () => {
  test('全角で書いた明細も読む', () => {
    const r = sanitizePaperLines([{ site: '川崎', item: '鳶', qty: '１０', unit: '人工', rate: '３０，０００', amount: '３００，０００円' }])
    expect(r.ok && r.lines[0]).toEqual({ site: '川崎', item: '鳶', qty: 10, unit: '人工', rate: 30000, amount: 300000 })
  })
  test('現場・内容が空でも、数字の欄に読めない字があれば捨てずにエラー', () => {
    expect(sanitizePaperLines([{ site: '', item: '', qty: 'abc', unit: '人工', rate: '', amount: '' }]).ok).toBe(false)
    expect(sanitizePaperLines([{ site: '', item: '', qty: '', unit: '人工', rate: '', amount: 'x' }]).ok).toBe(false)
  })
  test('単価だけ入っている行は空行ではない（残す）', () => {
    const r = sanitizePaperLines([{ site: '', item: '', qty: '', unit: '人工', rate: '30000', amount: '' }])
    expect(r.ok && r.lines.length).toBe(1)
  })
  test('数量 0 と書いた行は空行ではない（残す）', () => {
    const r = sanitizePaperLines([{ site: '', item: '', qty: '0', unit: '人工', rate: '', amount: '' }])
    expect(r.ok && r.lines.length).toBe(1)
  })
  test('全部空欄（空白だけを含む）の行は捨てる', () => {
    const r = sanitizePaperLines([{ site: ' ', item: '', qty: '　', unit: '人工', rate: '', amount: '' }])
    expect(r.ok && r.lines).toEqual([])
  })
})

describe('二重請求の防止（paperDoubleBillingError）', () => {
  const recs = [
    { companyId: 'hata', ym: '202609', total: 1100000 },
    { companyId: 'hata', ym: '202609', total: 55000 },
    { companyId: 'yoshi', ym: '202609', total: 330000 },
    { companyId: 'hata', ym: '202608', total: 990000 },
  ]
  test('同じ会社・同じ月に紙の請求書があれば止める（月は「◯月分」で出す）', () => {
    const e = paperDoubleBillingError(recs, '202609', 'hata')
    expect(e).toContain('9月分は紙の請求書を登録済み')
    expect(e).toContain('二重請求')
  })
  test('会社か月が違えば止めない', () => {
    expect(paperDoubleBillingError(recs, '202610', 'hata')).toBeNull()
    expect(paperDoubleBillingError(recs, '202609', 'other')).toBeNull()
    expect(paperDoubleBillingError([], '202609', 'hata')).toBeNull()
  })
  test('件数と税込合計', () => {
    expect(paperSummaryFor(recs, '202609', 'hata')).toEqual({ count: 2, total: 1155000 })
    expect(paperSummaryFor(recs, '202609', 'none')).toEqual({ count: 0, total: 0 })
  })
})

describe('docId の形', () => {
  test('randomUUID の形だけ通す', () => {
    expect(PAPER_INVOICE_DOC_ID_RE.test('3f2b8c1e-9a4d-4e7f-8b2a-1c3d5e7f9a0b')).toBe(true)
    expect(PAPER_INVOICE_DOC_ID_RE.test('------------------------------------')).toBe(false)
    expect(PAPER_INVOICE_DOC_ID_RE.test('../paper-invoices/x')).toBe(false)
  })
})

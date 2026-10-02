/**
 * 紙（手作り）で出した請求書とシステムの見比べ（lib/paper-invoice.ts・2026-10-02）
 */
import { describe, test, expect } from 'vitest'
import { comparePaperWithSystem, sanitizePaperLines, type SystemInvoiceFigures } from '@/lib/paper-invoice'

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

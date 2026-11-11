/**
 * 賞与の配分の合計（lib/bonus-summary.ts・2026-11-11）。金額は架空。
 */
import { describe, test, expect } from 'vitest'
import { summarizeBonus, sortBonusLines, sameDayBonuses, sumBonusLines } from '@/lib/bonus-summary'

const lines = [
  { name: 'A', amount: 95000, nonSmokerAmount: 30000, childAmount: 220000, totalAmount: 345000, payMethod: 'transfer' as const },
  { name: 'B（出向）', amount: 190000, nonSmokerAmount: 30000, childAmount: 80000, totalAmount: 300000, paidBy: '出向先' },
  { name: 'C', amount: 190000, attendanceDays: 2, attendanceAmount: 40000, totalAmount: 230000, payMethod: 'cash' as const },
  { name: 'D', amount: 48000, totalAmount: 48000 },
]

describe('summarizeBonus', () => {
  const s = summarizeBonus(520000, lines)
  test('自社・出向先・全員を分けて数え、全員 = 自社 + 出向先', () => {
    expect(s.own.count).toBe(3)
    expect(s.dispatched.count).toBe(1)
    expect(s.own.profit).toBe(333000)
    expect(s.dispatched.profit).toBe(190000)
    expect(s.all.profit).toBe(s.own.profit + s.dispatched.profit)
    expect(s.all.total).toBe(s.own.total + s.dispatched.total)
    expect(s.own.total).toBe(345000 + 230000 + 48000)
  })
  test('原資との差（切り上げ・手直しの分）は、全員の利益分配 − 原資', () => {
    expect(s.overPool).toBe(523000 - 520000)
  })
  test('自社の合計 = ①＋②＋③＋④', () => {
    expect(s.own.total).toBe(s.own.profit + s.own.attendance + s.own.nonSmoker + s.own.child)
  })
  test('振込 + 現金 = 自社の合計（出向先の分は入らない。支払い方法が無ければ振込）', () => {
    expect(s.cash).toBe(230000)
    expect(s.transfer + s.cash).toBe(s.own.total)
  })
  test('古い記録（totalAmount が無い）は利益分配だけを合計にする', () => {
    expect(sumBonusLines([{ amount: 10000 }, { amount: 5000 }]).total).toBe(15000)
  })
})

describe('sortBonusLines', () => {
  test('出向先が払う人は、金額が大きくても下にまとめる', () => {
    expect(sortBonusLines(lines).map(l => l.name)).toEqual(['A', 'C', 'D', 'B（出向）'])
  })
  test('元の並びを書き換えない', () => {
    const before = lines.map(l => l.name)
    sortBonusLines(lines)
    expect(lines.map(l => l.name)).toEqual(before)
  })
})

describe('sameDayBonuses', () => {
  test('同じ支給日の確定済みだけを返す', () => {
    const recs = [{ paidOn: '2026-12-10', label: 'x' }, { paidOn: '2026-07-10', label: 'y' }]
    expect(sameDayBonuses(recs, '2026-12-10').map(r => r.label)).toEqual(['x'])
    expect(sameDayBonuses(recs, '2026-12-11')).toEqual([])
  })
})

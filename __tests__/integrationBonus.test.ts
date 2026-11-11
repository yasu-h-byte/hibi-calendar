/**
 * 経営コックピットへ渡す、確定した賞与の合計。個人ごとの額を渡さず、画面の合計行と同じ数え方になること。
 */
import { describe, it, expect } from 'vitest'
import { bonusToIntegration } from '@/lib/integration-bonus'

describe('bonusToIntegration', () => {
  const record = {
    id: '2026-12-22-1',
    label: '2026年 冬の賞与',
    paidOn: '2026-12-22',
    pool: 1_200_000,
    savedAt: '2026-11-11T01:00:00.000Z',
    allocations: [
      { amount: 300_000, attendanceDays: 5, attendanceAmount: 100_000, nonSmokerAmount: 20_000, childAmount: 30_000, totalAmount: 450_000, payMethod: 'transfer' as const },
      { amount: 200_000, attendanceDays: 0, attendanceAmount: 0, nonSmokerAmount: 0, childAmount: 0, totalAmount: 200_000, payMethod: 'cash' as const },
      // 出向先が払う人（自社の合計に入れない）
      { amount: 250_000, totalAmount: 250_000, paidBy: '山岡建設工業' },
    ],
  }
  const r = bonusToIntegration(record)

  it('自社が払う分と出向先が払う分を分ける', () => {
    expect(r.own).toMatchObject({ count: 2, profit: 500_000, attendance: 100_000, nonSmoker: 20_000, child: 30_000, total: 650_000 })
    expect(r.dispatched).toMatchObject({ count: 1, total: 250_000 })
  })
  it('自社が払う分の振込と現金', () => {
    expect(r.transfer).toBe(450_000)
    expect(r.cash).toBe(200_000)
  })
  it('支給名・支給日・原資をそのまま返し、個人ごとの額は持たない', () => {
    expect(r).toMatchObject({ id: '2026-12-22-1', label: '2026年 冬の賞与', paidOn: '2026-12-22', pool: 1_200_000 })
    expect(JSON.stringify(r)).not.toContain('allocations')
  })
  it('古い記録（合計が無い・配分が無い）でも落ちない', () => {
    expect(bonusToIntegration({ id: 'x' })).toMatchObject({ own: { count: 0, total: 0 }, dispatched: { count: 0, total: 0 }, pool: 0 })
    expect(bonusToIntegration({ id: 'y', allocations: [{ amount: 100_000 }] }).own.total).toBe(100_000)
  })
})

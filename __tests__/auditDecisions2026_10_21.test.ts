/**
 * 2026-10-21 総点検の判断待ち 7 件（代表「全部おすすめで」）のうち、純関数で確かめられるもの。
 */
import { describe, test, expect } from 'vitest'
import { isLoginLocked, nextThrottleAfterFailure, LOGIN_MAX_FAILURES } from '@/lib/login-throttle.server'
import { invoiceDaysOf } from '@/lib/peer-invoice-store'
import { CAPABILITIES, roleCan } from '@/lib/permissions'

describe('ログインの試行回数制限（15 分で 10 回失敗したら 15 分止める）', () => {
  const t0 = Date.parse('2026-10-21T09:00:00+09:00')
  test('9 回までは止めない。10 回目で lockedUntil が付く', () => {
    let rec = null as ReturnType<typeof nextThrottleAfterFailure> | null
    for (let i = 1; i < LOGIN_MAX_FAILURES; i++) {
      rec = nextThrottleAfterFailure(rec, t0 + i * 1000)
      expect(rec.failures).toBe(i)
      expect(isLoginLocked(rec, t0 + i * 1000)).toBe(false)
    }
    rec = nextThrottleAfterFailure(rec, t0 + 10_000)
    expect(rec.failures).toBe(LOGIN_MAX_FAILURES)
    expect(isLoginLocked(rec, t0 + 10_000)).toBe(true)
    expect(isLoginLocked(rec, t0 + 10_000 + 15 * 60 * 1000 - 1)).toBe(true)
    expect(isLoginLocked(rec, t0 + 10_000 + 15 * 60 * 1000 + 1)).toBe(false)
  })
  test('窓（15 分）が過ぎた失敗は数え直す', () => {
    let rec = nextThrottleAfterFailure(null, t0)
    for (let i = 0; i < 8; i++) rec = nextThrottleAfterFailure(rec, t0 + 1000)
    expect(rec.failures).toBe(9)
    rec = nextThrottleAfterFailure(rec, t0 + 16 * 60 * 1000)
    expect(rec.failures).toBe(1)
    expect(rec.lockedUntil).toBeUndefined()
  })
  test('記録が無ければ止めない', () => {
    expect(isLoginLocked(null, t0)).toBe(false)
    expect(isLoginLocked(undefined, t0)).toBe(false)
  })
})

describe('請求書の承認ゲートに載る日（人工のある日＋待機料の日）', () => {
  test('待機料だけの日も対象になる', () => {
    const sd = {
      siteId: 'ihi', siteName: 'IHI', siteTotal: 3,
      dayTotals: { 1: 2, 2: 1 },
      rows: [
        { cells: { 1: { md: 1 }, 2: { md: 1 }, 3: { md: 0, standby: true } } },
        { cells: { 1: { md: 1 }, 5: { md: 0, standby: true } } },
      ],
    }
    expect(invoiceDaysOf(sd as never)).toEqual([1, 2, 3, 5])
  })
  test('人工 0 で待機でもない日は載らない', () => {
    const sd = { siteId: 'x', siteName: 'x', siteTotal: 0, dayTotals: { 4: 0 }, rows: [{ cells: { 4: { md: 0 } } }] }
    expect(invoiceDaysOf(sd as never)).toEqual([])
  })
})

describe('就業カレンダーの直接承認は代表だけ（calendar.forceApprove）', () => {
  test('権限表に載り、代表だけが持つ', () => {
    expect(CAPABILITIES['calendar.forceApprove'].roles).toEqual(['owner'])
    expect(roleCan('owner', 'calendar.forceApprove')).toBe(true)
    expect(roleCan('approver', 'calendar.forceApprove')).toBe(false)
    expect(roleCan('approver', 'calendar.approve')).toBe(true)
  })
})

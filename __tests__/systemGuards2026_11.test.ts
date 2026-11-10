/**
 * 2026-11-10 全体点検で足した守りの決まり。
 *  - 締めの保存先に使える指定（年月・会社の形）
 *  - 消えない記録（auditTrail）は「既定で残す・外すものだけ並べる」
 *  - 自動処理（cron）の失敗の残し方と、通知ベルの文
 *  - 使い方を聞く（AI）の全体の回数の上限
 */
import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({}))

import { isValidLockTarget } from '@/lib/locks'
import { cronProblems, cronRunFromStatus, CRON_LABEL } from '@/lib/cron-status'
import { HELP_LIMITS, helpUsage, helpRemaining } from '@/lib/help'

describe('isValidLockTarget（締めの保存先）', () => {
  test('6桁の年月と、hibi / hfu / 指定なし だけを通す', () => {
    expect(isValidLockTarget('202610', 'hibi')).toBe(true)
    expect(isValidLockTarget('202610', 'hfu')).toBe(true)
    expect(isValidLockTarget('202610', undefined)).toBe(true)
    expect(isValidLockTarget('202610', '')).toBe(true)
  })
  test('「.」を含む・月が無い・数字でない年月は通さない（locks の中の形を崩させない）', () => {
    for (const ym of ['2026.10', '202610.x', '202613', '202600', '2026-10', '20261', '', null, undefined, 202610]) {
      expect(isValidLockTarget(ym, 'hibi')).toBe(false)
    }
  })
  test('知らない会社・「.」を含む会社は通さない', () => {
    for (const org of ['other', 'hibi.x', 'HIBI', 1, {}]) expect(isValidLockTarget('202610', org)).toBe(false)
  })
})

describe('isDurableAction（消えない記録）', () => {
  test('あとから足した機能の記録も既定で残る', async () => {
    const { isDurableAction } = await import('@/lib/activity')
    for (const a of [
      'primeInvoice.issue', 'primeInvoice.void', 'evaluation.create', 'leave.grant', 'leave.buyout',
      'leaveSettle.approve', 'staffDocs.delete', 'calendar.approve', 'homeLeave.add', 'mf-expense',
      'monthly.lock', 'worker.update', 'peerInvoice.issue', 'これから足す機能.操作',
    ]) expect(isDurableAction(a), a).toBe(true)
  })
  test('外すのは、出面の入力・毎朝の自動実行・索引の作り直し・お知らせだけ', async () => {
    const { isDurableAction } = await import('@/lib/activity')
    for (const a of ['attendance.gridEdit', 'mf-expense.run', 'leaveIndex.rebuild', 'announcement.add', '']) {
      expect(isDurableAction(a), a).toBe(false)
    }
  })
})

describe('自動処理の結果（cron-status）', () => {
  const now = '2026-11-10T22:20:00.000Z'
  test('500 番台だけが失敗。400 番台・200 は成功（設定なし・対象外は失敗にしない）', () => {
    expect(cronRunFromStatus(200, now)).toEqual({ at: now, ok: true })
    expect(cronRunFromStatus(404, now).ok).toBe(true)
    expect(cronRunFromStatus(500, now, '理由')).toEqual({ at: now, ok: false, error: '理由' })
    expect(cronRunFromStatus(503, now).error).toBe('応答 503')
    expect(cronRunFromStatus(500, now, 'x'.repeat(500)).error!.length).toBe(200)
  })
  test('失敗が残っているものだけをベルに出す。成功・記録なし・知らない名前は出さない', () => {
    expect(cronProblems(null)).toEqual([])
    expect(cronProblems({ 'leave-expiry': { at: now, ok: true } })).toEqual([])
    const msgs = cronProblems({
      'leave-expiry': { at: now, ok: false, error: 'x' },
      'mf-receipts': { at: now, ok: true },
      unknown: { at: now, ok: false },
    })
    expect(msgs).toEqual([`${CRON_LABEL['leave-expiry']}が失敗しています（2026-11-10）`])
  })
  test('ベルの文に内部の失敗理由を出さない', () => {
    const msgs = cronProblems({ 'commute-measure': { at: now, ok: false, error: 'SECRET_INTERNAL' } })
    expect(msgs.join('')).not.toContain('SECRET_INTERNAL')
  })
})

describe('使い方を聞く: 回数の上限', () => {
  test('本人ぶんと全員ぶんを1回の記録から数える', () => {
    expect(helpUsage([1, 303, 1, undefined, 0], 1)).toEqual({ mine: 2, all: 5 })
  })
  test('残りは、本人の残りと全体の残りの少ないほう', () => {
    expect(helpRemaining({ mine: 0, all: 0 })).toBe(HELP_LIMITS.perDay)
    expect(helpRemaining({ mine: 0, all: HELP_LIMITS.perDayAll - 3 })).toBe(3)
    expect(helpRemaining({ mine: HELP_LIMITS.perDay, all: 0 })).toBe(0)
    expect(helpRemaining({ mine: 0, all: HELP_LIMITS.perDayAll + 5 })).toBe(0)
  })
})

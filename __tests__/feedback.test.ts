import { describe, test, expect } from 'vitest'
import { feedbackTextError, unreadAfterPost, isUnreadFor, sortFeedback, FEEDBACK_LIMITS } from '@/lib/feedback'
import { can } from '@/lib/permissions'
import { requiredCapsForPath } from '@/lib/page-guard'

describe('困ったこと・要望の決まり', () => {
  test('内容が空で画像も無いのはだめ。画像だけならよい', () => {
    expect(feedbackTextError('  ')).toMatch(/内容/)
    expect(feedbackTextError('', 1)).toBeNull()
    expect(feedbackTextError('x'.repeat(FEEDBACK_LIMITS.text + 1))).toMatch(/文字まで/)
    expect(feedbackTextError('ok', FEEDBACK_LIMITS.images + 1)).toMatch(/枚まで/)
  })
  test('書いた側は既読・相手側に未読が付く', () => {
    expect(unreadAfterPost('user')).toEqual({ unreadForAuthor: false, unreadForOwner: true })
    expect(unreadAfterPost('owner')).toEqual({ unreadForAuthor: true, unreadForOwner: false })
    expect(unreadAfterPost('dev')).toEqual({ unreadForAuthor: true, unreadForOwner: false })
    // 代表が自分で書いたものには、代表あての未読を付けない
    expect(unreadAfterPost('user', { authorIsManager: true })).toEqual({ unreadForAuthor: false, unreadForOwner: false })
  })
  test('未読は見る人で変わる（代表は代表の未読・本人は自分の書き込みの未読だけ）', () => {
    const t = { author: { workerId: 303, name: '森田' }, unreadForAuthor: true, unreadForOwner: false }
    expect(isUnreadFor(t, { workerId: 303, manage: false })).toBe(true)
    expect(isUnreadFor(t, { workerId: 5, manage: false })).toBe(false)
    expect(isUnreadFor(t, { workerId: 0, manage: true })).toBe(false)
    // 代表が自分で書いたものに返信が来たら、代表にも未読
    expect(isUnreadFor({ author: { workerId: 0, name: '代表' }, unreadForAuthor: true, unreadForOwner: false }, { workerId: 0, manage: true })).toBe(true)
  })
  test('並び: 未読 → 終わっていない → 新しい順', () => {
    const list = [
      { id: 'a', status: 'done' as const, updatedAt: '2026-10-09T03:00:00Z', u: false },
      { id: 'b', status: 'open' as const, updatedAt: '2026-10-08T03:00:00Z', u: false },
      { id: 'c', status: 'open' as const, updatedAt: '2026-10-09T01:00:00Z', u: false },
      { id: 'd', status: 'doing' as const, updatedAt: '2026-10-01T00:00:00Z', u: true },
    ]
    expect(sortFeedback(list, t => t.u).map(t => t.id)).toEqual(['d', 'c', 'b', 'a'])
  })
})

describe('権限', () => {
  test('試験運用中は森田さん（303）と代表（0）だけ・全部を見るのは代表だけ', () => {
    expect(can({ role: 'jimu', workerId: 303 }, 'feedback.post')).toBe(true)
    expect(can({ role: 'admin', workerId: 0 }, 'feedback.post')).toBe(true)
    // ほかの事務・職長・事業責任者には出さない
    expect(can({ role: 'jimu', workerId: 304 }, 'feedback.post')).toBe(false)
    expect(can({ role: 'foreman', workerId: 20 }, 'feedback.post')).toBe(false)
    expect(can({ role: 'approver', workerId: 1 }, 'feedback.post')).toBe(false)
    expect(can({ role: 'jimu', workerId: 303 }, 'feedback.manage')).toBe(false)
    expect(can({ role: 'approver', workerId: 1 }, 'feedback.manage')).toBe(false)
    expect(can({ role: 'admin', workerId: 0 }, 'feedback.manage')).toBe(true)
  })
  test('画面の鍵', () => {
    expect(requiredCapsForPath('/feedback')).toEqual(['feedback.post'])
  })
})

/**
 * お知らせ（投稿分＋リリースノート・lib/release-notes.ts）の出し分け
 */
import { describe, test, expect } from 'vitest'
import { mergeAnnouncements, RELEASE_NOTES, type Announcement } from '@/lib/release-notes'

const posted: Announcement = { id: 'ann_1', title: '投稿', content: 'x', category: 'info', publishedAt: '2030-01-01T00:00:00Z', publishedBy: '管理者' }

describe('mergeAnnouncements', () => {
  test('投稿分は全員に・新しい順', () => {
    const list = mergeAnnouncements([posted], 'foreman')
    expect(list[0].id).toBe('ann_1')
    for (let i = 1; i < list.length; i++) {
      expect(new Date(list[i - 1].publishedAt).getTime()).toBeGreaterThanOrEqual(new Date(list[i].publishedAt).getTime())
    }
  })
  test('役割を指定したリリースノートはその役割にだけ出る', () => {
    const forForeman = mergeAnnouncements([], 'foreman').map(a => a.id)
    const forJimu = mergeAnnouncements([], 'jimu').map(a => a.id)
    expect(forForeman).toContain('rn_20260926_foreman')
    expect(forForeman).not.toContain('rn_20260926_morita')
    expect(forJimu).toContain('rn_20260926_morita')
    expect(forJimu).not.toContain('rn_20260926_foreman')
  })
  test('役割不明には全員向けだけ', () => {
    expect(mergeAnnouncements([], null).every(a => !a.roles)).toBe(true)
  })
  test('リリースノートの id は重複しない・日付は ISO', () => {
    const ids = RELEASE_NOTES.map(n => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const n of RELEASE_NOTES) expect(isNaN(new Date(n.publishedAt).getTime())).toBe(false)
  })
})

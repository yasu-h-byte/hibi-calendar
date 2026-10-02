/**
 * 右パネルの「未保存の変更があるときだけ閉じる前に確かめる」（2026-10-02 総合点検）
 * confirmDiscard は SidePanel の Esc・背景クリックと、画面側の「閉じる」「×」が共通で通す関数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { confirmDiscard, DISCARD_MESSAGE } from '@/lib/hooks/discardGuard'

describe('confirmDiscard', () => {
  const confirm = vi.fn()
  beforeEach(() => { (globalThis as unknown as { window: unknown }).window = { confirm } ; confirm.mockReset() })
  afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window })

  it('変更が無ければ確かめずに閉じてよい', () => {
    expect(confirmDiscard(false)).toBe(true)
    expect(confirmDiscard(undefined)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('変更があれば確かめ、OK のときだけ閉じる', () => {
    confirm.mockReturnValueOnce(false)
    expect(confirmDiscard(true)).toBe(false)
    confirm.mockReturnValueOnce(true)
    expect(confirmDiscard(true)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(DISCARD_MESSAGE)
  })
})

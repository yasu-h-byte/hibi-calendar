import { describe, it, expect } from 'vitest'
import { planHomeLeaveDay } from '@/lib/home-leave-sync'
import type { AttendanceEntry } from '@/types'

/**
 * 帰国フラグ(hk)同期の判定ロジック
 *
 * 回帰対象: グエン タイン フウ事案（2026-08-03）
 *   7/24〜12/1 で承認 → hk 書込 → 開始日を 9/1 に変更したが出面が同期されず、
 *   7/30・7/31 と8月まるごとに帰国フラグが残り「7/30から帰国中」と表示された。
 *   期間外になった日を確実に消せること、実績を消さないことがこのテストの主眼。
 */
describe('planHomeLeaveDay', () => {
  const e = (v: Partial<AttendanceEntry>) => v as AttendanceEntry

  describe('帰国期間内の日', () => {
    it('エントリが無ければ hk を立てる', () => {
      expect(planHomeLeaveDay(undefined, true)).toBe('write')
    })

    it('既に hk があれば何もしない（冪等）', () => {
      expect(planHomeLeaveDay(e({ hk: 1, w: 0 }), true)).toBe('noop')
    })

    it('出勤実績がある日は触らない', () => {
      expect(planHomeLeaveDay(e({ w: 1, o: 1 }), true)).toBe('skip')
    })

    it('有給が入っている日は触らない', () => {
      expect(planHomeLeaveDay(e({ p: 1, w: 0 }), true)).toBe('skip')
    })

    it('休み・現場休・試験も実績として扱い触らない', () => {
      expect(planHomeLeaveDay(e({ r: 1, w: 0 }), true)).toBe('skip')
      expect(planHomeLeaveDay(e({ h: 1, w: 0 }), true)).toBe('skip')
      expect(planHomeLeaveDay(e({ exam: 1, w: 0 }), true)).toBe('skip')
    })
  })

  describe('帰国期間外の日（残骸の掃除）', () => {
    it('帰国フラグだけの空エントリはエントリごと消す', () => {
      // 承認時に書かれる実体がこれ。w:0 だけ残すと「0出勤」の残骸になるため丸ごと消す
      expect(planHomeLeaveDay(e({ hk: 1, w: 0 }), false)).toBe('clear-entry')
    })

    it('入力元(s)が付いていてもフラグだけの空エントリなら丸ごと消す', () => {
      expect(planHomeLeaveDay(e({ hk: 1, w: 0, s: 'admin' }), false)).toBe('clear-entry')
    })

    it('実績が混ざっている日は hk フィールドだけ落とす', () => {
      expect(planHomeLeaveDay(e({ hk: 1, w: 1, o: 1 }), false)).toBe('clear-field')
      expect(planHomeLeaveDay(e({ hk: 1, p: 1, w: 0 }), false)).toBe('clear-field')
    })

    it('hk が無ければ何もしない', () => {
      expect(planHomeLeaveDay(undefined, false)).toBe('noop')
      expect(planHomeLeaveDay(e({ w: 1 }), false)).toBe('noop')
    })
  })

  describe('フウ事案の再現', () => {
    // 旧期間 7/24〜12/1 → 新期間 9/1〜12/1 に変更した後の、7月末の各日の判定
    it('7/30・7/31（期間外になったフラグのみの日）は消える', () => {
      expect(planHomeLeaveDay(e({ hk: 1, w: 0 }), false)).toBe('clear-entry')
    })

    it('7/29（実出勤で上書き済み）は元から hk が無く影響を受けない', () => {
      expect(planHomeLeaveDay(e({ w: 1, o: 1, st: '07:30', et: '16:30' }), false)).toBe('noop')
    })

    it('9/1 以降（新期間内）は hk が立つ', () => {
      expect(planHomeLeaveDay(undefined, true)).toBe('write')
    })
  })
})

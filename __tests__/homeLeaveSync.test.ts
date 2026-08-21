import { describe, it, expect } from 'vitest'
import { planHomeLeaveDay, isHomeLeaveConflictDay } from '@/lib/home-leave-sync'
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

/**
 * 帰国期間内の出勤打刻の検出（2026-08-20 追加）
 *
 * 回帰対象: ファン(103) / フン(104) 事案
 *   帰国申請の「終了日」に復帰日を入れる入力ミスが繰り返し起きた。
 *   システムは終了日を帰国期間に含めるため、復帰日を入れると1日ぶん多く帰国扱いになり、
 *   給与の日割りが過少になる。
 *     - ファン: 終了日7/8 なのに 7/8 から出勤打刻 → 帰国8日（正しくは7日）
 *     - フン:  終了日7/18 なのに 7/14 から出勤打刻 → 帰国18日（正しくは13日）
 *              基本給が 63,888円 過少だった
 *   出面の打刻は本人が入れた事実なので、期間と矛盾したら保存前に止める。
 */
describe('isHomeLeaveConflictDay', () => {
  const e = (v: Partial<AttendanceEntry>) => v as AttendanceEntry
  const RANGE = { start: '2026-03-28', end: '2026-07-08' }
  const hit = (entry: AttendanceEntry | undefined, date: string) =>
    isHomeLeaveConflictDay(entry, date, RANGE.start, RANGE.end)

  it('ファン事案: 終了日当日に出勤打刻があれば矛盾として検出する', () => {
    expect(hit(e({ w: 1, st: '06:30', et: '16:30', o: 1.5 }), '2026-07-08')).toBe(true)
  })

  it('期間の途中に出勤打刻があっても検出する（フン事案: 復帰後4日ぶん）', () => {
    expect(hit(e({ w: 1, st: '07:30', et: '16:30' }), '2026-07-01')).toBe(true)
  })

  it('期間外の出勤打刻は検出しない（正常な復帰後の勤務）', () => {
    expect(hit(e({ w: 1, st: '06:30', et: '16:30' }), '2026-07-09')).toBe(false)
    expect(hit(e({ w: 1 }), '2026-03-27')).toBe(false)
  })

  it('帰国フラグだけの日は矛盾ではない（正常な帰国中）', () => {
    expect(hit(e({ hk: 1, w: 0 }), '2026-07-01')).toBe(false)
  })

  it('有給・欠勤・現場休は帰国中でも正当なので検出しない', () => {
    expect(hit(e({ p: 1, w: 0 }), '2026-07-01')).toBe(false)
    expect(hit(e({ r: 1, w: 0 }), '2026-07-01')).toBe(false)
    expect(hit(e({ h: 1, w: 0 }), '2026-07-01')).toBe(false)
  })

  it('半日出勤・補償日も出勤扱いなので検出する（人が確認すべき）', () => {
    expect(hit(e({ w: 0.5 }), '2026-07-01')).toBe(true)
    expect(hit(e({ w: 0.6 }), '2026-07-01')).toBe(true)
  })

  it('エントリが無い日は検出しない', () => {
    expect(hit(undefined, '2026-07-01')).toBe(false)
  })

  it('境界: 開始日当日の出勤も検出する', () => {
    expect(hit(e({ w: 1 }), '2026-03-28')).toBe(true)
  })
})

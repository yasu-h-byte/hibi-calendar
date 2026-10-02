/**
 * getEntryStatus（出面1件の状態）の全入力値の表（2026-10-02 総合点検）
 *
 * 半日（w=0.5）が 'none'（未入力）に落ちていた。職長の一覧・まとめ承認・本人のスマホの督促・
 * 別現場の入力の索引がこの関数で「入力済みか」を決めるので、ここで表として固定する。
 */
import { describe, test, expect } from 'vitest'
import { getEntryStatus } from '@/lib/attendance'
import type { AttendanceEntry } from '@/types'

const cases: [string, AttendanceEntry | null | undefined, ReturnType<typeof getEntryStatus>][] = [
  ['無し', null, 'none'],
  ['undefined', undefined, 'none'],
  ['残骸だけ（w:0）', { w: 0 }, 'none'],
  ['出勤 1日', { w: 1, s: 'staff' }, 'work'],
  ['出勤 1日＋残業', { w: 1, o: 1.5 }, 'overtime'],
  ['半日 0.5', { w: 0.5 }, 'work'],
  ['半日 0.5＋残業', { w: 0.5, o: 1 }, 'overtime'],
  ['時刻つき出勤（o なし）', { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 }, 'work'],
  ['0.6補（会社都合の休み）', { w: 0.6 }, 'comp'],
  ['0.6補に残業の残骸', { w: 0.6, o: 2 }, 'comp'],
  ['夜勤のみ', { w: 1, ns: 1, nonly: 1, nst: '22:00', net: '29:00' }, 'work'],
  ['日勤＋夜勤', { w: 1, ns: 1, nst: '22:00', net: '29:00' }, 'work'],
  ['有給', { w: 0, p: 1 }, 'leave'],
  ['有給に出勤の残骸', { w: 1, p: 1, o: 3 }, 'leave'],
  ['試験', { w: 0, exam: 1 }, 'exam'],
  ['欠勤', { w: 0, r: 1, rReason: 'sick' }, 'rest'],
  ['現場休み（h）', { w: 0, h: 1 }, 'site_off'],
  ['帰国中', { w: 0, hk: 1 }, 'home_leave'],
  ['帰国中に休み（休みを優先して見せる）', { w: 0, hk: 1, r: 1 }, 'rest'],
]

describe('getEntryStatus の全入力値の表', () => {
  test.each(cases)('%s', (_label, entry, expected) => {
    expect(getEntryStatus(entry)).toBe(expected)
  })
  test('出勤（w>0・0.6 以外）はすべて入力済み（none ではない）', () => {
    for (const w of [0.5, 1, 1.5]) expect(getEntryStatus({ w })).not.toBe('none')
  })
})

import { describe, test, expect } from 'vitest'
import { overwriteConfirmMessage, needsOverwriteConfirm } from '@/lib/leave-overwrite'
import type { AttendanceEntry } from '@/types'

/**
 * 有給で上書きする前の確認の文（2026-10-24）
 *   旧: 「最終承認が済んでいます。休暇管理の申請一覧から内容を確認のうえ承認してください」だけで、
 *       休暇管理にいるのに休暇管理へ行けと言い、本人のその日が空欄か出勤かが分からなかった
 */
const final = { final: { by: 1 } }
const e = (x: Partial<AttendanceEntry>) => x as AttendanceEntry

describe('有給で上書きする前の確認の文', () => {
  test('最終承認済みで本人の出面が空欄 → 消える記録が無いことを書く・画面の移動は言わない', () => {
    const m = overwriteConfirmMessage('2026-10-20', 'ラン ヴァン グエン', null, final, '')
    expect(m).toContain('2026-10-20')
    expect(m).toContain('最終承認が済んでいます')
    expect(m).toContain('ラン ヴァン グエンさんのこの日の出面は空欄です')
    expect(m).toContain('消える記録はありません')
    expect(m).not.toContain('休暇管理')
  })

  test('出勤の入力がある → 時刻と残業を書き、出勤の記録が消えると書く', () => {
    const m = overwriteConfirmMessage('2026-10-20', 'A', e({ w: 1, st: '07:30', et: '16:30', o: 1 }), null, '')
    expect(m).toContain('出勤の入力があります（07:30〜16:30 残業1h）')
    expect(m).toContain('出勤の記録が消えます')
    expect(m).not.toContain('承認が済んでいます')
  })

  test('欠・0.6補・帰国中は、それぞれ何に変わるかを書く', () => {
    expect(overwriteConfirmMessage('2026-10-20', 'A', e({ w: 0, r: 1 }), final, '')).toContain('「欠」が有給に変わります')
    expect(overwriteConfirmMessage('2026-10-20', 'A', e({ w: 0.6 }), final, '')).toContain('0.6補が有給に変わります')
    expect(overwriteConfirmMessage('2026-10-20', 'A', e({ w: 0, hk: 1 }), final, '')).toContain('帰国中ではなく有給になります')
  })

  test('日付の変更では「変更先の」日と書く・職長承認だけの日', () => {
    const m = overwriteConfirmMessage('2026-10-21', 'A', null, { foreman: { by: 2 } }, '変更先の')
    expect(m).toContain('変更先のこの日は、現場の出面の職長承認が済んでいます')
  })
})

describe('確認の窓を出すか（2026-10-24 案A: 承認済みの日でも本人が空欄なら出さない）', () => {
  test('承認済みの日・本人は空欄 → 出さない', () => {
    expect(needsOverwriteConfirm(null, null, final)).toBe(false)
    expect(needsOverwriteConfirm(e({}), null, final)).toBe(false)
  })
  test('承認済みの日・本人に欠／0.6補／帰国 → 出す', () => {
    expect(needsOverwriteConfirm(e({ w: 0, r: 1 }), null, final)).toBe(true)
    expect(needsOverwriteConfirm(e({ w: 0.6 }), null, final)).toBe(true)
    expect(needsOverwriteConfirm(e({ w: 0, hk: 1 }), null, final)).toBe(true)
  })
  test('出勤の入力がある → 承認の有無にかかわらず出す', () => {
    const work = e({ w: 1, st: '07:30', et: '16:30' })
    expect(needsOverwriteConfirm(work, work, null)).toBe(true)
    expect(needsOverwriteConfirm(work, work, final)).toBe(true)
  })
  test('承認なし・空欄 → 出さない', () => {
    expect(needsOverwriteConfirm(null, null, null)).toBe(false)
  })
})

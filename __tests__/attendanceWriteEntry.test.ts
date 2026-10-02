/**
 * 出面を書く経路は共通の入口（lib/attendance-save.ts）を通す（2026-10-02 総合点検）
 *
 * - 純関数（実在する日・最終承認済みの日の扱い）の表
 * - 静的な確かめ: demmen/att_ の d を直接書く／setAttendanceEntry を直接呼ぶファイルは、ここに理由つきで並べたものだけ。
 *   新しい API を作って直接書くと落ちる（職長トークン画面の修正が履歴も確かめも無しに書けていた、の再発防止）
 */
import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { attendanceDateError, finalApprovedEditError, FINAL_APPROVED_EDIT_MESSAGE } from '@/lib/attendance-save'

describe('attendanceDateError（実在する日か）', () => {
  test.each([
    ['202609', 1, null], ['202609', 30, null], ['202602', 28, null], ['202802', 29, null],
    ['202609', 31, '日付が正しくありません'], ['202602', 29, '日付が正しくありません'],
    ['202609', 0, '日付が正しくありません'], ['202609', ' 5', '日付が正しくありません'], ['202609', '05', '日付が正しくありません'],
    ['202609', '+5', '日付が正しくありません'], ['202609', 1.5, '日付が正しくありません'],
    ['202613', 1, '月の指定が正しくありません'], ['2026-09', 1, '月の指定が正しくありません'], [undefined, 1, '月の指定が正しくありません'],
  ])('ym=%s day=%s → %s', (ym, day, expected) => {
    expect(attendanceDateError(ym, day)).toBe(expected)
  })
  test('数字の日と文字の日は同じ扱い', () => {
    expect(attendanceDateError('202609', '5')).toBeNull()
    expect(attendanceDateError('202609', 5)).toBeNull()
  })
})

describe('finalApprovedEditError（最終承認済みの日）', () => {
  test('最終承認済みは、さかのぼり・最終承認の権限がある人だけ', () => {
    expect(finalApprovedEditError({ foreman: true, final: true }, false)).toBe(FINAL_APPROVED_EDIT_MESSAGE)
    expect(finalApprovedEditError({ foreman: true, final: true }, true)).toBeNull()
  })
  test('職長承認だけの日は（この関数では）止めない', () => {
    expect(finalApprovedEditError({ foreman: true, final: false }, false)).toBeNull()
    expect(finalApprovedEditError({ foreman: false, final: false }, false)).toBeNull()
  })
})

describe('出面を書くファイルは共通の入口を通す', () => {
  const ROOT = path.join(__dirname, '..')
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) return files(p)
      return /\.tsx?$/.test(name) ? [p] : []
    })
  }
  /** 共通の入口そのもの */
  const ENTRY_FILES = ['lib/attendance.ts', 'lib/attendance-save.ts']
  /**
   * 直接書くことを認めているファイル（理由つき）。ここに足すときは、共通の入口を通せない理由を書くこと。
   * 2026-10-02 時点で lib/attendance-save.ts を通していない既存の経路（別の担当が直す・または性質上まとめ書き）
   */
  const ALLOWED: Record<string, string> = {
    'lib/home-leave-sync.ts': '帰国 hk の月まとめ reconcile（1か月を1回の updateDoc で・実績の日は触らない）',
    'app/api/home-leave/reconcile/route.ts': '帰国 hk の残骸の掃除（点検ツール・hk だけを消す）',
    'app/api/leave-request/route.ts': '有給の承認・日付変更（p の書き込み。2026-10-02 時点で未移行）',
    'app/api/leave/route.ts': '時季指定・管理者の手動 P（2026-10-02 時点で未移行）',
    'app/api/debug/repair-att-site/route.ts': '代表だけの保守ツール',
  }
  test('setAttendanceEntry の直接呼び出し・d.<key> への直接書き込みは、認めたファイルだけ', () => {
    const bad: string[] = []
    for (const f of [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'lib'))]) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/')
      if (ENTRY_FILES.includes(rel) || rel in ALLOWED) continue
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        if (line.includes('att-write-ok')) return
        if (/\bsetAttendanceEntry\(/.test(line) && !/import/.test(line)) bad.push(`${rel}:${i + 1} setAttendanceEntry を直接呼んでいる`)
        if (/\[`d\.\$\{/.test(line) || /`d\.\$\{[^`]*`\]\s*[:=]/.test(line)) bad.push(`${rel}:${i + 1} d.<key> を直接書いている`)
      })
    }
    expect(bad, '出面の保存は lib/attendance-save.ts（writeAttendanceEntry / moveAttendanceEntry）を通してください').toEqual([])
  })
  test('認めたファイルの一覧に、存在しないファイルを残さない', () => {
    for (const rel of Object.keys(ALLOWED)) expect(statSync(path.join(ROOT, rel)).isFile(), rel).toBe(true)
  })
})

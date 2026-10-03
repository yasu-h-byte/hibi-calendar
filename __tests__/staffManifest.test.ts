/**
 * 個人のリンクをホーム画面に追加したとき、その人のページが開く（lib/staff-manifest.ts・2026-10-02）
 */
import { describe, test, expect } from 'vitest'
import { buildStaffManifest, staffManifestMetadata, isStaffToken } from '@/lib/staff-manifest'

describe('staff manifest', () => {
  test('マイページは start_url がその人のマイページ（ログイン画面 / ではない）', () => {
    const m = buildStaffManifest('mypage', 'z9jz5kha')
    expect(m.start_url).toBe('/mypage/z9jz5kha')
    // scope は / （職長確認からマイページへのリンクなどをアプリ内で開く）
    expect(m.scope).toBe('/')
  })
  test('出面入力・職長確認も自分のページ', () => {
    expect(buildStaffManifest('attendance', 'abc12345').start_url).toBe('/attendance/abc12345')
    expect(buildStaffManifest('foreman', 'abc12345').start_url).toBe('/attendance/foreman/abc12345')
  })
  test('layout は /api/manifest を指す。おかしな token なら差し替えない', () => {
    expect(staffManifestMetadata('mypage', 'z9jz5kha').manifest).toBe('/api/manifest?kind=mypage&token=z9jz5kha')
    expect(staffManifestMetadata('mypage', '../x')).toEqual({})
    expect(isStaffToken('a/b')).toBe(false)
  })
})

describe('ホーム画面の名前（2026-10-03）', () => {
  it('short_name はどの画面も DEDURA＋（言葉に寄らない）。iPhone 用の title も同じ', () => {
    for (const kind of ['mypage', 'attendance', 'foreman'] as const) {
      const m = buildStaffManifest(kind, 'abcd1234')
      expect(m.short_name).toBe('DEDURA＋')
      expect(m.name.startsWith('DEDURA＋')).toBe(true)
      expect(staffManifestMetadata(kind, 'abcd1234').appleWebApp).toMatchObject({ title: 'DEDURA＋' })
    }
    expect(buildStaffManifest('attendance', 'abcd1234').name).toContain('Chấm công')
  })
})

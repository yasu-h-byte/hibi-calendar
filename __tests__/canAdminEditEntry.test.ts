/**
 * canAdminEditEntry のテスト (2026-06-XX 追加)
 *
 * 「ベトナム人スタッフ未入力時に admin/foreman が登録できるエントリ種別」の判定を検証。
 * 補償日 (w=0.6) を例外リストに追加した修正のリグレッション防止。
 */
import { describe, test, expect } from 'vitest'
import { canAdminEditEntry } from '@/lib/attendance'

describe('canAdminEditEntry - 日本人スタッフ', () => {
  test('日本人は常に編集可（既存なし・新規エントリどんな種別でも）', () => {
    const w = { visa: 'none' }
    expect(canAdminEditEntry(w, null, { w: 1 }).editable).toBe(true)
    expect(canAdminEditEntry(w, null, { w: 0, r: 1 }).editable).toBe(true)
    expect(canAdminEditEntry(w, null, null).editable).toBe(true)
    expect(canAdminEditEntry(w, { w: 1 }, { w: 0 }).editable).toBe(true)
  })
})

describe('canAdminEditEntry - ベトナム人スタッフ：既存エントリあり', () => {
  test('既存エントリがあれば任意の修正・削除が可能', () => {
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, { w: 1 }, { w: 0, r: 1 }).editable).toBe(true)
    expect(canAdminEditEntry(w, { w: 0, p: 1 }, { w: 1 }).editable).toBe(true)
    expect(canAdminEditEntry(w, { w: 1 }, { w: 0.6 }).editable).toBe(true)
    // 削除（newEntry が null/undefined）も既存があれば可能
    expect(canAdminEditEntry(w, { w: 1 }, null).editable).toBe(true)
  })
})

describe('canAdminEditEntry - ベトナム人スタッフ：既存エントリなし（事後申請性のみ許容）', () => {
  test('出勤 (w=1) は拒否される', () => {
    const w = { visa: 'tokutei1' }
    const result = canAdminEditEntry(w, null, { w: 1, o: 0, s: 'foreman' })
    expect(result.editable).toBe(false)
    expect(result.reason).toContain('スマホ入力待ち')
  })

  test('欠勤 (r=1, w=0) は許容される ← 2026-07-09 変更', () => {
    // 来なかった日を本人がスマホ入力することはないため、後付け記録が唯一の手段。
    // w=0 で賃金が増えず、ガードの趣旨（賃金操作防止）を損なわない。
    // 実例: アイン 2026-06-19 が未入力のまま最終承認され、後から欠勤に正す必要が生じた。
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, { w: 0, r: 1 }).editable).toBe(true)
  })

  test('欠勤フラグ付きでも w>0（出勤の実体）が入っていれば拒否される', () => {
    // r と w の同時指定（残骸パターン）で出勤を作る抜け道を防ぐ
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, { w: 1, r: 1 }).editable).toBe(false)
  })

  test('有給 (p=1) は許容される — 事後申請性', () => {
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, { w: 0, p: 1, s: 'foreman' }).editable).toBe(true)
  })

  test('帰国中 (hk=1) は許容される — 事後申請性', () => {
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, { w: 0, hk: 1 }).editable).toBe(true)
  })

  test('補償日 (w=0.6, 現場都合休み) は許容される ← 2026-06-XX 追加', () => {
    // この修正前は false 扱いで 403 になっていた
    // 過去ハマったケース: 政仁さん/職長が「今日は雨で休み」を代理入力できなかった
    const w = { visa: 'tokutei1' }
    const result = canAdminEditEntry(w, null, { w: 0.6, s: 'foreman' })
    expect(result.editable).toBe(true)
  })

  test('newEntry が null（新規ではなく削除試行）は拒否される', () => {
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, null).editable).toBe(false)
    expect(canAdminEditEntry(w, null, undefined).editable).toBe(false)
  })

  test('現場休み (h=1) は拒否される — 事後申請性ではない', () => {
    const w = { visa: 'tokutei1' }
    expect(canAdminEditEntry(w, null, { w: 0, h: 1 }).editable).toBe(false)
  })
})

describe('canAdminEditEntry - 各種ビザでベトナム人扱い', () => {
  test('技能実習 (ginou)', () => {
    expect(canAdminEditEntry({ visa: 'ginou' }, null, { w: 0.6 }).editable).toBe(true)
  })
  test('特定技能2号 (tokutei2)', () => {
    expect(canAdminEditEntry({ visa: 'tokutei2' }, null, { w: 0.6 }).editable).toBe(true)
  })
  test('技人国 (gijinkoku)', () => {
    expect(canAdminEditEntry({ visa: 'gijinkoku' }, null, { w: 0.6 }).editable).toBe(true)
  })
})

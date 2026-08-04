import { describe, it, expect } from 'vitest'
import { selectActiveGrantRecord } from '@/lib/leave-compute'

/**
 * 「その日に有効な付与レコード」の選択
 *
 * 回帰対象: グエン ミン トゥアン事案（2026-08-04）
 *   残数チェックが配列の最後のレコードを見ていたため、次期の付与レコード
 *   （2026-11-01付与・枠32日・消化0日）を基準にしてしまい、当期（2025-11-01付与・
 *   枠17日）を21日消化済みでも申請が通り続けた。
 */
describe('selectActiveGrantRecord', () => {
  const rec = (grantDate: string, grantDays = 17, extra = {}) =>
    ({ grantDate, grantDays, ...extra })

  it('未来の付与レコードを選ばない（本事案の再現）', () => {
    const records = [rec('2025-11-01'), rec('2026-11-01')]
    const active = selectActiveGrantRecord(records, '2026-08-04')
    expect(active?.grantDate).toBe('2025-11-01')
  })

  it('配列の順序が逆でも付与日で正しく選ぶ', () => {
    const records = [rec('2026-11-01'), rec('2025-11-01')]
    expect(selectActiveGrantRecord(records, '2026-08-04')?.grantDate).toBe('2025-11-01')
  })

  it('付与日が到来していれば当日から有効', () => {
    const records = [rec('2025-11-01'), rec('2026-11-01')]
    expect(selectActiveGrantRecord(records, '2026-11-01')?.grantDate).toBe('2026-11-01')
    expect(selectActiveGrantRecord(records, '2026-10-31')?.grantDate).toBe('2025-11-01')
  })

  it('過去に複数あるときは最も新しいものを選ぶ', () => {
    const records = [rec('2023-11-01'), rec('2024-11-01'), rec('2025-11-01')]
    expect(selectActiveGrantRecord(records, '2026-08-04')?.grantDate).toBe('2025-11-01')
  })

  it('すべて未来なら null（＝まだ付与されていない）', () => {
    expect(selectActiveGrantRecord([rec('2027-01-01')], '2026-08-04')).toBeNull()
  })

  it('archived と付与0日のレコードは対象外', () => {
    const records = [
      rec('2025-11-01', 17, { _archived: true }),
      rec('2025-05-01', 0),
      rec('2024-11-01', 14),
    ]
    expect(selectActiveGrantRecord(records, '2026-08-04')?.grantDate).toBe('2024-11-01')
  })

  it('レコードが空なら null', () => {
    expect(selectActiveGrantRecord([], '2026-08-04')).toBeNull()
  })

  it('旧フィールド grant にも対応する', () => {
    const records = [{ grantDate: '2025-11-01', grant: 17 }]
    expect(selectActiveGrantRecord(records, '2026-08-04')?.grantDate).toBe('2025-11-01')
  })
})

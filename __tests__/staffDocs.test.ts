import { describe, test, expect } from 'vitest'
import {
  safeFileName, isValidIsoDate, daysUntil, expiryState, masterMismatches, missingRequiredTypes, staffDocTypeDef,
} from '@/lib/staff-docs'
import { CAPABILITIES } from '@/lib/permissions'

/** 書類庫（2026-09-28 第1段階） */
describe('書類庫の共通ロジック', () => {
  test('ファイル名: パス区切り・制御文字を除き、日本語は残す', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\scan\\在留カード 表.pdf')).toBe('在留カード 表.pdf')
    expect(safeFileName('a#b?c[1]*.pdf')).toBe('abc1.pdf')
    expect(safeFileName('')).toBe('file')
    // Mac の分解された濁点（NFD）は NFC にそろえる
    expect(safeFileName('在留カート\u3099.pdf')).toBe('在留カード.pdf')
  })

  test('日付の妥当性（13月などは不正）', () => {
    expect(isValidIsoDate('2029-11-02')).toBe(true)
    expect(isValidIsoDate('2026-13-09')).toBe(false)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('2026/11/02')).toBe(false)
  })

  test('期限の状態: 切れ／90日以内／それ以外／なし', () => {
    const today = '2026-09-28'
    expect(daysUntil('2026-09-28', today)).toBe(0)
    expect(expiryState('2026-09-27', today)).toBe('expired')
    expect(expiryState('2026-12-27', today)).toBe('soon')      // 90日後
    expect(expiryState('2026-12-28', today)).toBe('ok')        // 91日後
    expect(expiryState(undefined, today)).toBe('none')
  })

  test('人員マスタとの食い違い: 最新の在留カードの期限だけを見る', () => {
    const docs = [
      { type: 'residence_card' as const, status: 'old' as const, expiresOn: '2026-11-02' },
      { type: 'residence_card' as const, status: 'current' as const, expiresOn: '2029-11-02' },
    ]
    expect(masterMismatches({ visaExpiry: '2026-11-02' }, docs)).toEqual(['在留期限: 在留カード 2029-11-02 ／ 人員マスタ 2026-11-02'])
    expect(masterMismatches({ visaExpiry: '2029-11-02' }, docs)).toEqual([])
    expect(masterMismatches({}, docs)[0]).toContain('未登録')
  })

  test('不足書類: 旧版しかない種類は不足扱い', () => {
    expect(missingRequiredTypes([
      { type: 'residence_card', status: 'current' },
      { type: 'contract', status: 'old' },
    ])).toEqual(['contract'])
  })

  test('ファイル名から種類を推し量る（フォンの契約書が在留カードで登録された件）', async () => {
    const { inferDocType } = await import('@/lib/staff-docs')
    expect(inferDocType('雇用契約書及び雇用条件書_NGUYEN HUU PHONG.pdf')).toBe('contract')
    expect(inferDocType('在留カード_NGUYEN THANH HOANG.pdf')).toBe('residence_card')
    expect(inferDocType('在留カート\u3099_表.jpg')).toBe('residence_card')   // Mac の NFD
    // パスポートは扱わない（2026-09-28）
    expect(inferDocType('passport_scan.pdf')).toBeNull()
    expect(inferDocType('scan_0012.pdf')).toBeNull()
  })

  test('知らない種類は「その他」', () => {
    expect(staffDocTypeDef('xxx').key).toBe('other')
  })

  test('権限: 見られるのは 事務・事業責任者・代表だけ。削除は代表だけ', () => {
    expect([...CAPABILITIES['staffDocs.view'].roles].sort()).toEqual(['approver', 'jimu', 'owner'])
    expect(CAPABILITIES['staffDocs.view'].roles).not.toContain('foreman')
    expect(CAPABILITIES['staffDocs.view'].roles).not.toContain('officer')
    expect(CAPABILITIES['staffDocs.delete'].roles).toEqual(['owner'])
  })
})

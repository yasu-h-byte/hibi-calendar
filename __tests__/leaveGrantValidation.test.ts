import { describe, it, expect } from 'vitest'
import { validateGrantInput, calcLegalPL } from '@/lib/leave-compute'

/**
 * 付与・編集の入力値バリデーション
 *
 * 背景（2026-08-04 有給システム総点検）:
 *   手動付与と編集が grantDays / carryOver を無制限に受け付けており、
 *   法定超の付与も、繰越の法定上限（前期付与分＝労基法115条FIFO）超も素通りだった。
 *   トゥアン事案の「繰越15日」誤入力（正しくは0日）を止められなかった直接の穴。
 */
describe('validateGrantInput', () => {
  const ok = (r: ReturnType<typeof validateGrantInput>) => expect(r.ok).toBe(true)
  const ng = (r: ReturnType<typeof validateGrantInput>) => {
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  }

  describe('付与日数', () => {
    it('法定最大20日を超える付与を拒否', () => {
      ng(validateGrantInput({ grantDays: 21 }))
      ok(validateGrantInput({ grantDays: 20 }))
    })

    it('負数・NaN を拒否', () => {
      ng(validateGrantInput({ grantDays: -1 }))
      ng(validateGrantInput({ grantDays: NaN }))
    })

    it('勤続年数に対して法定を超える付与を拒否', () => {
      // 入社 2023-10-23 → 2025-04-23 時点は勤続1.5年 → 法定11日
      expect(calcLegalPL('2023-10-23', '2025-04-23')).toBe(11)
      ng(validateGrantInput({ grantDays: 12, hireDate: '2023-10-23', grantDate: '2025-04-23' }))
      ok(validateGrantInput({ grantDays: 11, hireDate: '2023-10-23', grantDate: '2025-04-23' }))
    })

    it('法定未満の付与は許容する（移行データの実態を壊さない）', () => {
      // トゥアン: 勤続8年で法定20日だが、移行の経緯で17日 → 編集を許容
      ok(validateGrantInput({ grantDays: 17, hireDate: '2017-10-01', grantDate: '2025-11-01' }))
    })

    it('入社6ヶ月未満への付与を拒否（前倒し誤操作の防止）', () => {
      ng(validateGrantInput({ grantDays: 10, hireDate: '2026-08-01', grantDate: '2026-09-01' }))
    })

    it('hireDate 無しなら法定チェックはスキップ（上限20のみ）', () => {
      ok(validateGrantInput({ grantDays: 20, grantDate: '2026-10-01' }))
    })
  })

  describe('繰越', () => {
    it('前期付与分を超える繰越を拒否（トゥアン事案の再現: 前期17日に繰越15日は可、18日は不可）', () => {
      // 15 <= 17 なので形式上は通る（値の妥当性は消化ベースの自動計算が担う）
      ok(validateGrantInput({ grantDays: 17, carryOver: 15, prevGrant: 17 }))
      ng(validateGrantInput({ grantDays: 17, carryOver: 18, prevGrant: 17 }))
    })

    it('繰越20日超を拒否', () => {
      ng(validateGrantInput({ grantDays: 20, carryOver: 21, prevGrant: 20 }))
    })

    it('初回付与（前期なし）への繰越を拒否', () => {
      ng(validateGrantInput({ grantDays: 10, carryOver: 5, prevGrant: null }))
      ok(validateGrantInput({ grantDays: 10, carryOver: 0, prevGrant: null }))
    })

    it('日本人（期末買取制）の繰越を拒否', () => {
      ng(validateGrantInput({ grantDays: 20, carryOver: 3, prevGrant: 20, isJapanese: true }))
      ok(validateGrantInput({ grantDays: 20, carryOver: 0, prevGrant: 20, isJapanese: true }))
    })

    it('carryOver 未指定（自動計算）は検証しない', () => {
      ok(validateGrantInput({ grantDays: 17, prevGrant: 17 }))
    })
  })
})

import { describe, it, expect } from 'vitest'
import { isToolBudgetEligible } from '@/lib/workers'

/**
 * 道具代管理の対象者判定（2026-08-28 に日本人へ拡大）
 *
 * 外国人（技能実習・特定技能）に加えて、日本人の現場スタッフ
 * （役員・事務を除く）も対象。退職済みは除外。
 */
describe('isToolBudgetEligible', () => {
  it('技能実習・特定技能は対象', () => {
    expect(isToolBudgetEligible({ visa: 'jisshu1' })).toBe(true)
    expect(isToolBudgetEligible({ visa: 'jisshu3' })).toBe(true)
    expect(isToolBudgetEligible({ visa: 'tokutei1' })).toBe(true)
    expect(isToolBudgetEligible({ visa: 'tokutei' })).toBe(true)
  })

  it('日本人の現場職（とび・職長・土工）は対象', () => {
    expect(isToolBudgetEligible({ visa: 'none', job: 'tobi' })).toBe(true)
    expect(isToolBudgetEligible({ visa: 'none', job: 'shokucho' })).toBe(true)
    expect(isToolBudgetEligible({ job: 'doko' })).toBe(true)       // visa 未設定も日本人扱い
    expect(isToolBudgetEligible({ visa: '', job: 'tobi' })).toBe(true)
  })

  it('日本人でも役員・事務は対象外', () => {
    expect(isToolBudgetEligible({ visa: 'none', job: 'yakuin' })).toBe(false)
    expect(isToolBudgetEligible({ visa: 'none', job: 'jimu' })).toBe(false)
  })

  it('退職済みは対象外・退職予定（未来日）は在職中扱い', () => {
    expect(isToolBudgetEligible({ visa: 'jisshu1', retired: '2020-01-01' })).toBe(false)
    expect(isToolBudgetEligible({ visa: 'none', job: 'tobi', retired: '2020-01-01' })).toBe(false)
    expect(isToolBudgetEligible({ visa: 'jisshu1', retired: '2999-12-31' })).toBe(true)
  })

  it('未知の visa 値は対象外', () => {
    expect(isToolBudgetEligible({ visa: 'other', job: 'tobi' })).toBe(false)
  })
})

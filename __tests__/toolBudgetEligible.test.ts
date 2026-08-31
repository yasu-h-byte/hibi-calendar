import { describe, it, expect } from 'vitest'
import { isToolBudgetEligible, toolBudgetDefaultFor } from '@/lib/workers'

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

  // 2026-08-31 代表決定: 日本人は入社6ヶ月未満は対象外（有給の初回付与と同じタイミング）
  it('日本人は入社6ヶ月未満なら対象外・6ヶ月経てば対象', () => {
    const w = { visa: 'none', job: 'tobi', hireDate: '2026-06-01' }
    expect(isToolBudgetEligible(w, '2026-11-30')).toBe(false)  // 5ヶ月29日
    expect(isToolBudgetEligible(w, '2026-12-01')).toBe(true)   // ちょうど6ヶ月
    expect(isToolBudgetEligible(w, '2027-03-01')).toBe(true)
  })

  it('入社日が未登録の日本人は対象に含める（判定できないため従来どおり）', () => {
    expect(isToolBudgetEligible({ visa: 'none', job: 'tobi' }, '2026-08-31')).toBe(true)
  })

  it('外国人は6ヶ月ルールの対象外（従来どおり）', () => {
    expect(isToolBudgetEligible({ visa: 'jisshu1', hireDate: '2026-08-01' }, '2026-08-31')).toBe(true)
  })
})

describe('toolBudgetDefaultFor', () => {
  const cfg = {
    defaultBudget: 30000,
    budgetByVisa: { jisshu: 20000, tokutei1: 25000 },
    budgetByJob: { tobi: 50000, shokucho: 60000 },
  }
  it('外国人: visa完全一致 > 区分まとめ(jisshu/tokutei) > 既定額', () => {
    expect(toolBudgetDefaultFor({ visa: 'tokutei1' }, cfg)).toBe(25000)  // 完全一致
    expect(toolBudgetDefaultFor({ visa: 'jisshu2' }, cfg)).toBe(20000)   // まとめキー
    expect(toolBudgetDefaultFor({ visa: 'tokutei2' }, cfg)).toBe(30000)  // どちらも無し → 既定額
  })
  it('日本人: 職種別 > 既定額', () => {
    expect(toolBudgetDefaultFor({ visa: 'none', job: 'tobi' }, cfg)).toBe(50000)
    expect(toolBudgetDefaultFor({ visa: 'none', job: 'shokucho' }, cfg)).toBe(60000)
    expect(toolBudgetDefaultFor({ visa: 'none', job: 'doko' }, cfg)).toBe(30000)
    expect(toolBudgetDefaultFor({ job: 'tobi' }, cfg)).toBe(50000)  // visa 未設定も日本人扱い
  })
  it('設定が空なら既定額（無指定は30000）', () => {
    expect(toolBudgetDefaultFor({ visa: 'jisshu1' }, {})).toBe(30000)
    expect(toolBudgetDefaultFor({ visa: 'none', job: 'tobi' }, { defaultBudget: 40000 })).toBe(40000)
  })
})

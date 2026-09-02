import { describe, it, expect } from 'vitest'
import { isCalendarSignTarget } from '@/lib/workers'

/**
 * 就業カレンダー署名対象の判定（2026-09-02 の回帰対策）
 *
 * 署名は「1ヶ月単位の変形労働時間制」の周知・同意なので、対象は外国人スタッフのみ。
 * 2026-08 に日本人へマイページ用トークンを発行したところ、`!!w.token` だけで
 * 判定していた通知・公開ページ・現場別ページが日本人9名を「未署名」に数えた。
 * 同じ事故を繰り返さないよう、述語の条件をここで固定する。
 */
const NO_HL = new Set<number>()

describe('isCalendarSignTarget', () => {
  it('トークンを持つ外国人は対象', () => {
    expect(isCalendarSignTarget({ id: 102, visa: 'jisshu2', token: 'abc' }, '202609', NO_HL)).toBe(true)
    expect(isCalendarSignTarget({ id: 201, visa: 'tokutei1', token: 'abc' }, '2026-09', NO_HL)).toBe(true)
  })

  it('日本人はトークンを持っていても対象外（マイページ用トークンで混入しない）', () => {
    expect(isCalendarSignTarget({ id: 2, visa: 'none', token: 'abc' }, '202609', NO_HL)).toBe(false)
    expect(isCalendarSignTarget({ id: 3, visa: '', token: 'abc' }, '202609', NO_HL)).toBe(false)
    expect(isCalendarSignTarget({ id: 4, token: 'abc' }, '202609', NO_HL)).toBe(false)
  })

  it('Worker 型の visaType でも同じ判定になる（raw の visa と両対応）', () => {
    expect(isCalendarSignTarget({ id: 102, visaType: 'jisshu2', token: 'abc' }, '202609', NO_HL)).toBe(true)
    expect(isCalendarSignTarget({ id: 2, visaType: 'none', token: 'abc' }, '202609', NO_HL)).toBe(false)
  })

  it('トークン未発行は対象外（署名できないため）', () => {
    expect(isCalendarSignTarget({ id: 102, visa: 'jisshu2', token: '' }, '202609', NO_HL)).toBe(false)
    expect(isCalendarSignTarget({ id: 102, visa: 'jisshu2' }, '202609', NO_HL)).toBe(false)
  })

  it('当該月より前に退職済みなら対象外・退職月までは対象', () => {
    const w = { id: 105, visa: 'tokutei1', token: 'abc', retired: '2026-08-31' }
    expect(isCalendarSignTarget(w, '202609', NO_HL)).toBe(false)
    expect(isCalendarSignTarget(w, '202608', NO_HL)).toBe(true)
  })

  it('当該月まるごと帰国中は対象外', () => {
    const w = { id: 101, visa: 'tokutei2', token: 'abc' }
    expect(isCalendarSignTarget(w, '202609', new Set([101]))).toBe(false)
    expect(isCalendarSignTarget(w, '202609', new Set([999]))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { bonusTargets, PROFIT_SHARE_ONLY } from '@/lib/bonus-members.server'
import { bonusPoints } from '@/lib/jp-wage'

// 賞与の対象者（2026-10-23 代表決定: 特定技能のフウ・トゥアンは利益分配のみ・2G相当）
describe('bonusTargets', () => {
  const today = '2026-10-23'
  const workers = [
    { id: 2, visaType: 'none', jobType: 'shokucho', jpGrade: '6G' },
    { id: 1, visaType: 'none', jobType: 'yakuin', jpGrade: '' },
    { id: 9, visaType: 'none', jobType: 'jimu', jpGrade: '1G' },
    { id: 10, visaType: 'none', jobType: 'tobi' },                       // 等級なし → 対象外
    { id: 101, visaType: 'tokutei2', jobType: 'tobi' },
    { id: 102, visaType: 'tokutei2', jobType: 'tobi' },
    { id: 103, visaType: 'tokutei1', jobType: 'tobi' },                  // 決まっていない外国籍の人 → 対象外
    { id: 201, visaType: 'jisshu3', jobType: 'tobi', jpGrade: '3G' },    // 等級が入っていても外国籍は対象外
    { id: 8, visaType: 'none', jobType: 'tobi', jpGrade: '3G', retired: '2026-02-28' },
    { id: 11, visaType: 'none', jobType: 'tobi', jpGrade: '2G', retired: '2026-12-31' }, // 退職予定は残す
  ]

  it('日本人の号俸制の人と、利益分配だけの人を返す', () => {
    const t = bonusTargets(workers, today)
    expect(t.map(x => x.w.id).sort((a, b) => a - b)).toEqual([2, 11, 101, 102])
    expect(t.find(x => x.w.id === 2)).toMatchObject({ grade: '6G', profitShareOnly: false })
    expect(t.find(x => x.w.id === 101)).toMatchObject({ grade: '2G', profitShareOnly: true })
    expect(t.find(x => x.w.id === 102)).toMatchObject({ grade: '2G', profitShareOnly: true })
  })

  it('利益分配だけの人が退職したら外す', () => {
    const t = bonusTargets([{ id: 101, visaType: 'tokutei2', jobType: 'tobi', retired: '2026-09-30' }], today)
    expect(t).toEqual([])
  })

  it('フウ・トゥアンは 2G 相当（A 評価で 140 点）', () => {
    expect(PROFIT_SHARE_ONLY[101].grade).toBe('2G')
    expect(PROFIT_SHARE_ONLY[102].grade).toBe('2G')
    expect(bonusPoints('2G', 'A')).toBe(140)
  })
})

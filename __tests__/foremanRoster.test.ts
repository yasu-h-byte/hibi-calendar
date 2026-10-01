import { describe, test, expect } from 'vitest'
import { siteRosterFromMain, evaluateSiteDay } from '@/lib/foreman-todo'
import type { MainData } from '@/lib/compute'

// 2026-10-01 マイページの一覧・職長画面の俯瞰・まとめ承認で名簿とそろい具合の決まりを1つにした

const main = {
  sites: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  workers: [
    { id: 101, name: 'X', visa: 'tokutei1' },
    { id: 102, name: 'Y', visa: 'tokutei1' },
    { id: 103, name: 'Z', visa: 'jisshu1' },
    { id: 104, name: 'W', visa: 'tokutei1' },
    { id: 1, name: '日本人', visa: 'none' },
  ],
  // 既定配置は古いまま（104 は移動済み）
  assign: { a: { workers: [101, 102, 104, 1] } },
  massign: { a_202609: { workers: [101, 102, 103, 1] } },
} as unknown as MainData

describe('siteRosterFromMain（名簿の決まり）', () => {
  test('当月の月別配置がなければ前月の月別配置をさかのぼる（既定配置へいきなり戻らない）', () => {
    expect(siteRosterFromMain(main, 'a', '202610').workers.map(w => w.id)).toEqual([101, 102, 103])
  })
  test('月別配置が1つも無い月は既定配置・在留資格なしは除く', () => {
    expect(siteRosterFromMain(main, 'a', '202508').workers.map(w => w.id)).toEqual([101, 102, 104])
  })
})

describe('evaluateSiteDay（そろい具合）', () => {
  const workers = [{ id: 101, name: 'X' }, { id: 102, name: 'Y' }, { id: 103, name: 'Z' }]
  const att = {
    a_101_202609_6: { w: 1 },
    a_102_202609_6: { w: 1 },
    b_103_202609_7: { w: 1 },
    a_101_202609_7: { w: 1 },
  } as never
  test('非稼働日は入力した人だけが対象（一部だけ出勤した日曜も入力がそろえば承認できる）', () => {
    const ev = evaluateSiteDay(att, ['a'], workers, '202609', 6, false)
    expect(ev).toMatchObject({ entered: 2, total: 2, missingNames: [] })
  })
  test('稼働日は配置の全員が対象（入力が無い人は未入力）', () => {
    const ev = evaluateSiteDay(att, ['a'], workers, '202609', 6, true)
    expect(ev).toMatchObject({ entered: 2, total: 3, missingNames: ['Z'] })
  })
  test('別の現場で入力している人は対象から外す', () => {
    const ev = evaluateSiteDay(att, ['a'], workers, '202609', 7, true)
    expect(ev.total).toBe(2)
    expect(ev.missingNames).toEqual(['Y'])
    expect(ev.elsewhere.map(e => e.name)).toEqual(['Z'])
  })
  test('非稼働日に誰も入力が無ければ対象0人（一覧に出ない）', () => {
    expect(evaluateSiteDay(att, ['a'], workers, '202609', 13, false)).toMatchObject({ entered: 0, total: 0, missingNames: [] })
  })
})

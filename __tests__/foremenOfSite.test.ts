import { describe, test, expect } from 'vitest'
import { foremenOfSiteForMonth } from '@/lib/auth'

// 承認の権限判定（出面・有給・帰国申請）で共通の「その月の現場の職長」（2026-10-01 一本化）
describe('foremenOfSiteForMonth', () => {
  const site = { id: 's1', foreman: 2 }
  test('月別職長が無ければ現場の職長', () => {
    expect(foremenOfSiteForMonth(site, {}, '202610')).toEqual([2])
  })
  test('月別職長（foreman）があればその人だけ（旧職長は外れる）', () => {
    expect(foremenOfSiteForMonth(site, { s1_202610: { foreman: 3 } }, '202610')).toEqual([3])
  })
  test('古い書き込み形式（wid）も読む', () => {
    expect(foremenOfSiteForMonth(site, { s1_202610: { wid: 6 } }, '202610')).toEqual([6])
  })
  test('別の月の月別職長は効かない・YYYY-MM でも同じ', () => {
    expect(foremenOfSiteForMonth(site, { s1_202609: { foreman: 3 } }, '2026-10')).toEqual([2])
  })
  test('職長未設定の現場は空', () => {
    expect(foremenOfSiteForMonth({ id: 's2' }, {}, '202610')).toEqual([])
  })
})

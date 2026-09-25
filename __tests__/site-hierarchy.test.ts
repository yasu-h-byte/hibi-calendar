import { describe, test, expect } from 'vitest'
import {
  parentAndWorkTypeSiteIds, findWorkTypeDuplicates,
  isWorkTypeSite, siteDisplayName, workTypeSitesOf,
} from '@/lib/site-hierarchy'

/** 工種サイト（親現場の下の「鉄骨」「仮設」など）の重複検出（2026-09-25） */

const sites = [
  { id: 'kawasaki', name: '川崎', archived: false },
  { id: 'kawasaki_tekkotsu', name: '鉄骨工事', parentId: 'kawasaki', workType: '鉄骨', archived: false },
  { id: 'kawasaki_kasetsu', name: '仮設工事', parentId: 'kawasaki', workType: '仮設', archived: false },
  { id: 'idemitsu', name: '出光', archived: false },
]

function attKey(siteId: string, entryId: string | number, ym: string, day: number): string {
  return `${siteId}_${entryId}_${ym}_${day}`
}

describe('parentAndWorkTypeSiteIds', () => {
  test('親 id を先頭に、工種サイトの id を続ける', () => {
    expect(parentAndWorkTypeSiteIds(sites, 'kawasaki')).toEqual([
      'kawasaki', 'kawasaki_tekkotsu', 'kawasaki_kasetsu',
    ])
  })
  test('工種の無い現場は親 id だけ', () => {
    expect(parentAndWorkTypeSiteIds(sites, 'idemitsu')).toEqual(['idemitsu'])
  })
})

describe('findWorkTypeDuplicates', () => {
  const ym = '202609'
  const siteIds = parentAndWorkTypeSiteIds(sites, 'kawasaki')

  test('同じ作業員・同じ日が2つの工種に入っていれば重複として検出する', () => {
    const d: Record<string, unknown> = {
      [attKey('kawasaki_tekkotsu', 30, ym, 26)]: { w: 1 },
      [attKey('kawasaki_kasetsu', 30, ym, 26)]: { w: 1 },
      [attKey('kawasaki_tekkotsu', 30, ym, 27)]: { w: 1 }, // 27日は鉄骨だけ→重複なし
    }
    const dup = findWorkTypeDuplicates(d, siteIds, ym, 'worker')
    expect(dup).toHaveLength(1)
    expect(dup[0]).toEqual({
      kind: 'worker', id: '30', day: 26,
      siteIds: expect.arrayContaining(['kawasaki_tekkotsu', 'kawasaki_kasetsu']),
    })
  })

  test('親現場と工種サイトの組み合わせでも検出する', () => {
    const d: Record<string, unknown> = {
      [attKey('kawasaki', 30, ym, 5)]: { w: 1 },
      [attKey('kawasaki_tekkotsu', 30, ym, 5)]: { w: 1 },
    }
    const dup = findWorkTypeDuplicates(d, siteIds, ym, 'worker')
    expect(dup).toHaveLength(1)
    expect(dup[0].siteIds.sort()).toEqual(['kawasaki', 'kawasaki_tekkotsu'])
  })

  test('別の現場・別の月・値が null のキーは対象外', () => {
    const d: Record<string, unknown> = {
      [attKey('idemitsu', 30, ym, 26)]: { w: 1 },
      [attKey('kawasaki_tekkotsu', 30, '202608', 26)]: { w: 1 },
      [attKey('kawasaki_kasetsu', 30, ym, 26)]: null,
    }
    expect(findWorkTypeDuplicates(d, siteIds, ym, 'worker')).toEqual([])
  })

  test('外注（subcon）の重複も同じ形で検出できる', () => {
    const sd: Record<string, unknown> = {
      [attKey('kawasaki_tekkotsu', 'gaichu1', ym, 10)]: { n: 2, on: 0 },
      [attKey('kawasaki_kasetsu', 'gaichu1', ym, 10)]: { n: 1, on: 0 },
    }
    const dup = findWorkTypeDuplicates(sd, siteIds, ym, 'subcon')
    expect(dup).toEqual([{
      kind: 'subcon', id: 'gaichu1', day: 10,
      siteIds: expect.arrayContaining(['kawasaki_tekkotsu', 'kawasaki_kasetsu']),
    }])
  })

  test('重複が無ければ空配列', () => {
    const d: Record<string, unknown> = {
      [attKey('kawasaki_tekkotsu', 30, ym, 26)]: { w: 1 },
      [attKey('kawasaki_kasetsu', 31, ym, 26)]: { w: 1 },
    }
    expect(findWorkTypeDuplicates(d, siteIds, ym, 'worker')).toEqual([])
  })
})

describe('既存ヘルパーとの整合（回帰確認）', () => {
  test('isWorkTypeSite / siteDisplayName / workTypeSitesOf は変更なし', () => {
    expect(isWorkTypeSite(sites[1])).toBe(true)
    expect(isWorkTypeSite(sites[0])).toBe(false)
    expect(siteDisplayName(sites, 'kawasaki_tekkotsu')).toBe('川崎（鉄骨）')
    expect(workTypeSitesOf(sites, 'kawasaki').map(s => s.id)).toEqual(['kawasaki_tekkotsu', 'kawasaki_kasetsu'])
  })
})

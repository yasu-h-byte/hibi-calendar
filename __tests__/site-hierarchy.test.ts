import { describe, test, expect } from 'vitest'
import {
  parentAndWorkTypeSiteIds, findWorkTypeDuplicates,
  isWorkTypeSite, siteDisplayName, workTypeSitesOf,
  resolveWorkTypeSiteId, planDayWorkTypeMoves,, siteBillingName } from '@/lib/site-hierarchy'

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

describe('resolveWorkTypeSiteId（新規入力の保存先の優先順位・2026-09-25）', () => {
  test('何も無ければ親現場', () => {
    expect(resolveWorkTypeSiteId('kawasaki')).toBe('kawasaki')
  })
  test('作業員の既定 > 親現場', () => {
    expect(resolveWorkTypeSiteId('kawasaki', { workerDefault: 'kawasaki_tekkotsu' })).toBe('kawasaki_tekkotsu')
  })
  test('その日の工種指定 > 作業員の既定', () => {
    expect(resolveWorkTypeSiteId('kawasaki', { dayWorkType: 'kawasaki_kasetsu', workerDefault: 'kawasaki_tekkotsu' })).toBe('kawasaki_kasetsu')
  })
  test('既にエントリがある現場 > 日の指定（既存分の書き込み先は動かさない）', () => {
    expect(resolveWorkTypeSiteId('kawasaki', {
      existingSite: 'kawasaki', dayWorkType: 'kawasaki_tekkotsu', workerDefault: 'kawasaki_kasetsu',
    })).toBe('kawasaki')
  })
  test('null / 空文字は「未設定」扱い', () => {
    expect(resolveWorkTypeSiteId('kawasaki', { existingSite: null, dayWorkType: '', workerDefault: undefined })).toBe('kawasaki')
  })
})

describe('planDayWorkTypeMoves（1日まるごと工種を切り替える移動計画）', () => {
  const ym = '202609'
  const siteIds = parentAndWorkTypeSiteIds(sites, 'kawasaki')

  test('その日の親現場・他工種のエントリを全部 toSiteId へ。既に入っているものは触らない', () => {
    const d = {
      [attKey('kawasaki', 30, ym, 26)]: { w: 1 },                 // 親 → 鉄骨へ
      [attKey('kawasaki_kasetsu', 31, ym, 26)]: { w: 0.5 },      // 仮設 → 鉄骨へ
      [attKey('kawasaki_tekkotsu', 32, ym, 26)]: { w: 1 },       // 既に鉄骨 → そのまま
      [attKey('kawasaki', 30, ym, 27)]: { w: 1 },                 // 別の日 → 対象外
      [attKey('idemitsu', 30, ym, 26)]: { w: 1 },                 // 別現場 → 対象外
    }
    const sd = {
      [attKey('kawasaki', 'gaichu1', ym, 26)]: { n: 2, on: 0 },
    }
    const plan = planDayWorkTypeMoves(d, sd, siteIds, ym, 26, 'kawasaki_tekkotsu')
    expect(plan.skipped).toEqual([])
    expect(plan.moves.map(m => `${m.kind}:${m.id}:${m.fromSiteId}`).sort()).toEqual([
      'subcon:gaichu1:kawasaki', 'worker:30:kawasaki', 'worker:31:kawasaki_kasetsu',
    ])
    const m30 = plan.moves.find(m => m.id === '30')!
    expect(m30.fromKey).toBe('kawasaki_30_202609_26')
    expect(m30.toKey).toBe('kawasaki_tekkotsu_30_202609_26')
  })

  test('2箇所に入っている人は移さず skipped に載せる（他の人は移す）', () => {
    const d = {
      [attKey('kawasaki', 30, ym, 26)]: { w: 1 },
      [attKey('kawasaki_kasetsu', 30, ym, 26)]: { w: 1 },   // 30 は重複
      [attKey('kawasaki', 31, ym, 26)]: { w: 1 },
    }
    const plan = planDayWorkTypeMoves(d, {}, siteIds, ym, 26, 'kawasaki_tekkotsu')
    expect(plan.skipped).toEqual([{ kind: 'worker', id: '30', reason: 'duplicate' }])
    expect(plan.moves.map(m => m.id)).toEqual(['31'])
  })

  test('親現場へ戻す（toSiteId = 親）もできる', () => {
    const d = { [attKey('kawasaki_tekkotsu', 30, ym, 26)]: { w: 1 } }
    const plan = planDayWorkTypeMoves(d, {}, siteIds, ym, 26, 'kawasaki')
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0].toKey).toBe('kawasaki_30_202609_26')
  })

  test('その日に何も無ければ空', () => {
    expect(planDayWorkTypeMoves({}, {}, siteIds, ym, 26, 'kawasaki_tekkotsu')).toEqual({ moves: [], skipped: [] })
  })
})

describe('siteBillingName（親現場の「工種を選ばない日の呼び方」）', () => {
  const sites = [
    { id: 'p', name: '川崎', workType: '仮設工事' },
    { id: 'c', name: '川崎（鉄骨工事）', parentId: 'p', workType: '鉄骨工事' },
    { id: 'q', name: '笹塚', workType: '使われない' },
  ]
  it('工種サイトを持つ親現場は「親現場名（呼び方）」', () => {
    expect(siteBillingName(sites, 'p')).toBe('川崎（仮設工事）')
  })
  it('工種サイトは今までどおり「親現場名（工種）」', () => {
    expect(siteBillingName(sites, 'c')).toBe('川崎（鉄骨工事）')
  })
  it('工種サイトを持たない現場は名前だけ', () => {
    expect(siteBillingName(sites, 'q')).toBe('笹塚')
  })
})

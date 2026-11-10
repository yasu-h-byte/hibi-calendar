/**
 * demmen/main の「控えと同じなら書く」の決まり（2026-11-10 全体点検・lib/main-guard.ts）。
 * 有給の記録・人員一覧・お知らせを、読んでから書くあいだに誰かが書き換えていたら止める（後勝ちで消さない）。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { captureMainGuard, findMainConflict, stableJson } from '@/lib/main-guard'

const main = () => ({
  plData: {
    '12': [{ fy: '2026', grantDays: 10, buyoutHistory: [{ days: 1, at: '2026-10-01' }] }],
    '303': [{ fy: '2026', grantDays: 14 }],
  },
  workers: [{ id: 12, name: 'A' }, { id: 303, name: 'B' }],
  sites: [{ id: 's1' }],
  announcements: [],
})

describe('stableJson', () => {
  test('キーの順番が違っても同じ。undefined の項目は無いものと同じ', () => {
    expect(stableJson({ a: 1, b: { d: 2, c: 3 } })).toBe(stableJson({ b: { c: 3, d: 2 }, a: 1 }))
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }))
    expect(stableJson(undefined)).toBe('null')
  })
  test('配列の順番・値の違いは違いとして出る', () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]))
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: '1' }))
  })
})

describe('findMainConflict', () => {
  test('誰も書き換えていなければ通す（手元で直したあとでも、控えは読んだ時点のまま）', () => {
    const read = main()
    const guard = captureMainGuard(read)
    read.plData['12'][0].grantDays = 99   // 手元の変更は控えに影響しない
    expect(findMainConflict(guard, main(), { plKeys: ['12'], fields: ['workers'] })).toBeNull()
  })
  test('同じ人の有給記録が書き換わっていたら止める', () => {
    const guard = captureMainGuard(main())
    const now = main()
    now.plData['12'][0].buyoutHistory.push({ days: 2, at: '2026-11-10' })
    expect(findMainConflict(guard, now, { plKeys: ['12'] })).toBe('plData.12')
  })
  test('別の人の有給記録が書き換わっていても、その人を書かないなら止めない', () => {
    const guard = captureMainGuard(main())
    const now = main()
    now.plData['303'][0].grantDays = 20
    expect(findMainConflict(guard, now, { plKeys: ['12'] })).toBeNull()
  })
  test("一括（'all'）は、誰か1人でも書き換わっていたら・人が増えていたら止める", () => {
    const guard = captureMainGuard(main())
    const changed = main(); changed.plData['303'][0].grantDays = 20
    expect(findMainConflict(guard, changed, { plKeys: 'all' })).toBe('plData.303')
    const added = main() as ReturnType<typeof main> & { plData: Record<string, unknown[]> }
    added.plData['7'] = [{ fy: '2026' }]
    expect(findMainConflict(guard, added, { plKeys: 'all' })).toBe('plData.7')
  })
  test('読んだときに無かった人の記録が、書く前にできていたら止める', () => {
    const guard = captureMainGuard(main())
    const now = main() as ReturnType<typeof main> & { plData: Record<string, unknown[]> }
    now.plData['50'] = [{ fy: '2026' }]
    expect(findMainConflict(guard, now, { plKeys: ['50'] })).toBe('plData.50')
    expect(findMainConflict(guard, main(), { plKeys: ['50'] })).toBeNull()
  })
  test('人員一覧・お知らせが書き換わっていたら止める', () => {
    const guard = captureMainGuard(main())
    const now = main(); now.workers[1].name = 'C'
    expect(findMainConflict(guard, now, { fields: ['workers'] })).toBe('workers')
    expect(findMainConflict(guard, now, { fields: ['announcements'] })).toBeNull()
  })
})

describe('main の有給記録・配列を、守りなしで書いている所が無い', () => {
  const FILES = [
    'app/api/leave/route.ts', 'app/api/leave-settle/route.ts', 'app/api/jp-wage/bonus/route.ts',
    'app/api/announcements/route.ts', 'app/api/commute/measure/route.ts', 'lib/leave-carry.ts',
  ]
  test.each(FILES)('%s', file => {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    // updateDoc / updateMapByKey で plData・workers・sites・announcements を直接書かない（guardedMainUpdate かトランザクションを通す）
    expect(src).not.toMatch(/(updateDoc|updateMapByKey)\([^)]*(plData|\{\s*workers\b|\{\s*sites\b|announcements)/)
  })
})

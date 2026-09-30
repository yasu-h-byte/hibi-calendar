import { describe, test, expect } from 'vitest'
import { detectRestMismatches } from '@/lib/rest-mismatch'

const fam = (sid: string) => (sid === 'ihi_tekkotsu' ? 'ihi' : sid)

describe('会社都合休と自分都合の休みの取り違え', () => {
  test('自分の都合の休みの日に、同じ現場でほかの人が0.6補（人数調整）→ 出す（工種サイトも同じ現場）', () => {
    const d = {
      ihi_110_202609_17: { w: 0, r: 1, rReason: 'personal' },
      ihi_1_202609_17: { w: 0.6 }, ihi_tekkotsu_2_202609_17: { w: 0.6 }, ihi_3_202609_17: { w: 0.6 },
      ihi_4_202609_17: { w: 1 }, ihi_5_202609_17: { w: 1 },
      kasai_6_202609_17: { w: 0.6 },  // 別の現場は数えない
    }
    expect(detectRestMismatches(d, '202609', fam)).toEqual([
      { workerId: 110, day: 17, kind: 'rest_while_others_comp', familyId: 'ihi', worked: 2, comp: 3 },
    ])
  })
  test('ほかに0.6補の人がいない日の自分都合の休みは普通なので出さない（人数調整の0.6補も出さない）', () => {
    const d = {
      ihi_206_202609_29: { w: 0, r: 1 }, ihi_1_202609_29: { w: 1 }, ihi_2_202609_29: { w: 1 },
      ihi_3_202609_1: { w: 0.6 }, ihi_4_202609_1: { w: 1 }, ihi_5_202609_1: { w: 1 }, ihi_6_202609_1: { w: 1 },
    }
    expect(detectRestMismatches(d, '202609', fam)).toEqual([])
  })
  test('カレンダーで休みの日は対象外・有給や別の月も対象外', () => {
    const d = {
      sasazuka_103_202609_22: { w: 0, r: 1 }, sasazuka_1_202609_22: { w: 0.6 },
      ihi_7_202609_3: { w: 0, p: 1 }, ihi_8_202609_3: { w: 0.6 },
      ihi_9_202608_3: { w: 0, r: 1 }, ihi_10_202608_3: { w: 0.6 },
    }
    const offOn22 = (_f: string, day: number) => day !== 22
    expect(detectRestMismatches(d, '202609', fam, offOn22)).toEqual([])
  })
})

import { describe, test, expect } from 'vitest'
import { entryPlace, findStaleAssignments } from '@/lib/foreman-todo'
import type { MainData } from '@/lib/compute'

// 2026-10-01 代表決定: 現場を移動したのに前の現場の配置に残っている人の扱い
//   ① その日に別の現場で入力があれば、前の現場では「未入力」に数えない
//   ② 14日この現場で入力が無く別の現場で出勤している人は「配置の見直し」で知らせる（自動では外さない）

const main = {
  sites: [{ id: 'ihi', name: 'IHI' }, { id: 'sasa', name: '笹塚' }, { id: 'kawa', name: '川崎' }],
  workers: [
    { id: 103, name: 'ファン', visa: 'tokutei2' },
    { id: 110, name: 'ビン', visa: 'tokutei1' },
    { id: 120, name: '新人', visa: 'jisshu1' },
  ],
  assign: {},
  massign: {
    ihi_202610: { workers: [103, 110, 120] },
    sasa_202610: { workers: [103] },
    kawa_202610: { workers: [110] },
  },
} as unknown as MainData

const work = { w: 1 }
// ファン: 9/17〜9/30 ずっと笹塚 / ビン: IHI と川崎を掛け持ち / 新人: どこにも入力なし
const att: Record<string, { w?: number }> = {}
for (let d = 17; d <= 30; d++) {
  att[`sasa_103_202609_${d}`] = work
  att[`${d % 2 ? 'ihi' : 'kawa'}_110_202609_${d}`] = work
}
att['sasa_103_202610_1'] = work

describe('entryPlace（その日どこで入力しているか）', () => {
  test('別の現場で入力していれば elsewhere（未入力にしない）', () => {
    expect(entryPlace(att as never, ['ihi'], 103, '202609', 30)).toEqual({ place: 'elsewhere', siteIds: ['sasa'] })
  })
  test('この現場で入力していれば here', () => {
    expect(entryPlace(att as never, ['ihi'], 110, '202609', 29).place).toBe('here')
  })
  test('どこにも入力が無ければ none（本当の未入力）', () => {
    expect(entryPlace(att as never, ['ihi'], 120, '202609', 30).place).toBe('none')
  })
})

describe('findStaleAssignments（配置の見直し）', () => {
  const stale = findStaleAssignments(main, att as never, '2026-10-01')
  test('14日 IHI で入力が無く笹塚で出勤しているファンさんは IHI の配置の見直し', () => {
    expect(stale).toContainEqual({ siteId: 'ihi', siteName: 'IHI', workerId: 103, workerName: 'ファン', workingAt: ['笹塚'] })
  })
  test('掛け持ちのビンさん・どこにも入力が無い新人は出さない', () => {
    expect(stale.map(s => s.workerId)).toEqual([103])
  })
})

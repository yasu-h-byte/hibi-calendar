/**
 * 配置（名簿）の決まりは getAssign 1つ（lib/roster.ts・2026-10-02 総合点検）
 * 「人 → その月の現場」が、PC の出面画面・給与計算と同じ「月別配置 → 過去12か月をさかのぼる → 既定配置」で決まること
 */
import { describe, test, expect } from 'vitest'
import { sitesOfWorkerForMonth, workerIdsOfSiteForMonth } from '@/lib/roster'

const src = {
  sites: [
    { id: 'ihi', name: 'IHI' },
    { id: 'sasazuka', name: '笹塚' },
    { id: 'ihi_tekkotsu', name: 'IHI 鉄骨', parentId: 'ihi' },
    { id: 'old', name: '終了', archived: true },
  ],
  assign: { ihi: { workers: [101] }, sasazuka: { workers: [201] }, old: { workers: [201] } },
  massign: {
    'ihi_202608': { workers: [201] },          // 8月だけ IHI に 201
    'sasazuka_202610': { workers: [301] },     // 10月の笹塚は 301 だけ
  },
}

describe('sitesOfWorkerForMonth', () => {
  test('月別配置が古い月にしか無い人は、さかのぼって同じ現場（旧: 既定配置に落ちていた）', () => {
    // 10月: IHI は 8月の月別配置をさかのぼる → 201 は IHI。笹塚は 10月の月別配置 → 201 はいない
    expect(sitesOfWorkerForMonth(src, 201, '202610').map(s => s.id)).toEqual(['ihi'])
    expect(workerIdsOfSiteForMonth(src, 'ihi', '202610')).toEqual([201])
  })
  test('月別配置が無ければ既定配置', () => {
    expect(sitesOfWorkerForMonth(src, 101, '202607').map(s => s.id)).toEqual(['ihi'])
    expect(sitesOfWorkerForMonth(src, 201, '202607').map(s => s.id)).toEqual(['sasazuka'])
  })
  test('終了した現場は出さない・YYYY-MM でも同じ', () => {
    expect(sitesOfWorkerForMonth(src, 201, '2026-07').map(s => s.id)).toEqual(['sasazuka'])
  })
  test('工種サイトは既定で含める（旧 getStaffSites と同じ範囲）。外すこともできる', () => {
    const src2 = { ...src, assign: { ...src.assign, ihi_tekkotsu: { workers: [101] } } }
    expect(sitesOfWorkerForMonth(src2, 101, '202607').map(s => s.id)).toEqual(['ihi', 'ihi_tekkotsu'])
    expect(sitesOfWorkerForMonth(src2, 101, '202607', { includeWorkTypeSites: false }).map(s => s.id)).toEqual(['ihi'])
  })
})

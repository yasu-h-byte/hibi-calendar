import { describe, test, expect } from 'vitest'
import { calendarSiteIdOf, siteDisplayName, withWorkTypeSiteCalendars, orderSitesWithWorkTypes, isSiteStartedByMonth } from '@/lib/site-hierarchy'
import { computeMonthly, type MainData } from '@/lib/compute'
import { buildPeerStatements } from '@/lib/peer-statement'
import { compute } from '@/lib/compute'
import type { AttendanceEntry } from '@/types'

/** 工種サイト（2026-09-15） */
const sites = [
  { id: 'idemitsu', name: '出光' },
  { id: 'sasazuka', name: '笹塚' },
  { id: 'idemitsu_steel', name: '出光（鉄骨）', parentId: 'idemitsu', workType: '鉄骨' },
  { id: 'idemitsu_temp', name: '出光（仮設）', parentId: 'idemitsu', workType: '仮設' },
]

describe('site-hierarchy', () => {
  test('工種サイトのカレンダーは親現場', () => {
    expect(calendarSiteIdOf(sites, 'idemitsu_steel')).toBe('idemitsu')
    expect(calendarSiteIdOf(sites, 'sasazuka')).toBe('sasazuka')
    expect(calendarSiteIdOf(sites, 'unknown')).toBe('unknown')
  })
  test('表示名は「親（工種）」', () => {
    expect(siteDisplayName(sites, 'idemitsu_temp')).toBe('出光（仮設）')
  })
  test('カレンダー系マップを工種サイトに補う（元は変えない）', () => {
    const m = { idemitsu: 22 }
    const out = withWorkTypeSiteCalendars(sites, m)
    expect(out).toEqual({ idemitsu: 22, idemitsu_steel: 22, idemitsu_temp: 22 })
    expect(m).toEqual({ idemitsu: 22 })
  })
  test('並び順は親の直後に工種', () => {
    expect(orderSitesWithWorkTypes(sites).map(s => s.id)).toEqual(['idemitsu', 'idemitsu_steel', 'idemitsu_temp', 'sasazuka'])
  })
})

describe('給与計算: 工種サイトだけに出勤した人も親のカレンダーで所定日数が決まる', () => {
  test('親の稼働日18日 → 工種サイトの出勤18日で欠勤0', () => {
    const main = {
      workers: [{ id: 201, name: 'グエン', org: 'hibi', visa: 'jisshu3', job: 'tobi', rate: 1513 * 7, hourlyRate: 1513, otMul: 1.25, hireDate: '2022-10-01', token: '' }],
      sites: [
        { id: 'idemitsu', name: '出光', start: '', end: '', foreman: 0, archived: false },
        { id: 'idemitsu_steel', name: '出光（鉄骨）', start: '', end: '', foreman: 0, archived: false, parentId: 'idemitsu', workType: '鉄骨' },
      ],
      subcons: [], assign: { idemitsu_steel: { workers: [201], subcons: [] } }, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
      defaultRates: { tobiRate: 25000, dokoRate: 20000 }, mforeman: {},
    } as unknown as MainData
    const cal: Record<string, string> = {}
    const att: Record<string, AttendanceEntry> = {}
    let n = 0
    for (let d = 1; d <= 30; d++) {
      if ([6, 13, 20, 27].includes(d)) { cal[String(d)] = 'holiday'; continue }
      if (n < 18) { cal[String(d)] = 'work'; att[`idemitsu_steel_201_202609_${d}`] = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 } as unknown as AttendanceEntry; n++ } else cal[String(d)] = 'off'
    }
    // カレンダーは親現場にしか無い
    const w = computeMonthly(main, att, {}, '202609', 0, { idemitsu: 18 }, 20, { idemitsu: cal }).workers.find(x => x.id === 201)!
    expect(w.workerPrescribedDays).toBe(18)
    expect(w.absence).toBe(0)
    expect(w.calendarBlankDays).toBeUndefined()
  })
})

describe('同業者別の請求・支払', () => {
  test('応援現場の工種ごとに請求、外注は支払に出る（相殺しない）', () => {
    const main = {
      workers: [{ id: 4, name: '本田', org: 'hibi', visa: 'none', job: 'tobi', rate: 18000, otMul: 1.25, hireDate: '2001-09-01', token: '' }],
      sites: [
        { id: 'idemitsu', name: '出光', start: '', end: '', foreman: 0, archived: false, siteType: 'support', ownerId: 'yoshimoto', rates: [{ from: '202609', tobiRate: 30000, dokoRate: 25000 }] },
        { id: 'idemitsu_steel', name: '出光（鉄骨）', start: '', end: '', foreman: 0, archived: false, parentId: 'idemitsu', workType: '鉄骨', siteType: 'support', ownerId: 'yoshimoto', rates: [{ from: '202609', tobiRate: 30000, dokoRate: 25000 }] },
        { id: 'idemitsu_temp', name: '出光（仮設）', start: '', end: '', foreman: 0, archived: false, parentId: 'idemitsu', workType: '仮設', siteType: 'support', ownerId: 'yoshimoto', rates: [{ from: '202609', tobiRate: 28000, dokoRate: 24000 }] },
      ],
      subcons: [
        { id: 'yoshimoto', name: '吉本建設工業', type: '鳶業者', rate: 26000, otRate: 4063, roles: ['peer'] },
        { id: 'hatakeyama', name: '畠山組', type: '鳶業者', rate: 26000, otRate: 4063, roles: ['peer'] },
      ],
      assign: {}, massign: {}, billing: {}, workDays: {}, siteWorkDays: {}, locks: {}, plData: {},
      defaultRates: { tobiRate: 38000, dokoRate: 30000 }, mforeman: {},
    } as unknown as MainData
    const attD: Record<string, AttendanceEntry> = {}
    for (const d of [1, 2]) attD[`idemitsu_steel_4_202609_${d}`] = { w: 1 } as AttendanceEntry
    attD['idemitsu_temp_4_202609_3'] = { w: 1 } as AttendanceEntry
    const attSD = { 'idemitsu_temp_hatakeyama_202609_3': { n: 2, on: 0 } }
    const c = compute(main, attD, attSD, [{ y: 2026, m: 9 }])
    const st = buildPeerStatements(main, c, attD, attSD, '202609')
    const yo = st.find(x => x.companyId === 'yoshimoto')!
    expect(yo.billing.map(b => [b.siteName, b.tobiDays, b.amount])).toEqual([
      ['出光（仮設）', 3, 84000],   // 本田1 + 畠山2 人工 × 28,000
      ['出光（鉄骨）', 2, 60000],   // 2人工 × 30,000
    ])
    expect(yo.payments).toEqual([])
    const ha = st.find(x => x.companyId === 'hatakeyama')!
    expect(ha.billing).toEqual([])
    expect(ha.payments[0]).toMatchObject({ siteName: '出光（仮設）', days: 2, amount: 52000 })
  })
})

describe('isSiteStartedByMonth（後から追加した現場を過去月に混ぜない）', () => {
  test('工期の開始月より前の月は対象外、開始月以降は対象', () => {
    const idemitsu = { start: '2026-10-01' }
    expect(isSiteStartedByMonth(idemitsu, '2026-09')).toBe(false)
    expect(isSiteStartedByMonth(idemitsu, '202610')).toBe(true)
    // 月の途中から始まる現場（川崎 9/25〜）はその月から対象
    expect(isSiteStartedByMonth({ start: '2026-09-25' }, '2026-09')).toBe(true)
    expect(isSiteStartedByMonth({ start: '2026-09-25' }, '2026-08')).toBe(false)
    // 'YYYY-MM' 形式・未設定
    expect(isSiteStartedByMonth({ start: '2023-12' }, '2026-07')).toBe(true)
    expect(isSiteStartedByMonth({}, '2026-07')).toBe(true)
    expect(isSiteStartedByMonth({ start: '' }, '2026-07')).toBe(true)
  })
})

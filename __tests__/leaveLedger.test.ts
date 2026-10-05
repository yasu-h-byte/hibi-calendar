import { describe, test, expect } from 'vitest'
import * as XLSX from 'xlsx-js-style'
import type { AttendanceEntry } from '@/types'
import type { LeaveLedgerData, LeaveLedgerRecord } from '@/lib/export'
import { buildLeaveLedgerModel, generateLeaveLedger, leaveLedgerToBuffer, leaveLedgerFilename } from '@/lib/leave-ledger'

// 年次有給休暇管理簿（一覧表＋1人1枚の個人票・2026-10-05）。名前は架空
const TODAY = '2026-10-05'
const P = { p: 1 } as unknown as AttendanceEntry
const data: LeaveLedgerData = {
  workers: [
    { id: 4, name: '日本 太郎', org: 'hibi', visa: 'none', hireDate: '2020-04-01' },
    { id: 31, name: '日本 次郎', org: 'hfu', visa: 'none', hireDate: '2026-08-01' },   // 入社6か月前＝付与なし
    { id: 101, name: 'アン', org: 'hibi', visa: 'tokutei1', hireDate: '2019-05-01' },
    { id: 205, name: 'ビン', org: 'hfu', visa: 'jisshu2', hireDate: '2024-11-01' },
    { id: 900, name: '昔の人', org: 'hibi', visa: 'none', hireDate: '2010-04-01', retired: '2020-03-31' },   // 退職から5年超
  ],
  plData: {
    '4': [
      { fy: '2024', grantDate: '2024-10-01', grantDays: 16 },
      { fy: '2025', grantDate: '2025-10-01', grantDays: 18 },
      { fy: '2026', grantDate: '2026-10-01', grantDays: 20 },
    ],
    '101': [
      { fy: '2025', grantDate: '2025-11-01', grantDays: 16, carryOver: 3, buyoutDays: 2,
        buyoutHistory: [{ at: '2026-09-30T00:00:00Z', days: 2, amount: 12345, reason: 'year-end' }],
        designatedLeaves: [{ date: '2026-08-12', note: 'お盆' }] },
    ],
    '205': [{ fy: '2025', grantDate: '2025-05-01', grantDays: 10 }, { fy: '2026', grantDate: '2026-05-01', grantDays: 11 }],
  } as Record<string, LeaveLedgerRecord[]>,
  allAtt: {
    's1_4_202510_10': P, 's1_4_202604_3': P, 's2_4_202604_3': P,          // 同じ日の2現場は1日
    's1_4_202610_2': P,
    's1_101_202512_24': P, 's1_101_202608_12': P, 's1_101_202610_20': P,  // 10/20 は承認済みの予定
    's1_205_202606_1': P, 's1_205_202606_2': P, 's1_205_202607_1': P, 's1_205_202608_3': P, 's1_205_202609_4': P,
  },
}
const names = (scope: Parameters<typeof buildLeaveLedgerModel>[1] extends infer O ? O extends { scope?: infer S } ? S : never : never) =>
  buildLeaveLedgerModel(data, { scope, todayIso: TODAY }).people.map(p => p.name)

describe('有給管理簿の出し分け', () => {
  test('会社ごと・日本人・ベトナム人。退職から5年を超えた人は載せない', () => {
    expect(names('hibi')).toEqual(['日本 太郎', 'アン'])
    expect(names('hfu')).toEqual(['日本 次郎', 'ビン'])
    expect(names('jp')).toEqual(['日本 太郎', '日本 次郎'])
    expect(names('vn')).toEqual(['アン', 'ビン'])
    expect(names('all')).toHaveLength(4)
  })
  test('既定は今の期と前の期。全期間は range: all', () => {
    const recent = buildLeaveLedgerModel(data, { scope: 'jp', todayIso: TODAY }).people[0]
    expect(recent.periods.map(p => p.grantDate)).toEqual(['2025-10-01', '2026-10-01'])
    expect(recent.current?.grantDate).toBe('2026-10-01')
    const all = buildLeaveLedgerModel(data, { scope: 'jp', range: 'all', todayIso: TODAY }).people[0]
    expect(all.periods).toHaveLength(3)
  })
})

describe('有給管理簿の中身（法定の3項目: 基準日・日数・時季）', () => {
  const m = buildLeaveLedgerModel(data, { scope: 'all', todayIso: TODAY })
  const person = (id: number) => m.people.find(p => p.id === id)!
  test('取得した日は1日ずつ・同じ日の2現場は1日・時季指定と予定の印', () => {
    const jp = person(4).periods.find(p => p.grantDate === '2025-10-01')!
    expect(jp.taken.map(t => t.date)).toEqual(['2025-10-10', '2026-04-03'])
    expect(jp.periodUsed).toBe(2)
    expect(jp.remaining).toBe(16)
    expect(jp.periodLastDay).toBe('2026-09-30')
    const vn = person(101).periods[0]
    expect(vn.taken).toEqual([
      { date: '2025-12-24', designated: false, note: '', planned: false },
      { date: '2026-08-12', designated: true, note: 'お盆', planned: false },
      { date: '2026-10-20', designated: false, note: '', planned: true },
    ])
    expect(vn.carryOver).toBe(3)
    expect(vn.remaining).toBe(16 + 3 - 3 - 2)
    expect(vn.lastUsableDay).toBe('2027-10-31')
  })
  test('年5日の取得: 付与10日以上が対象。5日で達成・足りなければ「あと◯日」と期限', () => {
    expect(person(205).current?.obligation).toEqual({ applies: true, taken: 5, met: true, shortfall: 0, deadline: '2027-04-30' })
    expect(person(101).current?.obligation).toMatchObject({ applies: true, met: false, shortfall: 2, deadline: '2026-10-31' })
    expect(person(4).current?.obligation).toMatchObject({ applies: true, taken: 1, shortfall: 4 })
  })
  test('付与の記録が無い人も載る（今の期なし）', () => {
    expect(person(31).periods).toEqual([])
    expect(person(31).current).toBeNull()
  })
  test('買取の記録（金額は渡されたときだけ）', () => {
    expect(m.buyouts).toEqual([{ id: 101, name: 'アン', grantDate: '2025-11-01', at: '2026-09-30', days: 2, amount: 12345, reason: '期末買取' }])
  })
})

describe('有給管理簿: システムに記録が無い期・退職した人（2026-10-05 本番の出力で確認して追加）', () => {
  const d2: LeaveLedgerData = {
    workers: [
      { id: 107, name: 'ケン', org: 'hibi', visa: 'jisshu3', hireDate: '2023-05-14' },
      { id: 108, name: 'クアン', org: 'hibi', visa: 'jisshu', hireDate: '2023-05-14', retired: '2026-02-28' },
    ],
    plData: {
      '107': [{ fy: '2024', grantDate: '2024-11-01', grantDays: 11 }, { fy: '2025', grantDate: '2025-11-14', grantDays: 12 }],
      '108': [{ fy: '2025', grantDate: '2025-11-01', grantDays: 12 }],
    } as Record<string, LeaveLedgerRecord[]>,
    allAtt: {},
  }
  const wb = generateLeaveLedger(d2, { scope: 'vn', todayIso: TODAY })
  const text = (name: string) => (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 }) as unknown[][]).flat().join('|')
  test('システム導入前に始まった期は「取得なし・未達」と出さず、紙の管理簿を見るように出す', () => {
    const m = buildLeaveLedgerModel(d2, { scope: 'vn', todayIso: TODAY })
    expect(m.people[0].periods.map(p => p.beforeSystem)).toEqual([true, false])
    const t = text('107_ケン')
    expect(t).toContain('紙の管理簿を見てください')
    expect(t).not.toContain('未達')
  })
  test('期の途中で退職した人に「あと◯日」を出さない。在留資格の古い書き方（jisshu）も日本語で出す', () => {
    const t = text('108_クアン')
    expect(t).toContain('技能実習')
    expect(t).not.toContain('jisshu')
    expect(t).not.toContain('あと5日')
    expect(t).toContain('退職')
  })
})

describe('有給管理簿の Excel', () => {
  test('先頭に一覧表、1人1枚の個人票、最後に買取記録。日本人だけの出力に買取記録は付けない', () => {
    const wb = generateLeaveLedger(data, { scope: 'hibi', todayIso: TODAY })
    expect(wb.SheetNames).toEqual(['一覧表', '4_日本 太郎', '101_アン', '買取記録'])
    expect(generateLeaveLedger(data, { scope: 'jp', todayIso: TODAY }).SheetNames).toEqual(['一覧表', '4_日本 太郎', '31_日本 次郎'])
  })
  test('書き出して読み直せる。個人票に基準日・付与日数・取得した日・残日数・年5日が入っている', () => {
    const buf = leaveLedgerToBuffer(generateLeaveLedger(data, { scope: 'vn', todayIso: TODAY }))
    const wb = XLSX.read(buf, { type: 'buffer' })
    const text = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['101_アン'], { header: 1 }) as unknown[][]).flat().join('|')
    for (const s of ['年次有給休暇管理簿', 'アン', '特定技能1号', '2025/11/01', '基準日（付与日）', '前期からの繰越', '12/24（水）', '8/12（水）◆', '10/20（火）（予）', '残日数', 'あと2日', '2026/10/31']) {
      expect(text).toContain(s)
    }
    const summary = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['一覧表'], { header: 1 }) as unknown[][]).flat().join('|')
    expect(summary).toContain('ベトナム人スタッフ')
    expect(summary).toContain('達成')
  })
  test('ファイル名', () => {
    expect(leaveLedgerFilename('hibi', 'recent', TODAY)).toBe('有給管理簿_日比建設_20261005.xlsx')
    expect(leaveLedgerFilename('vn', 'all', TODAY)).toBe('有給管理簿_ベトナム人_全期間_20261005.xlsx')
    expect(leaveLedgerFilename('all', 'recent', TODAY)).toBe('有給管理簿_20261005.xlsx')
  })
})

import { describe, it, expect } from 'vitest'
import {
  currentYm,
  getYmOptions,
  getDow,
  isToday,
  dayColBg,
  dayHeaderBg,
  dayTextColor,
  retirementBadge,
  getWorkValue,
  getTimeStatusValue,
  computeWorkerTotals,
  computeSubconTotals,
  computeFooterSums,
  collectSundayWarnings,
  collectHolidayWorkWarnings,
} from '@/lib/attendance-grid'
import { AttEntry } from '@/app/(app)/attendance/types'

describe('日付ヘルパー', () => {
  it('currentYm: 今月のYYYYMM', () => {
    const now = new Date()
    expect(currentYm()).toBe(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`)
  })

  it('getYmOptions: 2ヶ月先から過去に向かって生成', () => {
    const opts = getYmOptions(4)
    expect(opts).toHaveLength(6)  // i = -2..3
    const now = new Date()
    const ahead2 = new Date(now.getFullYear(), now.getMonth() + 2, 1)
    expect(opts[0].ym).toBe(`${ahead2.getFullYear()}${String(ahead2.getMonth() + 1).padStart(2, '0')}`)
    expect(opts[2].ym).toBe(currentYm())
  })

  it('getDow / isToday', () => {
    expect(getDow(2026, 6, 7)).toBe(0)   // 2026-06-07 = 日曜
    expect(getDow(2026, 6, 6)).toBe(6)   // 土曜
    const now = new Date()
    expect(isToday(now.getFullYear(), now.getMonth() + 1, now.getDate())).toBe(true)
    expect(isToday(2000, 1, 1)).toBe(false)
  })

  it('セル背景: 日曜赤・土曜青はカレンダー休日より優先、平日休日はグレー', () => {
    expect(dayColBg(2026, 6, 7, 'off')).toBe('bg-red-50')       // 日曜
    expect(dayColBg(2026, 6, 6, 'off')).toBe('bg-blue-50')      // 土曜
    expect(dayColBg(2026, 6, 10, 'off')).toBe('bg-gray-100/60') // 平日休日
    expect(dayColBg(2026, 6, 10, 'holiday')).toBe('bg-gray-100/60')
    expect(dayColBg(2026, 6, 10, 'work')).toBe('')
    expect(dayHeaderBg(2026, 6, 7, null)).toBe('bg-red-100')
    expect(dayHeaderBg(2026, 6, 10, 'off')).toBe('bg-gray-200')
    expect(dayHeaderBg(2026, 6, 10, 'work')).toBe('bg-gray-100')
  })

  it('今日はアンバー最優先', () => {
    const now = new Date()
    expect(dayColBg(now.getFullYear(), now.getMonth() + 1, now.getDate(), 'off')).toBe('bg-amber-50')
  })

  it('dayTextColor', () => {
    expect(dayTextColor(0)).toBe('text-red-600')
    expect(dayTextColor(6)).toBe('text-blue-600')
    expect(dayTextColor(3)).toBe('text-gray-700')
  })
})

describe('retirementBadge: 退職日バッジ', () => {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const daysFromToday = (n: number) => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + n)
    return d
  }

  it('過去日 → グレー「退職済」', () => {
    const b = retirementBadge(iso(daysFromToday(-10)))!
    expect(b.label).toContain('退職済')
    expect(b.cls).toContain('bg-gray-200')
  })

  it('30日以内 → 赤', () => {
    const b = retirementBadge(iso(daysFromToday(10)))!
    expect(b.label).toContain('退職')
    expect(b.cls).toContain('bg-red-100')
  })

  it('31〜90日 → オレンジ', () => {
    const b = retirementBadge(iso(daysFromToday(60)))!
    expect(b.cls).toContain('bg-orange-100')
  })

  it('91日以降・未設定 → バッジなし', () => {
    expect(retirementBadge(iso(daysFromToday(120)))).toBeNull()
    expect(retirementBadge(undefined)).toBeNull()
  })
})

describe('セル表示値の判定', () => {
  it('getWorkValue: 優先順 P > E > HK > 出勤値', () => {
    expect(getWorkValue(null)).toBe('')
    expect(getWorkValue({ w: 1 })).toBe('1')
    expect(getWorkValue({ w: 0.5 })).toBe('0.5')
    expect(getWorkValue({ w: 0.6 })).toBe('0.6')
    expect(getWorkValue({ w: 0, p: 1 })).toBe('P')
    expect(getWorkValue({ w: 0, exam: 1 })).toBe('E')
    expect(getWorkValue({ w: 0, hk: 1 })).toBe('HK')
    // 帰国期間中の有給事後計上: p:1 + hk:1 → 有給を優先
    expect(getWorkValue({ w: 0, p: 1, hk: 1 })).toBe('P')
  })

  it('getTimeStatusValue: 優先順 P > E > R > H > HK > W', () => {
    expect(getTimeStatusValue({ w: 1, st: '08:00', et: '17:00' })).toBe('W')
    expect(getTimeStatusValue({ w: 0, r: 1 })).toBe('R')
    expect(getTimeStatusValue({ w: 0, h: 1 })).toBe('H')
    expect(getTimeStatusValue({ w: 0, p: 1, hk: 1 })).toBe('P')
    expect(getTimeStatusValue({ w: 0, exam: 1, r: 1 })).toBe('E')
    expect(getTimeStatusValue(null)).toBe('')
  })
})

describe('computeWorkerTotals: ワーカー月間合計', () => {
  it('レガシー: 人工・残業・補償・有給を集計', () => {
    const entries: Record<number, AttEntry> = {
      1: { w: 1, o: 2 },
      2: { w: 0.6 },
      3: { w: 0, p: 1 },
      4: { w: 0.5 },
    }
    const t = computeWorkerTotals(entries, { timeBased: false, foreign: false })
    expect(t.wSum).toBe(2.1)   // 1 + 0.6 + 0.5
    expect(t.oSum).toBe(2)
    expect(t.compSum).toBe(0.6)
    expect(t.plSum).toBe(1)
  })

  it('残骸データガード: {w:1, p:1} は有給としてのみカウント（人工に水増ししない）', () => {
    // 2026-05-09 ビンさん事案の再発防止
    const entries: Record<number, AttEntry> = {
      1: { w: 1, p: 1, o: 2 },  // 有給に切替えたが w/o が残った残骸
      2: { w: 1, hk: 1 },       // 帰国中に切替えた残骸
      3: { w: 1 },              // 正常な出勤
    }
    const t = computeWorkerTotals(entries, { timeBased: false, foreign: false })
    expect(t.wSum).toBe(1)     // 正常な出勤のみ
    expect(t.oSum).toBe(0)     // 残骸の残業もカウントしない
    expect(t.plSum).toBe(1)
  })

  it('外国人の補償(0.6)日の残業はカウントしない（フッターと整合）', () => {
    const entries: Record<number, AttEntry> = { 1: { w: 0.6, o: 3 } }
    const foreign = computeWorkerTotals(entries, { timeBased: false, foreign: true })
    expect(foreign.wSum).toBe(0.6)
    expect(foreign.compSum).toBe(0.6)
    expect(foreign.oSum).toBe(0)   // 補償日の残業は除外
    // 日本人の0.6は残業もカウント
    const jp = computeWorkerTotals(entries, { timeBased: false, foreign: false })
    expect(jp.oSum).toBe(3)
  })

  it('浮動小数点誤差を丸める（0.6×12 = 7.2）', () => {
    const entries: Record<number, AttEntry> = {}
    for (let d = 1; d <= 12; d++) entries[d] = { w: 0.6 }
    const t = computeWorkerTotals(entries, { timeBased: false, foreign: false })
    expect(t.wSum).toBe(7.2)
    expect(t.compSum).toBe(7.2)
  })

  it('時間ベース: st/et から実労働時間と残業(7h超)を計算', () => {
    const entries: Record<number, AttEntry> = {
      1: { w: 1, st: '08:00', et: '19:00', b1: 1, b2: 1, b3: 1 },  // 9h実労働 → 残業2h
      2: { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1 },  // 7h → 残業0
    }
    const t = computeWorkerTotals(entries, { timeBased: true, foreign: true })
    expect(t.actualHoursSum).toBe(16)
    expect(t.oSum).toBe(2)
    expect(t.wSum).toBe(2)
  })

  it('旧契約継続者（timeBased=false）はst/etがあってもレガシー計算', () => {
    const entries: Record<number, AttEntry> = { 1: { w: 1, o: 3, st: '08:00', et: '19:00' } }
    const t = computeWorkerTotals(entries, { timeBased: false, foreign: true })
    expect(t.oSum).toBe(3)
    expect(t.actualHoursSum).toBe(0)
  })
})

describe('computeSubconTotals: 外注月間合計', () => {
  it('人数と残業人数を合計', () => {
    const t = computeSubconTotals({ 1: { n: 2, on: 1 }, 2: { n: 1, on: 0 }, 3: null })
    expect(t.nSum).toBe(3)
    expect(t.onSum).toBe(1)
  })
})

describe('computeFooterSums: 鳶合計・土工合計・総合計（フッタールール）', () => {
  const workers = [
    { id: 1, visa: 'none', job: 'tobi' },
    { id: 2, visa: 'none', job: 'shokucho' },
    { id: 3, visa: 'none', job: 'doko' },
    { id: 4, visa: 'ginou', job: 'doko' },   // 外国人土工
    { id: 5, visa: 'none', job: 'yakuin' },
    { id: 6, visa: 'ginou', job: 'tobi_apprentice' },  // 鳶見習い → 鳶グループ
  ]
  const subcons = [
    { id: 'sc1', type: '鳶業者' },
    { id: 'sc2', type: '土工業者' },
  ]

  it('鳶合計 = とび+見習い+職長+役員+外注鳶 / 土工合計 = 土工+外注土工', () => {
    const workerEntries = {
      '1': { 1: { w: 1, o: 2 } },   // 鳶
      '2': { 1: { w: 1 } },         // 職長 → 鳶合計
      '3': { 1: { w: 1, o: 1 } },   // 土工
      '5': { 1: { w: 1 } },         // 役員 → 鳶合計
      '6': { 1: { w: 1 } },         // 鳶見習い → 鳶合計
    }
    const subconEntries = {
      sc1: { 1: { n: 2, on: 1 } },  // 外注鳶
      sc2: { 1: { n: 1, on: 0 } },  // 外注土工
    }
    const f = computeFooterSums(1, workers, subcons, workerEntries, subconEntries)
    expect(f.tobi[1]).toBe(6)      // 1+1+1(役員)+1(見習い) + 外注鳶2
    expect(f.doko[1]).toBe(2)      // 1 + 外注土工1
    expect(f.grand[1]).toBe(8)
    expect(f.tobiOt[1]).toBe(3)    // 残業2 + 外注鳶残業1
    expect(f.dokoOt[1]).toBe(1)
    expect(f.grandOt[1]).toBe(4)   // 2+1(ワーカー) + 1(外注鳶on)
    expect(f.tobiTotal).toBe(6)
    expect(f.grandTotal).toBe(8)
  })

  it('外国人の補償(0.6)は人工数から除外、日本人の0.6は含む', () => {
    const workerEntries = {
      '4': { 1: { w: 0.6 } },  // 外国人 → 除外
      '3': { 2: { w: 0.6 } },  // 日本人土工 → 0.6計上
    }
    const f = computeFooterSums(2, workers, subcons, workerEntries, {})
    expect(f.doko[1]).toBe(0)
    expect(f.grand[1]).toBe(0)
    expect(f.doko[2]).toBe(0.6)
    expect(f.grandTotal).toBe(0.6)
  })

  it('残骸データガード: 有給/帰国/欠勤/現場休/試験フラグ付きは人工にカウントしない', () => {
    const workerEntries = {
      '1': {
        1: { w: 1, p: 1 },     // 有給残骸
        2: { w: 1, hk: 1 },    // 帰国残骸
        3: { w: 1, r: 1 },     // 欠勤残骸
        4: { w: 1, h: 1 },     // 現場休残骸
        5: { w: 1, exam: 1 },  // 試験残骸
        6: { w: 1 },           // 正常
      },
    }
    const f = computeFooterSums(6, workers, subcons, workerEntries, {})
    expect(f.tobiTotal).toBe(1)   // 正常な1日分のみ
    expect(f.grandTotal).toBe(1)
  })

  it('外注typeの表記ゆれ（tobi/鳶/鳶業者）に対応', () => {
    const scs = [
      { id: 'a', type: 'tobi' },
      { id: 'b', type: '鳶' },
      { id: 'c', type: 'doko' },
    ]
    const subconEntries = {
      a: { 1: { n: 1, on: 0 } },
      b: { 1: { n: 1, on: 0 } },
      c: { 1: { n: 1, on: 0 } },
    }
    const f = computeFooterSums(1, [], scs, {}, subconEntries)
    expect(f.tobi[1]).toBe(2)
    expect(f.doko[1]).toBe(1)
    expect(f.grand[1]).toBe(3)
  })
})

describe('警告の収集', () => {
  const workers = [{ id: 1, name: '日本 太郎' }]

  it('日曜出勤を検出（有給は除外）', () => {
    // 2026年6月: 日曜 = 7, 14, 21, 28
    const warnings = collectSundayWarnings(2026, 6, 30, workers, {
      '1': {
        7: { w: 1 },          // 日曜出勤 → 警告
        14: { w: 1, p: 1 },   // 有給 → 除外
        8: { w: 1 },          // 月曜 → 対象外
      },
    })
    expect(warnings).toEqual([{ workerName: '日本 太郎', day: 7 }])
  })

  it('カレンダー休日の出勤を検出', () => {
    const warnings = collectHolidayWorkWarnings(30, { '10': 'off', '11': 'holiday', '12': 'work' }, workers, {
      '1': { 10: { w: 1 }, 11: { w: 0.5 }, 12: { w: 1 } },
    })
    expect(warnings).toEqual([
      { workerName: '日本 太郎', day: 10, dayType: '休日' },
      { workerName: '日本 太郎', day: 11, dayType: '祝日' },
    ])
  })

  it('カレンダー未設定なら休日警告なし', () => {
    expect(collectHolidayWorkWarnings(30, null, workers, { '1': { 10: { w: 1 } } })).toEqual([])
  })
})

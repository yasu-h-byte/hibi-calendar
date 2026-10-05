import { describe, test, expect } from 'vitest'
import { buildConfirmReminderText, reminderDueDate, reminderTargets, reminderWaiting, type ReminderPerson } from '@/lib/confirm-reminder'

// 出面の本人確認の催促（2026-10-05）。確認が出てから3日たっても押していない人だけ。名前は架空
const TODAY = '2026-10-05'
const people: ReminderPerson[] = [
  { workerId: 205, name: 'ビン', nameVi: 'NGUYEN VAN BINH', state: 'stale', since: '2026-10-01' },
  { workerId: 101, name: 'アン', nameVi: 'TRAN VAN AN', state: 'none', since: '2026-10-02' },   // ちょうど3日目
  { workerId: 102, name: 'クオン', state: 'early' },                                            // 起点が分からない → 待たせない
  { workerId: 107, name: 'タム', nameVi: 'HO VAN TAM', state: 'none', since: '2026-10-03' },    // まだ2日
  { workerId: 103, name: 'ズン', nameVi: 'LE VAN DUNG', state: 'waiting' },
  { workerId: 104, name: 'ハイ', nameVi: 'PHAM VAN HAI', state: 'issue' },
  { workerId: 105, name: 'ロン', nameVi: 'DO VAN LONG', state: 'ok' },
  { workerId: 106, name: 'ミン', nameVi: 'VU VAN MINH', state: 'outside' },
]

describe('本人確認の催促', () => {
  test('催促は確認が出た日から3日（暦日）たってから。10/2 に出たら 10/5 から', () => {
    expect(reminderDueDate({ workerId: 1, name: 'x', state: 'none', since: '2026-10-02' })).toBe('2026-10-05')
    expect(reminderDueDate({ workerId: 1, name: 'x', state: 'none', since: '2026-09-29' })).toBe('2026-10-02')
    expect(reminderDueDate({ workerId: 1, name: 'x', state: 'none' })).toBe('')
  })
  test('催促する人: 3日たった人と起点が分からない人。番号順・会社で分けない', () => {
    expect(reminderTargets(people, TODAY).map(p => p.workerId)).toEqual([101, 102, 205])
    expect(reminderTargets(people, '2026-10-04').map(p => p.workerId)).toEqual([102, 205])
  })
  test('3日たっていない人は「確認待ち」（文面に入れない）。承認待ち・連絡あり・確認ずみ・期間外はどちらにも入らない', () => {
    expect(reminderWaiting(people, TODAY).map(p => p.workerId)).toEqual([107])
    expect(reminderWaiting(people, '2026-10-06')).toEqual([])
  })
  test('文面: 催促する人の名前を1人ずつ。それ以外の人は入れない', () => {
    const t = buildConfirmReminderText({ ym: '202609', people, todayIso: TODAY })
    expect(t).toContain('・TRAN VAN AN（アン）')
    expect(t).toContain('・クオン')
    expect(t).toContain('・NGUYEN VAN BINH（ビン） ※')
    for (const n of ['タム', 'ズン', 'ハイ', 'ロン', 'ミン']) expect(t).not.toContain(n)
    expect(t).toContain('tháng 9')
    expect(t).toContain('9月分')
    expect(t).toContain('3日')
    expect(t).toContain('今日中に')
  })
  test('催促する人がいなければ空（3日以内の人だけのとき）', () => {
    expect(buildConfirmReminderText({ ym: '202609', people: people.filter(p => p.workerId === 107), todayIso: TODAY })).toBe('')
  })
})

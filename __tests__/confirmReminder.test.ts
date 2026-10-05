import { describe, test, expect } from 'vitest'
import { buildConfirmReminderText, isReminderUrgent, reminderTargets, type ReminderPerson } from '@/lib/confirm-reminder'

// 出面の本人確認をお願いする文面（2026-10-05）。名前は架空
const people: ReminderPerson[] = [
  { workerId: 205, name: 'ビン', nameVi: 'NGUYEN VAN BINH', state: 'stale' },
  { workerId: 101, name: 'アン', nameVi: 'TRAN VAN AN', state: 'none' },
  { workerId: 102, name: 'クオン', state: 'early' },
  { workerId: 103, name: 'ズン', nameVi: 'LE VAN DUNG', state: 'waiting' },
  { workerId: 104, name: 'ハイ', nameVi: 'PHAM VAN HAI', state: 'issue' },
  { workerId: 105, name: 'ロン', nameVi: 'DO VAN LONG', state: 'ok' },
  { workerId: 106, name: 'ミン', nameVi: 'VU VAN MINH', state: 'outside' },
]

describe('本人確認のお願いの文面', () => {
  test('入れるのはスマホに確認が出ている人だけ（まだ・承認前に押しただけ・要再確認）。会社で分けず番号順', () => {
    expect(reminderTargets(people).map(p => p.workerId)).toEqual([101, 102, 205])
  })
  test('名前を1人ずつ入れる。承認待ち・連絡あり・確認ずみ・期間外の人は入れない', () => {
    const t = buildConfirmReminderText({ ym: '202609', people, urgent: false })
    expect(t).toContain('・TRAN VAN AN（アン）')
    expect(t).toContain('・クオン')
    expect(t).toContain('・NGUYEN VAN BINH（ビン） ※')
    for (const n of ['ズン', 'ハイ', 'ロン', 'ミン']) expect(t).not.toContain(n)
    expect(t).toContain('tháng 9')
    expect(t).toContain('9月分')
    expect(t).not.toContain('至急')
  })
  test('急ぎの文は「至急」「今日中に」', () => {
    const t = buildConfirmReminderText({ ym: '202609', people, urgent: true })
    expect(t).toContain('至急')
    expect(t).toContain('今日中に')
    expect(t).toContain('ngay hôm nay')
  })
  test('対象がいなければ空', () => {
    expect(buildConfirmReminderText({ ym: '202609', people: people.filter(p => p.state === 'ok'), urgent: true })).toBe('')
  })
  test('翌月5日から急ぎ（12月分は翌年1月5日から）', () => {
    expect(isReminderUrgent('202609', '2026-10-04')).toBe(false)
    expect(isReminderUrgent('202609', '2026-10-05')).toBe(true)
    expect(isReminderUrgent('202612', '2026-12-31')).toBe(false)
    expect(isReminderUrgent('202612', '2027-01-05')).toBe(true)
  })
})

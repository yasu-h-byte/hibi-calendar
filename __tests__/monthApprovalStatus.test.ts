import { describe, test, expect, vi } from 'vitest'
vi.mock('@/lib/firebase', () => ({ db: {} }))
// 承認と就業カレンダーだけを返す偽の Firestore
const store: Record<string, unknown> = {
  'siteCalendar/s_2026-09': { status: 'approved', days: { 1: 'work', 2: 'work', 3: 'work', 4: 'off' } },
  'siteCalendar/s_2026-08': { status: 'approved', days: { 1: 'work', 2: 'work', 3: 'work', 4: 'off' } },
  'attendanceApprovals/s_202609_1': { foreman: {}, final: {} },
  'attendanceApprovals/s_202609_2': { foreman: {} },               // 休みだけの日: 最終承認がまだ
  'attendanceApprovals/s_202608_1': { foreman: {} },
}
vi.mock('@/lib/fsdb', () => ({
  doc: (_db: unknown, c: string, id: string) => `${c}/${id}`,
  getDoc: async (p: string) => ({ exists: () => !!store[p], data: () => store[p] }),
  setDoc: async () => {},
  registerMainWriteHook: () => {},   // lib/compute が読み込み時に呼ぶ
}))
import { monthApprovalStatus } from '@/lib/month-approval-status'

// 締めの承認範囲（2026-10-02 代表決定・案B）: 9月分からは本人確認と同じ日（休み・有給・0.6補・未入力の仕事の日も）
const main = { workers: [{ id: 101, org: 'hibi', visa: 'jisshu' }, { id: 201, org: 'hfu', visa: 'jisshu' }], sites: [{ id: 's' }] }
const d = (ym: string) => ({
  [`s_101_${ym}_1`]: { w: 1 },   // 出勤
  [`s_101_${ym}_2`]: { s: 'r' }, // 休みだけ
  // 3日は記録なし（カレンダーでは仕事の日）
})

describe('月締めの承認範囲', () => {
  test('2026-09 分から: 休みだけの日・未入力の仕事の日も承認が必要（本人確認と同じ）', async () => {
    const ap = await monthApprovalStatus(main, d('202609'), '202609', 'hibi')
    expect(ap.needed).toBe(3)
    expect(ap.gap.foremanMissing).toEqual([{ familyId: 's', day: 3 }])
    expect(ap.gap.finalMissing).toEqual([{ familyId: 's', day: 2 }, { familyId: 's', day: 3 }])
    expect(ap.complete).toBe(false)
  })
  test('会社で絞る（HFU の人の記録が無ければ対象の日も無い）', async () => {
    const ap = await monthApprovalStatus(main, d('202609'), '202609', 'hfu')
    expect(ap).toMatchObject({ needed: 0, complete: true })
  })
  test('2026-08 分まで: 出勤・残業のある日だけ・職長承認だけ（当時の決まり）', async () => {
    const ap = await monthApprovalStatus(main, d('202608'), '202608', 'hibi')
    expect(ap.needed).toBe(1)
    expect(ap.complete).toBe(true)
  })
})

/**
 * 退職の判定と、スマホURL（合言葉）の有効期間（lib/workers.ts・2026-10-02 総合点検）
 *
 * - 古いデータの retired: 'true'（日付の形でない値）は「退職済み」（旧: 文字列比較で必ず在籍になっていた）
 * - 退職「予定」日（未来）は在籍。退職日の当日まで在籍
 * - 合言葉は 在籍中=使える／退職した月の翌月末まで=見るだけ（allowGrace の入口だけ）／それ以降=使えない
 * - 代表(0)・政仁さん(1)・役員・事務は「管理者側の人」（合言葉は代表だけが扱う）
 */
import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/firebase', () => ({ db: {} }))
vi.mock('@/lib/fsdb', () => ({ doc: () => ({}), getDoc: async () => ({ exists: () => false }) }))

import {
  retiredDateOf, isAlreadyRetired, isStillActiveForMonth, isEmployedOn, isToolBudgetEligible,
  staffTokenStateOf, findWorkerByToken, isOfficeSideWorker,
} from '@/lib/workers'

describe('退職日の形', () => {
  test('YYYY-MM-DD だけを日付とみなす', () => {
    expect(retiredDateOf('2026-09-30')).toBe('2026-09-30')
    expect(retiredDateOf('true')).toBeNull()
    expect(retiredDateOf(true)).toBeNull()
    expect(retiredDateOf('')).toBeNull()
    expect(retiredDateOf(undefined)).toBeNull()
  })
  test("古い 'true' は退職済み（isAlreadyRetired / isStillActiveForMonth / isEmployedOn）", () => {
    expect(isAlreadyRetired('true', '2026-10-02')).toBe(true)
    expect(isAlreadyRetired(true as unknown as string, '2026-10-02')).toBe(true)
    expect(isStillActiveForMonth('true', '202610')).toBe(false)
    expect(isEmployedOn({ retired: 'true' }, '2026-10-02')).toBe(false)
  })
  test('退職予定日が未来なら在籍。当日まで在籍・翌日から退職', () => {
    expect(isAlreadyRetired('2099-12-31', '2026-10-02')).toBe(false)
    expect(isAlreadyRetired('2026-10-02', '2026-10-02')).toBe(false)
    expect(isAlreadyRetired('2026-10-01', '2026-10-02')).toBe(true)
    expect(isAlreadyRetired('', '2026-10-02')).toBe(false)
  })
  test('isToolBudgetEligible は渡した基準日で退職を判定する（旧: 今日で判定していた）', () => {
    const w = { visa: 'jisshu2', job: 'tobi', retired: '2026-09-30', hireDate: '2024-01-01' }
    expect(isToolBudgetEligible(w, '2026-09-30')).toBe(true)
    expect(isToolBudgetEligible(w, '2026-10-01')).toBe(false)
  })
})

describe('スマホURL（合言葉）の有効期間', () => {
  const w = (retired: string) => ({ token: 'abc', retired })
  test('在籍中は active', () => {
    expect(staffTokenStateOf(w(''), '2026-10-02')).toBe('active')
    expect(staffTokenStateOf(w('2026-10-02'), '2026-10-02')).toBe('active')
    expect(staffTokenStateOf(w('2026-10-31'), '2026-10-02')).toBe('active')
  })
  test('退職の翌日から、退職した月の翌月末までは grace。その後は expired', () => {
    expect(staffTokenStateOf(w('2026-09-30'), '2026-10-01')).toBe('grace')
    expect(staffTokenStateOf(w('2026-09-30'), '2026-10-31')).toBe('grace')
    expect(staffTokenStateOf(w('2026-09-30'), '2026-11-01')).toBe('expired')
    expect(staffTokenStateOf(w('2026-09-10'), '2026-10-31')).toBe('grace')
    expect(staffTokenStateOf(w('2026-09-10'), '2026-11-01')).toBe('expired')
  })
  test("古い 'true' は expired", () => {
    expect(staffTokenStateOf(w('true'), '2026-10-02')).toBe('expired')
  })
  test('findWorkerByToken: 既定は在籍中だけ。allowGrace で猶予中も。空の合言葉は誰にも一致しない', () => {
    const workers = [
      { id: 1, token: 'a', retired: '' },
      { id: 2, token: 'b', retired: '2026-09-30' },
      { id: 3, token: 'c', retired: '2026-06-30' },
      { id: 4, token: '', retired: '' },
    ]
    const today = '2026-10-02'
    expect(findWorkerByToken(workers, 'a', { todayIso: today })?.id).toBe(1)
    expect(findWorkerByToken(workers, 'b', { todayIso: today })).toBeNull()
    expect(findWorkerByToken(workers, 'b', { todayIso: today, allowGrace: true })?.id).toBe(2)
    expect(findWorkerByToken(workers, 'c', { todayIso: today, allowGrace: true })).toBeNull()
    expect(findWorkerByToken(workers, '', { todayIso: today })).toBeNull()
    expect(findWorkerByToken(workers, null, { todayIso: today })).toBeNull()
    expect(findWorkerByToken(workers, 'zzz', { todayIso: today })).toBeNull()
  })
})

describe('管理者側の人', () => {
  test('代表(0)・政仁さん(1)・役員・事務。職長・とびは違う', () => {
    expect(isOfficeSideWorker({ id: 0, jobType: 'yakuin' })).toBe(true)
    expect(isOfficeSideWorker({ id: 1, jobType: 'yakuin' })).toBe(true)
    expect(isOfficeSideWorker({ id: 7, jobType: 'yakuin' })).toBe(true)
    expect(isOfficeSideWorker({ id: 303, job: 'jimu' })).toBe(true)
    expect(isOfficeSideWorker({ id: 2, jobType: 'shokucho' })).toBe(false)
    expect(isOfficeSideWorker({ id: 104, jobType: 'tobi' })).toBe(false)
  })
})

/**
 * 人員の項目の仕分け（lib/workers.ts・2026-10-02）。新しい項目は「給与」か「それ以外」に必ず仕分ける
 */
import { describe, test, expect } from 'vitest'
import { mapRawWorkers, WORKER_PAY_KEYS, WORKER_OFFICE_KEYS, WORKER_PUBLIC_KEYS } from '@/lib/workers'

const full = {
  id: 1, name: 'x', nameVi: 'x', org: 'hibi', visa: 'jisshu', token: 't', job: 'tobi', rate: 1, hourlyRate: 1, otMul: 1.25,
  hireDate: '2020-01-01', retired: '', salary: 1, visaExpiry: '2027-01-01', dispatchTo: '', dispatchFrom: '', useOldRules: true,
  payrollNo: '1', birthDate: '2000-01-01', jpGrade: '1G', jpStep: 1, rateFrom: '2026-10-01', prevRate: 1, prevJpStep: 1,
  hourlyRateFrom: '2026-10-01', prevHourlyRate: 1, salaryFrom: '2026-10-01', scheduledChanges: [], appliedChanges: [], prevSalary: 1,
  canDrive: true, nonSmoker: true, children: [], breakShortenMin: 20, breakShortenFrom: '202608', memo: 'm',
}

describe('人員の項目の仕分け', () => {
  test('全項目が「給与」か「給与以外」のどちらかに入っている', () => {
    const keys = Object.keys(mapRawWorkers([full])[0])
    const known = new Set<string>([...WORKER_PAY_KEYS, ...WORKER_OFFICE_KEYS])
    expect(keys.filter(k => !known.has(k))).toEqual([])
  })
  test('給与の項目は事務・職長向けの一覧に入っていない', () => {
    for (const k of WORKER_PAY_KEYS) {
      expect((WORKER_OFFICE_KEYS as readonly string[]).includes(k), k).toBe(false)
      expect((WORKER_PUBLIC_KEYS as readonly string[]).includes(k), k).toBe(false)
    }
  })
  test('事務向けにはスマホURL・在留期限が入る（人員マスタ・書類庫で使う）', () => {
    expect(WORKER_OFFICE_KEYS).toContain('token')
    expect(WORKER_OFFICE_KEYS).toContain('visaExpiry')
  })
})

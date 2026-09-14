import { describe, test, expect } from 'vitest'
import { applyScheduledChangesToWorkers } from '@/lib/worker-crud'

describe('日付指定の人員マスタ変更', () => {
  const workers = [
    { id: 103, name: 'ファン', visa: 'tokutei1', scheduledChanges: [{ field: 'visa' as const, value: 'tokutei2', from: '2026-10-01' }] },
    { id: 102, name: 'トゥアン', visa: 'tokutei2' },
  ]
  test('適用日の前日は何も変えない', () => {
    const r = applyScheduledChangesToWorkers(workers, '2026-09-30', 'x')
    expect(r.applied).toEqual([])
    expect(r.workers[0].visa).toBe('tokutei1')
  })
  test('適用日に反映し、履歴へ移す', () => {
    const r = applyScheduledChangesToWorkers(workers, '2026-10-01', '2026-09-30T17:00:00Z')
    expect(r.workers[0].visa).toBe('tokutei2')
    expect(r.workers[0].scheduledChanges).toBeUndefined()
    expect(r.workers[0].appliedChanges).toEqual([{ field: 'visa', value: 'tokutei2', from: '2026-10-01', appliedAt: '2026-09-30T17:00:00Z', prevValue: 'tokutei1' }])
    expect(r.workers[1]).toBe(workers[1])
  })
  test('許可リスト外の項目は反映しない', () => {
    const w = [{ id: 1, name: 'x', hourlyRate: 1000, scheduledChanges: [{ field: 'hourlyRate' as unknown as 'visa', value: '9999', from: '2026-01-01' }] }]
    const r = applyScheduledChangesToWorkers(w, '2026-10-01', 'x')
    expect(r.applied).toEqual([])
    expect(r.workers[0].hourlyRate).toBe(1000)
  })
})

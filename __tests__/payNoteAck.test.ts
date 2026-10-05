import { describe, test, expect } from 'vitest'
import { splitIssuesByAck, summarizeOpenIssues, payNoteAckId, type PayNoteAck } from '@/lib/pay-note-ack'
import type { PayrollValidationIssue } from '@/lib/payroll-validator'

// 給与チェックの注意点を「確認した」と残す（2026-10-05）。名前は架空
const warn = (workerId: number, field: string, message: string): PayrollValidationIssue =>
  ({ severity: 'warning', workerId, workerName: `人${workerId}`, field, message })
const crit = (workerId: number, field: string, message: string): PayrollValidationIssue =>
  ({ severity: 'critical', workerId, workerName: `人${workerId}`, field, message })
const ack = (workerId: number, code: string, message: string): PayNoteAck =>
  ({ ym: '202609', workerId, code, message, by: '0', byName: '代表', at: '2026-10-05T03:00:00Z' })

describe('注意点の「確認した」', () => {
  const issues = [
    warn(206, 'midMonthRateOt', '約 54円 少ない計算です'),
    warn(107, 'blankDays', '記録が無い日が 1日 あります'),
    crit(201, 'otAllowance', '法定外残業が不足'),
  ]
  test('確認が無ければ全部が未確認', () => {
    const r = splitIssuesByAck(issues, [])
    expect(r.open).toHaveLength(3)
    expect(r.acked).toEqual([])
  })
  test('同じ人・同じ種類・同じ文面の注意点だけが確認済みになる', () => {
    const r = splitIssuesByAck(issues, [ack(206, 'midMonthRateOt', '約 54円 少ない計算です')])
    expect(r.acked.map(i => i.workerId)).toEqual([206])
    expect(r.acked[0].ack.byName).toBe('代表')
    expect(r.open.map(i => i.workerId)).toEqual([107, 201])
  })
  test('確認したあとで文面（金額・日数）が変わったら、未確認に戻る', () => {
    const r = splitIssuesByAck(issues, [ack(206, 'midMonthRateOt', '約 30円 少ない計算です')])
    expect(r.acked).toEqual([])
    expect(r.open).toHaveLength(3)
  })
  test('異常（critical）は確認があっても消えない', () => {
    const r = splitIssuesByAck(issues, [ack(201, 'otAllowance', '法定外残業が不足')])
    expect(r.open.some(i => i.workerId === 201)).toBe(true)
    expect(r.acked).toEqual([])
  })
  test('別の人・別の種類の確認は効かない', () => {
    expect(splitIssuesByAck(issues, [ack(107, 'midMonthRateOt', '約 54円 少ない計算です')]).acked).toEqual([])
    expect(splitIssuesByAck(issues, [ack(206, 'blankDays', '約 54円 少ない計算です')]).acked).toEqual([])
  })
  test('件数は未確認だけを数える（帯・メニューの数字・締めの前の確認が同じ数）', () => {
    const s = summarizeOpenIssues(issues, [ack(206, 'midMonthRateOt', '約 54円 少ない計算です'), ack(107, 'blankDays', '記録が無い日が 1日 あります')])
    expect(s.total).toBe(1)
    expect(s.critical).toBe(1)
    expect(s.warning).toBe(0)
    expect(s.affectedWorkerIds).toEqual([201])
    expect(s.acked).toHaveLength(2)
  })
  test('確認の記録の ID は 月_人_種類', () => {
    expect(payNoteAckId('202609', 206, 'midMonthRateOt')).toBe('202609_206_midMonthRateOt')
  })
})

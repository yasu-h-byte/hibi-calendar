/**
 * 就業カレンダーの「誰が・いつ」提出し、最終承認したか（lib/calendar-approval-trail.ts・2026-10-22）
 *
 * - 画面の1行（提出: 名前 M/D HH:MM ／ 最終承認: …）は状態ごとに決まった文になる
 * - 古い月（項目が無い）は「記録なし」
 * - 代表（ID 0）が `|| null` で消えない
 * - 履歴は台帳（calendarStatusLog）が正本。台帳より古い分だけ siteCalendar の項目から補う
 * - 時刻は日本時間（サーバ＝UTC でもずれない）
 */
import { describe, test, expect } from 'vitest'
import {
  fmtJstStamp, fmtJstStampLong, actorLabel, buildApprovalTrailLines, approvalTrailText,
  synthesizeTrailFromDoc, mergeTrailHistory, trailEntryText, wasRevisedAfterApproval,
  type CalendarTrailFields, type CalendarTrailEntry,
} from '@/lib/calendar-approval-trail'

describe('fmtJstStamp', () => {
  test('UTC の ISO を日本時間の M/D HH:MM にする（日付をまたぐ）', () => {
    expect(fmtJstStamp('2026-10-21T18:05:00.000Z')).toBe('10/22 03:05')
    expect(fmtJstStamp('2026-10-21T09:05:00.000Z')).toBe('10/21 18:05')
    expect(fmtJstStampLong('2026-10-21T09:05:00.000Z')).toBe('2026/10/21 18:05')
  })
  test('読めない・空は空文字', () => {
    expect(fmtJstStamp(null)).toBe('')
    expect(fmtJstStamp('')).toBe('')
    expect(fmtJstStamp('abc')).toBe('')
  })
})

describe('actorLabel', () => {
  test('名前 → ID → 記録なし の順', () => {
    expect(actorLabel(5, '大川')).toBe('大川')
    expect(actorLabel(5, null)).toBe('ID:5')
    expect(actorLabel(0, null)).toBe('ID:0')     // 代表は ID 0。null と区別する
    expect(actorLabel(null, null)).toBe('記録なし')
  })
})

const SUBMIT = { submittedBy: 7, submittedAt: '2026-10-21T09:05:00Z', submittedByName: '大川' }
const APPROVE = { approvedBy: 1, approvedAt: '2026-10-22T00:10:00Z', approvedByName: '日比政仁' }

describe('buildApprovalTrailLines（画面の1行）', () => {
  test('承認済み: 提出と最終承認', () => {
    const cal: CalendarTrailFields = { status: 'approved', ...SUBMIT, ...APPROVE }
    expect(approvalTrailText(cal)).toBe('提出: 大川 10/21 18:05 ／ 最終承認: 日比政仁 10/22 09:10')
    expect(buildApprovalTrailLines(cal).map(l => l.tone)).toEqual(['blue', 'green'])
  })
  test('承認待ち: 最終承認は「承認待ち」', () => {
    expect(approvalTrailText({ status: 'submitted', ...SUBMIT })).toBe('提出: 大川 10/21 18:05 ／ 最終承認: 承認待ち')
  })
  test('承認を取り消して承認待ちに戻した: その旨を添える', () => {
    const cal: CalendarTrailFields = { status: 'submitted', ...SUBMIT, revertedBy: 0, revertedAt: '2026-10-22T02:00:00Z', revertedByName: '日比靖仁' }
    expect(approvalTrailText(cal)).toBe('提出: 大川 10/21 18:05 ／ 最終承認: 承認待ち（承認の取り消し 日比靖仁 10/22 11:00）')
  })
  test('差し戻し: 誰が・いつ・理由', () => {
    const cal: CalendarTrailFields = { status: 'rejected', ...SUBMIT, rejectedBy: 1, rejectedAt: '2026-10-22T01:00:00Z', rejectedByName: '日比政仁', rejectedReason: '第2土曜を出勤に' }
    expect(approvalTrailText(cal)).toBe('提出: 大川 10/21 18:05 ／ 差し戻し: 日比政仁 10/22 10:00（第2土曜を出勤に）')
  })
  test('作成中・未作成: 提出は「まだ」', () => {
    expect(approvalTrailText({ status: 'draft' })).toBe('提出: まだ ／ 最終承認: まだ')
    expect(approvalTrailText(null)).toBe('提出: まだ ／ 最終承認: まだ')
  })
  test('提出を取り消して作成中に戻した', () => {
    const cal: CalendarTrailFields = { status: 'draft', revertedBy: 1, revertedAt: '2026-10-22T01:00:00Z', revertedByName: '日比政仁' }
    expect(approvalTrailText(cal)).toBe('提出: 取り消し 日比政仁 10/22 10:00 ／ 最終承認: まだ')
  })
  test('古い月: 承認済みだが項目が無い → 記録なし', () => {
    expect(approvalTrailText({ status: 'approved' })).toBe('提出: 記録なし ／ 最終承認: 記録なし')
    expect(buildApprovalTrailLines({ status: 'approved' }).map(l => l.tone)).toEqual(['gray', 'gray'])
  })
  test('ID だけ残っていて名前が引けない → ID:n（0 も出る）', () => {
    const cal: CalendarTrailFields = { status: 'approved', submittedBy: 7, submittedAt: SUBMIT.submittedAt, approvedBy: 0, approvedAt: APPROVE.approvedAt }
    expect(approvalTrailText(cal)).toBe('提出: ID:7 10/21 18:05 ／ 最終承認: ID:0 10/22 09:10')
  })
  test('承認後の修正は3つ目の項目に出る', () => {
    const cal: CalendarTrailFields = { status: 'approved', ...SUBMIT, ...APPROVE, updatedBy: 1, updatedAt: '2026-10-25T03:00:00Z', updatedByName: '日比政仁' }
    expect(wasRevisedAfterApproval(cal)).toBe(true)
    expect(approvalTrailText(cal)).toBe('提出: 大川 10/21 18:05 ／ 最終承認: 日比政仁 10/22 09:10 ／ 承認後の修正: 日比政仁 10/25 12:00')
    // 承認と同時刻の updatedAt（一括確定）は修正ではない
    expect(wasRevisedAfterApproval({ ...cal, updatedAt: APPROVE.approvedAt })).toBe(false)
  })
})

describe('synthesizeTrailFromDoc（台帳を付ける前の月）', () => {
  test('項目から起こして古い順に並べる。取り消しは今の状態で見分ける', () => {
    const cal: CalendarTrailFields = {
      status: 'submitted', ...SUBMIT,
      rejectedBy: 1, rejectedAt: '2026-10-20T01:00:00Z', rejectedReason: '理由',
      revertedBy: 0, revertedAt: '2026-10-23T01:00:00Z',
    }
    const got = synthesizeTrailFromDoc(cal)
    expect(got.map(e => e.event)).toEqual(['reject', 'submit', 'unapprove'])
    expect(got.every(e => e.source === 'doc')).toBe(true)
    expect(got[0].reason).toBe('理由')
    expect(got[2].by).toBe(0)
    expect(synthesizeTrailFromDoc({ status: 'draft', revertedAt: '2026-10-23T01:00:00Z' })[0].event).toBe('unsubmit')
  })
  test('何も無ければ空', () => {
    expect(synthesizeTrailFromDoc(null)).toEqual([])
    expect(synthesizeTrailFromDoc({ status: 'approved' })).toEqual([])
  })
})

describe('mergeTrailHistory', () => {
  const log: CalendarTrailEntry[] = [
    { event: 'approve', at: '2026-10-22T00:10:00Z', by: 1, byName: '日比政仁', source: 'log' },
    { event: 'submit', at: '2026-10-21T09:05:00Z', by: 7, byName: '大川', source: 'log' },
  ]
  test('台帳があれば台帳が正本。台帳の最初より古い doc 由来だけ補う', () => {
    const docs: CalendarTrailEntry[] = [
      { event: 'submit', at: '2026-10-21T09:05:00Z', by: 7, byName: '大川', source: 'doc' },   // 台帳と同じ出来事 → 二重に出さない
      { event: 'reject', at: '2026-10-15T01:00:00Z', by: 1, byName: '日比政仁', source: 'doc' },  // 台帳より前 → 補う
    ]
    const got = mergeTrailHistory(log, docs)
    expect(got.map(e => `${e.event}:${e.source}`)).toEqual(['reject:doc', 'submit:log', 'approve:log'])
  })
  test('台帳が無ければ doc 由来だけ（古い順）', () => {
    const got = mergeTrailHistory([], [
      { event: 'approve', at: '2026-10-22T00:10:00Z', by: 1, byName: null, source: 'doc' },
      { event: 'submit', at: '2026-10-21T09:05:00Z', by: 7, byName: null, source: 'doc' },
    ])
    expect(got.map(e => e.event)).toEqual(['submit', 'approve'])
  })
})

describe('trailEntryText', () => {
  test('時刻・出来事・名前・理由・補足', () => {
    expect(trailEntryText({ event: 'reject', at: '2026-10-22T01:00:00Z', by: 1, byName: '日比政仁', reason: '第2土曜を出勤に', source: 'log' }))
      .toBe('2026/10/22 10:00 差し戻し 日比政仁 （第2土曜を出勤に）')
    expect(trailEntryText({ event: 'approve', at: '2026-10-22T01:00:00Z', by: 0, byName: null, note: '一括確定', source: 'log' }))
      .toBe('2026/10/22 10:00 最終承認 ID:0 〔一括確定〕')
  })
})

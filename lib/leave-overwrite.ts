import type { AttendanceEntry } from '@/types'
import { createsWork } from './attendance'

/** 出勤の入力を1行で（「07:30〜16:30 残業1h」） */
export function describeWork(e: AttendanceEntry): string {
  const times = e.st && e.et ? `${e.st}〜${e.et}` : `出勤 ${e.w ?? ''}`
  return `${times}${e.o ? ` 残業${e.o}h` : ''}`
}

/**
 * 有給で上書きする前の確認の文（2026-10-24）。
 * 旧: 「この日は最終承認が済んでいます。休暇管理の申請一覧から内容を確認のうえ承認してください」だけで、
 *     休暇管理の画面にいるのに休暇管理へ行けと言い、その人のその日に何が入っているか（空欄か出勤か）が分からず、
 *     上書きしてよいか判断できなかった。その人のその日の中身を必ず書く。画面の案内は呼び出し側（マイページ）が足す
 */
export function overwriteConfirmMessage(
  dateIso: string, workerName: string, own: AttendanceEntry | null,
  dayApproval: { foreman?: unknown; final?: unknown } | null, target: '' | '変更先の',
): string {
  const who = `${workerName}さん`
  const parts: string[] = []
  if (dayApproval) parts.push(`${target}この日は、現場の出面の${dayApproval.final ? '最終承認' : '職長承認'}が済んでいます`)
  const e = isBlankDay(own) ? null : own
  if (!e) {
    parts.push(`${who}のこの日の出面は空欄です（有給にしても消える記録はありません）`)
  } else if (createsWork(e)) {
    parts.push(`${who}のこの日は出勤の入力があります（${describeWork(e)}）。有給にすると出勤の記録が消えます`)
  } else if (e.r) {
    parts.push(`${who}のこの日は「欠」が入っています。有給にすると「欠」が有給に変わります`)
  } else if (e.w === 0.6) {
    parts.push(`${who}のこの日は「0.6補（現場都合休）」が入っています。有給にすると0.6補が有給に変わります`)
  } else if (e.hk) {
    parts.push(`${who}のこの日は帰国中の印が入っています。有給にすると、この日は帰国中ではなく有給になります`)
  } else {
    parts.push(`${who}のこの日の出面には入力があります`)
  }
  return `${dateIso}: ${parts.join('。')}`
}

/** その人のその日の出面が空欄か（出勤・欠・0.6補・帰国・有給のどれも入っていない） */
export function isBlankDay(own: AttendanceEntry | null | undefined): boolean {
  if (!own || Object.keys(own).length === 0) return true
  return !createsWork(own) && !own.r && own.w !== 0.6 && !own.hk && !own.p
}

/**
 * 有給で書き込む前に確認の窓を出すか（2026-10-24 代表決定・案A）。
 * - 本人の出勤の入力がある → 出す（出勤の記録が消える）
 * - その日の出面の承認が済んでいて、本人の欄に何か入っている（欠・0.6補・帰国など） → 出す
 * - その日の承認が済んでいても、本人の欄が空欄 → 出さない（消える記録が無い。書き込んだ記録は操作ログに残す）
 *   旧: 空欄でも「最終承認が済んでいます」で毎回確認が出て、政仁さんが自分で締めた日の有給を承認するたびに止まっていた
 */
export function needsOverwriteConfirm(
  own: AttendanceEntry | null | undefined,
  existingWork: AttendanceEntry | null,
  dayApproval: { foreman?: unknown; final?: unknown } | null,
): boolean {
  if (existingWork) return true
  return !!dayApproval && !isBlankDay(own)
}

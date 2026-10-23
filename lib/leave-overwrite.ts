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
  const e = own && Object.keys(own).length > 0 ? own : null
  if (!e || (!createsWork(e) && !e.r && e.w !== 0.6 && !e.hk && !e.p)) {
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

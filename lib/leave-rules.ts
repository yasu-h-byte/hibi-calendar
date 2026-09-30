/**
 * 有給の申請期限（2026-09-30 代表決定）
 *
 * 有給は**前日までに申請**する。当日・過ぎた日の申請はできない（日本人・ベトナム人とも）。
 * 旧: 申請 API は当日もOK（「当日有給申請に対応」）、スタッフの出面入力（choice='leave'）と
 * 職長の代理入力は過去の日にも有給を入れられた。スマホの申請画面だけ「5日後から」だったが、
 * サーバでは止めていなかった。
 *
 * 管理者（事務・事業責任者・代表）の出面入力（修正・時季指定）はこの制限の対象外。
 * 職長の出面グリッド入力は対象（app/api/attendance/grid・2026-09-30 点検）。
 */
import { addDaysIso } from './date-utils'

/** 有給を申請できる最初の日（今日の翌日） */
export function leaveRequestEarliestDate(todayIso: string): string {
  return addDaysIso(todayIso, 1)
}

export const LEAVE_REQUEST_DEADLINE_MESSAGE =
  '有給は前日までに申請してください。当日・過ぎた日は申請できません / Nghỉ phép phải xin trước 1 ngày. Không thể xin cho hôm nay hoặc ngày đã qua'

/** 申請できない日ならエラーメッセージ、できるなら null */
export function leaveRequestDateError(dateIso: string, todayIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return '日付が正しくありません'
  return dateIso < leaveRequestEarliestDate(todayIso) ? LEAVE_REQUEST_DEADLINE_MESSAGE : null
}

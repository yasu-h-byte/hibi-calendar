/**
 * 出面の本人確認をお願いする文面（2026-10-05 代表依頼）。
 *
 * ベトナム人スタッフのグループ（LINE など）へ一斉に送る文を、月次集計の画面のボタン1つで作る。
 * 一斉送信でも誰あてかが分かるように、まだの人の名前を1人ずつ入れる。日比建設と HFU は分けない（同じグループ）。
 *
 * **催促するのは、その人のスマホに確認が出てから3日たっても押していない人だけ**（同日 代表決定で統一）。
 *   - 起点（since）は「その人の出面の承認（職長・最終）がそろった日」。現場ごとに承認の早さが違っても、本人から見て同じ3日
 *   - 3日は暦日（10/2 にそろったら 10/5 から）。3日たつまでは画面に「確認待ち」とだけ出し、文面は作らない
 *   - 起点が分からない人（日時の無い古い承認だけ）は、待たせず催促の対象にする
 *   - 旧: 日付だけで「翌月5日から急ぎの文」に変えていた（承認が遅れた月は、確認が出た当日から至急になっていた）
 *
 * 対象の状態は「スマホに確認が出ているのに押していない人」だけ:
 *   none（まだ）・early（承認前に押しただけ）・stale（確認のあとで出面が変わった）
 * 入れない人: waiting（承認待ち＝スマホにまだ確認が出ていないので、頼まれても押せない）・
 *   issue（本人から連絡あり＝事務所が対応する番）・outside（期間外）・ok
 * 状態と起点は lib/attendance-confirm-server.ts が決める（ここでは決め直さない）。
 */
import { addDaysIso } from './date-utils'

export type ReminderState = 'ok' | 'none' | 'early' | 'stale' | 'issue' | 'waiting' | 'outside'

export interface ReminderPerson {
  workerId: number
  name: string
  nameVi?: string
  state: ReminderState
  /** スマホに確認（再確認）が出た日（YYYY-MM-DD）。分からなければ無い */
  since?: string
}

/** 文面に名前を入れる状態（スマホに確認が出ている人） */
export const REMINDER_STATES: readonly ReminderState[] = ['none', 'early', 'stale']

/** 確認が出てから催促するまでの日数（暦日） */
export const REMINDER_WAIT_DAYS = 3

/** その人を催促し始める日（起点が分からなければ ''＝もう催促してよい） */
export function reminderDueDate(p: ReminderPerson): string {
  return p.since ? addDaysIso(p.since, REMINDER_WAIT_DAYS) : ''
}

const byId = (a: ReminderPerson, b: ReminderPerson) => a.workerId - b.workerId
const pending = <P extends ReminderPerson>(people: P[]) => people.filter(p => REMINDER_STATES.includes(p.state))

/** 催促する人: 確認が出てから3日たっても押していない人（社員番号の順。会社では分けない） */
export function reminderTargets<P extends ReminderPerson>(people: P[], todayIso: string): P[] {
  return pending(people).filter(p => reminderDueDate(p) <= todayIso).sort(byId)
}

/** まだ3日たっていない人（画面に「確認待ち」と出すだけ。文面には入れない） */
export function reminderWaiting<P extends ReminderPerson>(people: P[], todayIso: string): P[] {
  return pending(people).filter(p => reminderDueDate(p) > todayIso).sort(byId)
}

/** 1人分の行: ベトナム語名があれば「ベトナム語名（日本語の呼び名）」 */
function nameLine(p: ReminderPerson): string {
  const vi = (p.nameVi || '').trim()
  const base = vi && vi !== p.name ? `${vi}（${p.name}）` : p.name
  return `・${base}${p.state === 'stale' ? ' ※xác nhận lại / もう一度' : ''}`
}

/** グループへ送る文面（ベトナム語 → 日本語の順。スタッフ向けは日越並記の決まり）。催促する人がいなければ '' */
export function buildConfirmReminderText(args: { ym: string; people: ReminderPerson[]; todayIso: string }): string {
  const month = Number(args.ym.slice(4, 6))
  const targets = reminderTargets(args.people, args.todayIso)
  if (targets.length === 0) return ''
  const hasStale = targets.some(p => p.state === 'stale')
  const head = `【Xác nhận chấm công tháng ${month} / ${month}月分の出面の確認】`
  const vi = [
    `Các bạn dưới đây chưa xác nhận chấm công tháng ${month}.`,
    `Đã hơn ${REMINDER_WAIT_DAYS} ngày kể từ khi phần xác nhận hiện trên điện thoại.`,
    'Hãy mở trang chấm công trên điện thoại và bấm "Đúng" ngay hôm nay.',
    'Nếu có chỗ sai, hãy bấm "Có sai" và ghi nội dung.',
    'Lương sẽ được tính theo số này.',
    ...(hasStale ? ['※ Chấm công đã thay đổi sau khi bạn xác nhận. Hãy xác nhận lại.'] : []),
  ]
  const ja = [
    `下の人は、${month}月分の出面の確認がまだです。`,
    `スマホに確認が出てから ${REMINDER_WAIT_DAYS}日 いじょう たっています。`,
    'スマホの出面の画面をひらいて、今日中に「正しい」をおしてください。',
    'まちがいがあるときは「まちがいがある」をおして、内容を書いてください。',
    'この数で給料を計算します。',
    ...(hasStale ? ['※ の人は、確認のあとで出面が変わりました。もう一度確認してください。'] : []),
  ]
  return [head, '', ...targets.map(nameLine), '', ...vi, '', ...ja].join('\n')
}

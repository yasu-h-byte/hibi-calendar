/**
 * 出面の本人確認をお願いする文面（2026-10-05 代表依頼）。
 *
 * ベトナム人スタッフのグループ（LINE など）へ一斉に送る文を、月次集計の画面のボタン1つで作る。
 * 一斉送信でも誰あてかが分かるように、まだの人の名前を1人ずつ入れる。日比建設と HFU は分けない（同じグループ）。
 *
 * 入れる人は「スマホに確認が出ているのに押していない人」だけ:
 *   none（まだ）・early（承認前に押しただけ）・stale（確認のあとで出面が変わった）
 * 入れない人: waiting（承認待ち＝スマホにまだ確認が出ていないので、頼まれても押せない）・
 *   issue（本人から連絡あり＝事務所が対応する番）・outside（期間外）・ok
 * 状態そのものは lib/attendance-confirm-server.ts が決める（ここでは決め直さない）。
 */

export type ReminderState = 'ok' | 'none' | 'early' | 'stale' | 'issue' | 'waiting' | 'outside'

export interface ReminderPerson {
  workerId: number
  name: string
  nameVi?: string
  state: ReminderState
}

/** 文面に名前を入れる状態（スマホに確認が出ている人） */
export const REMINDER_STATES: readonly ReminderState[] = ['none', 'early', 'stale']

/** 文面に入れる人（社員番号の順。会社では分けない） */
export function reminderTargets<P extends ReminderPerson>(people: P[]): P[] {
  return people.filter(p => REMINDER_STATES.includes(p.state)).sort((a, b) => a.workerId - b.workerId)
}

/**
 * 「急ぎ」の文にする日か: 確認する月の翌月5日を過ぎたら急ぎ（例: 9月分は 10月5日から）。
 * 翌々月以降に開いたときも急ぎ
 */
export function isReminderUrgent(ym: string, todayIso: string): boolean {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1
  return todayIso >= `${ny}-${String(nm).padStart(2, '0')}-05`
}

/** 1人分の行: ベトナム語名があれば「ベトナム語名（日本語の呼び名）」 */
function nameLine(p: ReminderPerson): string {
  const vi = (p.nameVi || '').trim()
  const base = vi && vi !== p.name ? `${vi}（${p.name}）` : p.name
  return `・${base}${p.state === 'stale' ? ' ※xác nhận lại / もう一度' : ''}`
}

/** グループへ送る文面（ベトナム語 → 日本語の順。スタッフ向けは日越並記の決まり） */
export function buildConfirmReminderText(args: { ym: string; people: ReminderPerson[]; urgent: boolean }): string {
  const month = Number(args.ym.slice(4, 6))
  const targets = reminderTargets(args.people)
  if (targets.length === 0) return ''
  const hasStale = targets.some(p => p.state === 'stale')
  const head = args.urgent
    ? `【GẤP / 至急】Xác nhận chấm công tháng ${month} / ${month}月分の出面の確認`
    : `【Xác nhận chấm công tháng ${month} / ${month}月分の出面の確認】`
  const vi = [
    `Các bạn dưới đây chưa xác nhận chấm công tháng ${month}.`,
    args.urgent
      ? 'Đã quá hạn. Hãy mở trang chấm công trên điện thoại và bấm "Đúng" ngay hôm nay.'
      : 'Hãy mở trang chấm công trên điện thoại, xem số ngày và bấm "Đúng".',
    'Nếu có chỗ sai, hãy bấm "Có sai" và ghi nội dung.',
    'Lương sẽ được tính theo số này.',
    ...(hasStale ? ['※ Chấm công đã thay đổi sau khi bạn xác nhận. Hãy xác nhận lại.'] : []),
  ]
  const ja = [
    `下の人は、${month}月分の出面の確認がまだです。`,
    args.urgent
      ? '期限をすぎています。スマホの出面の画面をひらいて、今日中に「正しい」をおしてください。'
      : 'スマホの出面の画面をひらいて、日数を見て「正しい」をおしてください。',
    'まちがいがあるときは「まちがいがある」をおして、内容を書いてください。',
    'この数で給料を計算します。',
    ...(hasStale ? ['※ の人は、確認のあとで出面が変わりました。もう一度確認してください。'] : []),
  ]
  return [head, '', ...targets.map(nameLine), '', ...vi, '', ...ja].join('\n')
}

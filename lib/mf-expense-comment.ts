/**
 * MF経費で差し戻すときのコメントの下書き（2026-11-09 代表）。
 * 要確認の指摘から、本人が直せることだけを文面にする。日本人は日本語、ベトナム人はベトナム語。
 * 定型文で作り、外部には何も送らない。MF には書かず、総務がコピーして MF の差し戻しに貼る。
 *
 * 文面にしない指摘: U1（総務の設定の話）・G1 / G2（道具代の対象・残額は代表の判断）・T3 / T4（参考）
 */
import type { MfExpenseFlag, MfExpenseTx, MfRuleId } from './mf-expense-rules'

export type MfCommentLang = 'ja' | 'vi'

const REJECT_RULES = new Set<MfRuleId>(['T1', 'D1', 'D2', 'R1', 'K1', 'G3'])

const WRAP: Record<MfCommentLang, { open: string; close: string }> = {
  ja: { open: 'お疲れさまです。次の点を確認して、直してからもう一度申請してください。', close: 'よろしくお願いします。' },
  vi: { open: 'Xin chào. Vui lòng kiểm tra các mục dưới đây, sửa lại rồi nộp lại đơn.', close: 'Xin cảm ơn.' },
}

const monthOf = (iso: string) => Number(iso.slice(5, 7))
const ymKey = (iso: string) => iso.slice(0, 7).replace('-', '')

function dateMessage(tx: MfExpenseTx, targetYm: string, today: string, lang: MfCommentLang): string {
  const ja = lang === 'ja'
  if (!tx.date) return ja ? '日付が入っていません。日付を入れてください。' : 'Chưa nhập ngày. Vui lòng nhập ngày.'
  if (tx.date > today) return ja ? '未来の日付になっています。日付を確認してください。' : 'Ngày này ở tương lai. Vui lòng kiểm tra lại ngày.'
  if (ymKey(tx.date) > targetYm) {
    const m = monthOf(tx.date)
    return ja ? `${m}月分の明細です。${m}月分の申請で出してください。` : `Đây là khoản của tháng ${m}. Vui lòng nộp trong đơn của tháng ${m}.`
  }
  return ja ? '申請の月より前の日付です。日付が正しいか確認してください。' : 'Ngày này thuộc tháng trước tháng của đơn. Vui lòng kiểm tra lại ngày.'
}

function ruleMessage(rule: MfRuleId, tx: MfExpenseTx, targetYm: string, today: string, lang: MfCommentLang): string {
  const ja = lang === 'ja'
  switch (rule) {
    case 'T1':
      return ja
        ? 'この日の出面がありません。休みだった場合は、この明細を消してください。出勤していた場合は、教えてください。'
        : 'Ngày này không có dữ liệu chấm công. Nếu hôm đó bạn nghỉ, vui lòng xóa khoản này. Nếu bạn có đi làm, vui lòng báo lại.'
    case 'D1':
      return dateMessage(tx, targetYm, today, lang)
    case 'D2':
      return ja
        ? '別の申請に同じ明細があります。二重になっていたら、消してください。'
        : 'Khoản này có vẻ bị trùng với một đơn khác. Nếu bị trùng, vui lòng xóa.'
    case 'R1':
      return ja ? '領収書が付いていません。領収書の写真を付けてください。' : 'Chưa đính kèm hóa đơn. Vui lòng đính kèm ảnh hóa đơn.'
    case 'K1':
      return ja
        ? '内容と科目が合っていないようです。科目を確認してください。'
        : 'Mục chi phí có vẻ không đúng với nội dung. Vui lòng kiểm tra lại mục chi phí.'
    case 'G3':
      return ja
        ? '「折半」「半額」とあります。領収書の金額と申請の金額を確認してください。'
        : 'Có ghi chia đôi hoặc một nửa. Vui lòng kiểm tra số tiền trên hóa đơn và số tiền đã nhập.'
    default:
      return ''
  }
}

function txHeading(tx: MfExpenseTx, lang: MfCommentLang): string {
  const date = tx.date ? tx.date.replace(/-/g, '/') : lang === 'ja' ? '日付なし' : 'Chưa có ngày'
  const amount = Math.round(tx.amount).toLocaleString('en-US')
  return `・${date} ${tx.itemName} ${amount}${lang === 'ja' ? '円' : ' yên'}`
}

/** 文面にできる指摘があるか（無ければ画面にボタンを出さない） */
export function hasMfRejectComment(flags: MfExpenseFlag[]): boolean {
  return flags.some(f => f.txId && REJECT_RULES.has(f.rule))
}

export function buildMfRejectComment(input: {
  flags: MfExpenseFlag[]
  txs: MfExpenseTx[]
  targetYm: string
  today: string
  lang: MfCommentLang
}): string {
  const { flags, txs, targetYm, today, lang } = input
  const blocks: string[] = []
  for (const tx of txs) {
    const rules = Array.from(new Set(flags.filter(f => f.txId === tx.id && REJECT_RULES.has(f.rule)).map(f => f.rule)))
    if (rules.length === 0) continue
    blocks.push([txHeading(tx, lang), ...rules.map(r => `  ${ruleMessage(r, tx, targetYm, today, lang)}`)].join('\n'))
  }
  if (blocks.length === 0) return ''
  return [WRAP[lang].open, ...blocks, WRAP[lang].close].join('\n\n')
}

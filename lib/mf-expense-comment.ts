/**
 * MF経費で差し戻すときのコメントの下書き（2026-11-09 代表）。
 * 要確認の指摘から、本人が直せることだけを文面にする。日本人は日本語、ベトナム人はベトナム語。
 * 定型文で作り、外部には何も送らない。MF には書かず、総務がコピーして MF の差し戻しに貼る。
 *
 * 文面にしない指摘: U2・X1（総務の設定・MF の読み取りの話）・U1（総務の設定の話）・G1 / G2（道具代の対象・残額は代表の判断）・T3 / T4（参考）
 */
import type { MfExpenseFlag, MfExpenseTx, MfRuleId } from './mf-expense-rules'

export type MfCommentLang = 'ja' | 'vi'

const REJECT_RULES = new Set<MfRuleId>(['T1', 'D1', 'D2', 'R1', 'R2', 'R3', 'R5', 'T5', 'T6', 'K1', 'K2', 'G3'])

const WRAP: Record<MfCommentLang, { open: string; close: string }> = {
  ja: { open: 'お疲れさまです。次の点を確認して、直してからもう一度申請してください。', close: 'よろしくお願いします。' },
  vi: { open: 'Xin chào. Vui lòng kiểm tra các mục dưới đây, sửa lại rồi nộp lại đơn.', close: 'Xin cảm ơn.' },
}

const monthOf = (iso: string) => Number(iso.slice(5, 7))
const ymKey = (iso: string) => iso.slice(0, 7).replace('-', '')

function dateMessage(tx: MfExpenseTx, targetYm: string, today: string, lang: MfCommentLang): string {
  const ja = lang === 'ja'
  if (!tx.date) return ja ? '日付が入っていません。日付を入れてください。' : 'Chưa nhập ngày. Vui lòng nhập ngày.'
  if (tx.date > today) return ja ? '未来の日付になっています。日付を確認してください。' : 'Ngày bạn nhập là ngày chưa đến. Vui lòng kiểm tra lại ngày.'
  if (ymKey(tx.date) > targetYm) {
    const m = monthOf(tx.date)
    return ja ? `${m}月分の明細です。この申請から消して、${m}月分の申請で出してください。` : `Đây là khoản của tháng ${m}. Vui lòng xóa khoản này khỏi đơn này và khai trong đơn của tháng ${m}.`
  }
  const m = monthOf(tx.date)
  const t = Number(targetYm.slice(4, 6))
  return ja
    ? `${m}月の日付で、この申請（${t}月分）の月と違います。日付を確認してください。日付が正しいときは森田さんに教えてください。`
    : `Ngày này là của tháng ${m}, không thuộc tháng của đơn này (tháng ${t}). Vui lòng kiểm tra lại ngày. Nếu ngày đúng, vui lòng báo cho Morita-san.`
}

function ruleMessage(flag: MfExpenseFlag, tx: MfExpenseTx, targetYm: string, today: string, lang: MfCommentLang): string {
  const ja = lang === 'ja'
  switch (flag.rule) {
    case 'T1':
      return ja
        ? 'この日は現場に出た記録がありません。休みだった場合は、この明細を消してください。現場に出ていた場合は、森田さんに教えてください。'
        : 'Ngày này không có ghi nhận bạn làm việc ở công trường (出面). Nếu hôm đó bạn nghỉ, vui lòng xóa khoản này. Nếu hôm đó bạn có đi làm, vui lòng báo cho Morita-san.'
    case 'D1':
      return dateMessage(tx, targetYm, today, lang)
    case 'D2':
      return ja
        ? '別の申請に同じ明細があります。二重になっていたら、消してください。'
        : 'Khoản này có vẻ bị trùng với một khoản trong đơn khác. Nếu đúng là bị trùng, vui lòng xóa khoản này.'
    case 'R1':
      return ja ? '領収書が付いていません。領収書の写真を付けてください。' : 'Chưa đính kèm hóa đơn. Vui lòng đính kèm ảnh hóa đơn.'
    case 'R2': {
      const d = (flag.receipt?.date || '').replace(/-/g, '/')
      return ja ? `領収書の日付は ${d} です。申請の日付を領収書に合わせてください。` : `Ngày trên hóa đơn là ${d}. Vui lòng sửa ngày trong đơn cho đúng với hóa đơn.`
    }
    case 'R3': {
      const a = Math.round(flag.receipt?.amount || 0).toLocaleString('en-US')
      return ja ? `領収書の金額は ${a}円 です。申請の金額を領収書に合わせてください。` : `Số tiền trên hóa đơn là ${a} yên. Vui lòng sửa số tiền trong đơn cho đúng với hóa đơn.`
    }
    case 'R5': {
      const a = Math.round(flag.receipt?.amount || 0).toLocaleString('en-US')
      return ja
        ? `付いている領収書は ${a}円 で、申請の金額と違います。駐輪場代が入っている場合は、この明細を電車代だけの金額に直して領収書を外し、「駐車場・駐輪場代」の明細を新しく作って領収書を付けてください。入っていない場合は、金額を確認してください。`
        : `Số tiền trên hóa đơn đính kèm là ${a} yên, khác với số tiền trong đơn. Nếu số tiền trong đơn có cộng cả tiền gửi xe (駐輪場代), vui lòng sửa khoản này thành chỉ còn tiền tàu và bỏ hóa đơn khỏi khoản này, rồi thêm một khoản mới ở mục「駐車場・駐輪場代」và đính kèm hóa đơn vào đó. Nếu không có tiền gửi xe, vui lòng kiểm tra lại số tiền.`
    }
    case 'K2': {
      const more = flag.moreLines || 0
      if (ja) return `電車代の科目に、駐輪場代のような少額の明細があります${more > 0 ? `（ほか ${more} 件）` : ''}。駐輪場代なら、科目を「駐車場・駐輪場代」に変えてください。`
      return `Khoản này có vẻ là tiền gửi xe (駐輪場代) nhưng đang khai ở mục tiền tàu${more > 0 ? ` (và ${more} khoản khác)` : ''}. Nếu đúng là tiền gửi xe, vui lòng đổi sang mục「駐車場・駐輪場代」.`
    }
    case 'T5': {
      const a = Math.round(flag.usual || 0).toLocaleString('en-US')
      // 1行の金額ではなく、その日の合計で比べている。古い保存データには合計が無い
      const total = flag.dayTotal === undefined ? '' : Math.round(flag.dayTotal).toLocaleString('en-US')
      if (ja) return `${total ? `この日の交通費の合計は ${total}円 です。` : ''}同じ現場の他の日は ${a}円 です。金額を確認してください。金額が正しいときは、理由を森田さんに教えてください。`
      return `${total ? `Tổng tiền đi lại ngày này là ${total} yên. ` : ''}Những ngày khác đến cùng công trường này thường là ${a} yên. Vui lòng kiểm tra lại số tiền. Nếu số tiền đúng, vui lòng báo lý do cho Morita-san.`
    }
    case 'T6': {
      const a = Math.round(flag.usual || 0).toLocaleString('en-US')
      const more = flag.moreLines || 0
      if (ja) return `同じ区間で、社内で一番安い金額は ${a}円 です。一番安いルートの金額に直してください。${more > 0 ? `同じ区間のほかの ${more} 件も同じように直してください。` : ''}`
      return `Cùng ga đi và ga đến này, số tiền thấp nhất mà mọi người trong công ty đã khai là ${a} yên. Vui lòng sửa theo số tiền của tuyến đường rẻ nhất.${more > 0 ? ` Vui lòng sửa tương tự cho ${more} khoản khác có cùng ga đi và ga đến.` : ''}`
    }
    case 'K1':
      return ja
        ? '内容と科目が合っていないようです。科目を確認してください。'
        : 'Mục chi phí có vẻ không đúng với nội dung. Vui lòng kiểm tra lại mục chi phí.'
    case 'G3':
      return ja
        ? '内容に「折半」「半額」と書いてあります。申請の金額が領収書の全額か半分か、森田さんに教えてください。'
        : 'Trong đơn có ghi "chia đôi" hoặc "một nửa" (折半・半額). Vui lòng báo cho Morita-san: số tiền bạn nhập là toàn bộ số tiền trên hóa đơn hay chỉ một nửa.'
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
    const mine = flags.filter((f, i, all) => f.txId === tx.id && REJECT_RULES.has(f.rule) && all.findIndex(x => x.txId === f.txId && x.rule === f.rule) === i)
    if (mine.length === 0) continue
    blocks.push([txHeading(tx, lang), ...mine.map(f => `  ${ruleMessage(f, tx, targetYm, today, lang)}`)].join('\n'))
  }
  if (blocks.length === 0) return ''
  return [WRAP[lang].open, ...blocks, WRAP[lang].close].join('\n\n')
}

/**
 * 賞与の配分の合計（2026-11-11）。画面（BonusTable）の合計行・箱・履歴が同じ数え方を使う。
 *
 * 根本原因: 合計行は「自社が払う人」だけを足していたが、表には出向先が払う人も並び、原資とのつながりが画面に無かった
 *   （原資 100万 → 千円単位に切り上げて配分 → うち出向先が払う分を除く → 自社の合計、が読み取れない）。
 *   履歴の「支給計」も内訳が無く、上の表の合計と合わない理由が分からなかった。
 * 対処: 自社・出向先・全員の3つを同じ関数で数え、原資との差（切り上げ・手直しの分）も出す。
 *
 * ここは純粋な計算だけ（個人の金額は持たない）。
 */

export interface BonusSumLine {
  /** ① 利益分配 */
  amount: number
  attendanceDays?: number
  /** ② 精勤賞与 */
  attendanceAmount?: number
  /** ③ 禁煙手当 */
  nonSmokerAmount?: number
  /** ④ 子ども手当 */
  childAmount?: number
  /** ①〜④の合計（古い記録には無い＝①だけ） */
  totalAmount?: number
  /** 出向先（あれば、その会社が支給する） */
  paidBy?: string
  payMethod?: 'transfer' | 'cash'
}

export interface BonusPart {
  count: number
  profit: number
  attendanceDays: number
  attendance: number
  nonSmoker: number
  child: number
  total: number
}

export function sumBonusLines(lines: BonusSumLine[]): BonusPart {
  const p: BonusPart = { count: lines.length, profit: 0, attendanceDays: 0, attendance: 0, nonSmoker: 0, child: 0, total: 0 }
  for (const l of lines) {
    p.profit += l.amount || 0
    p.attendanceDays += l.attendanceDays || 0
    p.attendance += l.attendanceAmount || 0
    p.nonSmoker += l.nonSmokerAmount || 0
    p.child += l.childAmount || 0
    p.total += l.totalAmount ?? (l.amount || 0)
  }
  return p
}

export interface BonusSummary {
  /** 自社が払う人 */
  own: BonusPart
  /** 出向先が払う人 */
  dispatched: BonusPart
  /** 全員（原資を配った相手） */
  all: BonusPart
  /** 利益分配の合計（全員）− 原資。千円単位の切り上げと、表での手直しの分 */
  overPool: number
  /** 自社が払う分の、振込・現金 */
  transfer: number
  cash: number
}

export function summarizeBonus(pool: number, lines: BonusSumLine[]): BonusSummary {
  const ownLines = lines.filter(l => !l.paidBy)
  const own = sumBonusLines(ownLines)
  const dispatched = sumBonusLines(lines.filter(l => !!l.paidBy))
  const all = sumBonusLines(lines)
  const cash = sumBonusLines(ownLines.filter(l => l.payMethod === 'cash')).total
  return { own, dispatched, all, overPool: all.profit - (pool || 0), transfer: own.total - cash, cash }
}

/** 表の並び: 自社が払う人を合計の大きい順 → 出向先が払う人を下にまとめる（合計行に入らない人を表の途中に混ぜない） */
export function sortBonusLines<T extends BonusSumLine>(lines: T[]): T[] {
  const total = (l: T) => l.totalAmount ?? (l.amount || 0)
  return [...lines].sort((x, y) => (x.paidBy ? 1 : 0) - (y.paidBy ? 1 : 0) || total(y) - total(x))
}

/** 同じ支給日ですでに確定している賞与（二重に確定する前に知らせる） */
export function sameDayBonuses<R extends { paidOn: string }>(records: R[], paidOn: string): R[] {
  return records.filter(r => r.paidOn === paidOn)
}

/**
 * 道具代の「会社半額負担」（2026-10-08 代表決定）
 *
 * 外国人スタッフ（技能実習・特定技能）が高い道具を買うとき、会社が半分を負担する。
 * - 対象の道具: 電動インパクトだけ
 * - 会社負担: 購入額の半分（1円未満は会社負担を切り上げ＝本人に有利な向き）。上限 25,000円
 * - 本人負担（購入額 − 会社負担）は、本人の道具代の枠から引く
 * - 2年に1回まで（前回の半額負担の購入日から2年たった日から、また使える）
 * - 早く辞めても返金は求めない
 * - 2026-08-01 以降の購入から（さかのぼって登録できる）。2026-10-09 代表決定で 10-01 → 08-01 に広げた
 *   （8/27 に買った電動インパクトを、半額負担を受けるために購入日を 10/1 に書き換えて登録していた。購入日は領収書の日付で記録する）
 *
 * 道具代の枠を減らす額は、必ず purchaseBudgetUse() を通して求める
 * （管理画面・スマホ・繰越の計算で同じ値になるように。購入額をそのまま足さない）。
 */

import { addMonthsSafe } from './date-utils'

/** この日以降の購入から半額負担の対象 */
export const TOOL_SUBSIDY_FROM = '2026-08-01'

export type ToolSubsidyKind = 'impact'

export const TOOL_SUBSIDY_ITEMS: Record<ToolSubsidyKind, {
  label: string
  labelVi: string
  /** 会社が負担する割合 */
  rate: number
  /** 会社負担の上限（円） */
  cap: number
  /** 何年に1回まで */
  intervalYears: number
}> = {
  impact: { label: '電動インパクト', labelVi: 'Máy siết bu lông (impact)', rate: 0.5, cap: 25000, intervalYears: 2 },
}

export function isToolSubsidyKind(k: unknown): k is ToolSubsidyKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TOOL_SUBSIDY_ITEMS, k)
}

/** 半額負担の対象者（技能実習・特定技能） */
export function isToolSubsidyEligible(visa: string | null | undefined): boolean {
  const v = visa || ''
  return v.startsWith('jisshu') || v.startsWith('tokutei')
}

/** 購入額から会社負担額を出す（上限込み） */
export function toolSubsidyCompanyAmount(kind: ToolSubsidyKind, amount: number): number {
  const item = TOOL_SUBSIDY_ITEMS[kind]
  const a = Math.max(0, Number(amount) || 0)
  return Math.min(item.cap, Math.ceil(a * item.rate))
}

export interface PurchaseLike {
  date?: string
  amount: number
  /** 会社半額負担（2026-10-08）。company = 会社が負担した額 */
  subsidy?: { kind: ToolSubsidyKind; company: number } | null
}

/** その購入で道具代の枠から引く額（＝本人負担）。半額負担なしなら購入額そのまま */
export function purchaseBudgetUse(p: PurchaseLike): number {
  const amount = Number(p.amount) || 0
  const company = p.subsidy ? Math.max(0, Number(p.subsidy.company) || 0) : 0
  return Math.max(0, amount - company)
}

/** 購入の一覧から、枠から引く額の合計 */
export function purchasesBudgetUse(purchases: PurchaseLike[] | undefined | null): number {
  return (purchases || []).reduce((s, p) => s + purchaseBudgetUse(p), 0)
}

/** 購入の一覧から、会社負担の合計 */
export function purchasesCompanyAmount(purchases: PurchaseLike[] | undefined | null): number {
  return (purchases || []).reduce((s, p) => s + (p.subsidy ? Math.max(0, Number(p.subsidy.company) || 0) : 0), 0)
}

/** 次に半額負担を使える日（前回の購入日から intervalYears 年後） */
export function nextToolSubsidyDate(kind: ToolSubsidyKind, lastDate: string): string {
  return addMonthsSafe(lastDate, TOOL_SUBSIDY_ITEMS[kind].intervalYears * 12)
}

/**
 * 半額負担を付けてよいかを確かめる。だめなら理由を返す（よければ null）
 * @param others その人のほかの購入（全期間。今つけ直そうとしている購入自身は除いて渡す）
 */
export function toolSubsidyError(args: {
  kind: ToolSubsidyKind
  visa: string | null | undefined
  date: string
  others: PurchaseLike[]
}): string | null {
  const { kind, visa, date, others } = args
  const item = TOOL_SUBSIDY_ITEMS[kind]
  if (!isToolSubsidyEligible(visa)) return `${item.label}の半額負担は外国人スタッフ（技能実習・特定技能）だけが対象です`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '購入日が正しくありません'
  if (date < TOOL_SUBSIDY_FROM) return `半額負担は ${TOOL_SUBSIDY_FROM} 以降の購入からです`
  // 2年に1回: 前後どちらの購入とも2年あいていること（さかのぼって登録する場合もあるので両方見る）
  for (const o of others) {
    if (!o.subsidy || o.subsidy.kind !== kind || !o.date) continue
    const [early, late] = o.date <= date ? [o.date, date] : [date, o.date]
    const next = nextToolSubsidyDate(kind, early)
    if (late < next) {
      return `${item.label}の半額負担は${item.intervalYears}年に1回までです（${o.date} に使っています。次は ${nextToolSubsidyDate(kind, o.date)} から）`
    }
  }
  return null
}

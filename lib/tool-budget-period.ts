/**
 * 道具代の期間（1年サイクル）の計算（2026-09-30 に app/api/tool-budget/route.ts から切り出し）
 *
 * 期間は「起点日」から1年ごと。起点日は人ごとに管理画面で設定する（periodAnchors）。
 * ベトナム人（技能実習・特定技能）で起点日が未設定の人は、**入社日を起点にする**
 * （2026-09-30: 8月以降の新人3名が未設定で、スマホに道具代が出ていなかった）。
 * 日本人は 10/1 起点の年度で運用しているので、入社日で補わない（未設定なら期間なし）。
 *
 * スタッフのスマホ（/api/attendance/staff）と道具代の管理（/api/tool-budget）で同じ関数を使う。
 * 以前はスマホ側だけ別の計算を持っていて、起点日が先の人に「来期」を今の残額として出していた。
 */

import { todayJstIso } from './date-utils'

export interface ToolBudgetPeriod {
  start: string  // YYYY-MM-DD
  end: string    // YYYY-MM-DD
  index: number  // 1 = 1年目, 2 = 2年目, ...
}

/** 年数を加算する。2/29 → 2/28 に正規化（うるう年） */
function addYears(date: Date, years: number): Date {
  const d = new Date(date)
  const origMonth = d.getMonth()
  d.setFullYear(d.getFullYear() + years)
  if (d.getMonth() !== origMonth) d.setDate(0)
  return d
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * refDate を含む期間。起点日がまだ来ていなければ null
 *
 * 既定の基準日は**日本時間の今日**（2026-09-30 点検: サーバは UTC なので new Date() だと
 * 切り替わる日の 0:00〜8:59 に前の期間のままになり、画面ごとに残高が食い違った）。
 * 期間の区切りは getPeriodByIndex と同じ計算で求める（2/29 起点の人でも区切りが一通りになるように）。
 */
export function getCurrentPeriod(anchor: string, refDate: Date | string = todayJstIso()): ToolBudgetPeriod | null {
  if (!anchor) return null
  const a = new Date(anchor + 'T00:00:00')
  if (isNaN(a.getTime())) return null
  const ref = typeof refDate === 'string' ? refDate : iso(refDate)
  if (iso(a) > ref) return null
  for (let i = 1; i <= 200; i++) {
    const p = getPeriodByIndex(anchor, i)
    if (!p) return null
    if (p.end >= ref) return p
  }
  return null
}

/** index 番目（1始まり）の期間 */
export function getPeriodByIndex(anchor: string, index: number): ToolBudgetPeriod | null {
  if (!anchor || index < 1) return null
  const a = new Date(anchor + 'T00:00:00')
  if (isNaN(a.getTime())) return null
  const start = addYears(a, index - 1)
  const end = addYears(start, 1)
  end.setDate(end.getDate() - 1)
  return { start: iso(start), end: iso(end), index }
}

/** その人の起点日。設定があればそれ、ベトナム人で未設定なら入社日 */
export function toolBudgetAnchorOf(
  w: { id: number; visa?: string | null; hireDate?: string | null },
  anchors: Record<string, string> | undefined,
): { anchor: string | null; fromHireDate: boolean } {
  const set = anchors?.[String(w.id)]
  if (set) return { anchor: set, fromHireDate: false }
  const visa = w.visa || 'none'
  const foreign = visa.startsWith('jisshu') || visa.startsWith('tokutei')
  if (foreign && w.hireDate && /^\d{4}-\d{2}-\d{2}$/.test(w.hireDate)) return { anchor: w.hireDate, fromHireDate: true }
  return { anchor: null, fromHireDate: false }
}

// ────────────────────────────────────────
//  繰り越し（2026-09-30 代表決定）
// ────────────────────────────────────────
//
// - 使い切れなかった分は**翌期に1回だけ**繰り越す。翌期は「予算＋繰越」まで使え、使うときは繰越分から先に減る
//   （＝翌期も使われずに残った繰越分はそこで消える。何年も積み上がらない）
// - 使いすぎ（予算＋繰越を超えた分）は、翌期にマイナスで繰り越す（翌期の枠から差し引く）
// - 繰り越すのは、終了日が TOOL_BUDGET_CARRY_FROM 以降の期間から。それより前に終わった期間はさかのぼらない

/** この日以降に終わる期間から繰り越す（運用開始 2026-09-30） */
export const TOOL_BUDGET_CARRY_FROM = '2026-09-30'

export interface ToolBudgetRecordLike {
  budget?: number
  purchases?: { amount: number }[]
}

/** ある期間が終わったときに翌期へ繰り越す額（予算 B・繰越 C・使用 U） */
export function carryOut(budget: number, carryIn: number, used: number): number {
  if (used > budget + carryIn) return budget + carryIn - used        // 使いすぎ → マイナスで繰り越す
  return Math.max(0, budget - Math.max(0, used - carryIn))           // 繰越分から先に使う。残った「予算」だけ繰り越す
}

/**
 * index 番目（1始まり）の期間に入ってくる繰越額。前の期間を1期目から順にたどる。
 * 記録の無い期間は「既定の予算・使用0」とみなす。
 */
export function toolBudgetCarryIn(
  anchor: string, index: number, workerId: number,
  records: Record<string, ToolBudgetRecordLike | undefined>, defaultBudget: number,
): number {
  let carry = 0
  for (let i = 1; i < index; i++) {
    const p = getPeriodByIndex(anchor, i)
    if (!p) return 0
    if (p.end < TOOL_BUDGET_CARRY_FROM) { carry = 0; continue }
    const rec = records[`${workerId}_${p.start}`]
    const budget = rec?.budget ?? defaultBudget
    const used = (rec?.purchases || []).reduce((s, x) => s + (Number(x.amount) || 0), 0)
    carry = carryOut(budget, carry, used)
  }
  return carry
}

/** 起点日から数えて、periodStart で始まる期間が何番目か（該当しなければ null） */
export function periodIndexOf(anchor: string, periodStart: string): number | null {
  for (let i = 1; i <= 100; i++) {
    const p = getPeriodByIndex(anchor, i)
    if (!p) return null
    if (p.start === periodStart) return i
    if (p.start > periodStart) return null
  }
  return null
}

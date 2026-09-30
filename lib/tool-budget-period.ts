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

/** refDate を含む期間。起点日がまだ来ていなければ null */
export function getCurrentPeriod(anchor: string, refDate: Date = new Date()): ToolBudgetPeriod | null {
  if (!anchor) return null
  const a = new Date(anchor + 'T00:00:00')
  if (isNaN(a.getTime())) return null
  if (a > refDate) return null
  let start = new Date(a)
  let index = 1
  while (true) {
    const next = addYears(start, 1)
    if (next > refDate) break
    start = next
    index++
  }
  const end = addYears(start, 1)
  end.setDate(end.getDate() - 1)
  return { start: iso(start), end: iso(end), index }
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

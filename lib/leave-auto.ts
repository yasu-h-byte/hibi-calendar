import { MainData } from './compute'
import { serviceMonthsAt } from './leave-compute'
import { todayJstIso } from './date-utils'
import { listPendingGrants, type PendingGrantWorker, type PendingGrantRecord } from './leave-pending'

/**
 * ⚠️ 2026-08-04 有給システム総点検での整理:
 *   旧 `checkAndGrantPL`（全自動付与）と旧 `calcCarryOver` はこのファイルから削除した。
 *   - checkAndGrantPL は呼び出し元ゼロの休眠コードだったが、繰越計算が出面の実消化を
 *     完全に無視し（stale な used フィールドだけで計算）、上限も法定FIFO（前期付与分まで）
 *     でなく一律20日だった。さらに plData 全体を丸ごと updateDoc しており、
 *     将来誰かが呼ぶと「余分に付与 + 他ワーカーの巻き添え上書き」の二重事故になる状態だった。
 *   - 実際の付与は app/api/leave/route.ts の getPendingGrants / executePendingGrants
 *     （半自動付与）に一本化されている。全自動付与を復活させる場合は必ずそちらの
 *     calcCarryOverForWorker（出面ベース + calcLegalCarryOver）を使うこと。
 */

/**
 * Get upcoming PL grant dates within the next N days.
 * Used for dashboard notifications.
 *
 * 2026-10-02 総合点検: 判定を lib/leave-pending.ts listPendingGrants（休暇管理の付与待ち一覧と同じ）に寄せた。
 *   旧: このファイルの calcNextGrantDate が外国人を「入社日の応当日」で出し、休暇管理（前回付与日+1年）と日付が
 *   食い違うことがあった。付与日から30日を過ぎた未付与は通知ベルから消えていた（diffDays >= -30）が、
 *   付与は人が押す半自動なので、押すまで出し続ける。入社日未登録（needsAttention）の人は通知ベルには出さない
 *   （「10日付与する」の操作を既定値のまま押させないため。休暇管理の付与待ち一覧には出る）。
 */
export interface UpcomingGrant {
  workerId: number
  name: string
  grantDate: Date
  days: number
  carryOver: number
  total: number
  yearsOfService: string
}

export function getUpcomingGrants(
  main: MainData,
  withinDays: number = 7
): UpcomingGrant[] {
  const todayIso = todayJstIso()
  const pending = listPendingGrants(
    main.workers as unknown as PendingGrantWorker[],
    main.plData as unknown as Record<string, PendingGrantRecord[]>,
    todayIso,
    { leadDays: withinDays },
  )
  const upcoming: UpcomingGrant[] = []
  for (const p of pending) {
    if (p.needsAttention || !p.hireDate) continue
    if (p.legalDays <= 0) continue
    // 勤続年数（付与日時点）
    const months = serviceMonthsAt(p.hireDate, p.nextGrantDate) ?? 0
    const yearsOfService = `${Math.floor(months / 12)}年${months % 12}ヶ月`
    // 繰越の正確な値は出面データが必要（この関数は同期・軽量が前提のため計算しない）。
    // 表示に使う notifications 側が calcLegalCarryOver + 出面で再計算して上書きする。
    const carryOver = 0
    upcoming.push({
      workerId: p.workerId,
      name: p.name,
      grantDate: new Date(p.nextGrantDate + 'T00:00:00'),
      days: p.legalDays,
      carryOver,
      total: p.legalDays + carryOver,
      yearsOfService,
    })
  }
  return upcoming
}

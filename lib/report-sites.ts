/**
 * 集計画面に出す「対象の現場」の決まり（2026-10-02 総合点検）。**ここだけで決める**。
 *
 * 根本原因: 画面ごとに現場の範囲が違っていた。
 *   - 原価・収益（/api/cost）の月次表示は「終了（archived）でない現場」だけを回して売上を足し、
 *     原価・人工の合計は全現場の compute() の値を使っていた → 現場を終了にすると、過去月の売上だけが消えて
 *     原価は残り、粗利が売上ぶん少なく出た
 *   - ダッシュボードは「終了でもデータがあれば含める」、経営コックピット連携は終了を見ない、月次推移は全現場
 * 決まり: **その期間に人工・原価・請求額のどれかがある現場は、終了でも含める。** 終了していない現場は常に含める。
 *
 * 使うところ: /api/cost・lib/integration.ts（ダッシュボード /api/dashboard も同じ関数に寄せる）
 */
import { getBillTotal, type MainData } from './compute'

export interface SiteActivity {
  work: number
  subWork: number
  cost: number
  subCost: number
}

export function siteHasActivity(
  main: Pick<MainData, 'billing'>,
  siteId: string,
  ymRange: string[],
  activity: SiteActivity | undefined,
): boolean {
  if (activity && (activity.work + activity.subWork > 0 || activity.cost + activity.subCost > 0)) return true
  return ymRange.some(ym => getBillTotal(main as MainData, siteId, ym) > 0)
}

/**
 * 期間（'YYYYMM' の一覧）に出す現場。終了していない現場は全部、終了した現場は人工・原価・請求額のどれかがある月が
 * 期間内にあるときだけ。順番は main.sites のまま
 */
export function reportSitesForPeriod<T extends { id: string; archived?: boolean }>(
  main: Pick<MainData, 'billing'> & { sites: T[] },
  ymRange: string[],
  activityOf: (siteId: string) => SiteActivity | undefined,
): T[] {
  return main.sites.filter(s => !s.archived || siteHasActivity(main, s.id, ymRange, activityOf(s.id)))
}

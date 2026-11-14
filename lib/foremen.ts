/**
 * 現場の職長を決める純関数（2026-10-03）。
 * lib/auth.ts から切り出した。auth.ts はパスワードの処理（node の crypto）を読み込むので、
 * クライアントから届く lib/attendance.ts などがここを読めるように、純関数だけを別ファイルにした
 * （auth.ts 経由だと next build が「node:crypto をクライアントに含められない」で落ちる）。
 * 既存の import 元のために lib/auth.ts からも同じ名前で再エクスポートしている。
 */
import type { Site } from '@/types'
/**
 * 当該ワーカーが「現在月で職長として担当する現場ID」を返す。
 * mforeman[siteId_ym] の月別 override を優先し、なければ sites.foreman を採用。
 *
 * 2026-05-08 修正: mforeman を反映していなかったため、月途中の職長交代で
 *   旧職長が承認できる/新職長が承認できない事態が起きていた。
 */
export function computeForemanSites(
  workerId: number,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
): string[] {
  const result: string[] = []
  for (const site of sites) {
    if (site.archived) continue
    if (foremenOfSiteForMonth(site, mforeman, ym).includes(workerId)) result.push(site.id)
  }
  return result
}

/**
 * その月にその現場の職長である人（承認の権限判定はすべてこれを通す・2026-10-01）。
 *
 * 月別の職長（mforeman[siteId_ym]. foreman ?? wid）があればその人だけ、無ければ現場の職長。
 * 旧: 出面・有給・帰国申請で別々に書いていて、有給は月別職長を「足す」（旧職長も承認できる）、
 *     帰国申請は月別職長を見ない、と食い違っていた。
 * `foremen`（配列）は書き込む画面が無い古い項目。残っているデータのために読むだけ読む。
 */
export function foremenOfSiteForMonth(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
): number[] {
  const monthKey = `${site.id}_${ym.replace('-', '')}`
  const override = mforeman[monthKey]?.foreman ?? mforeman[monthKey]?.wid
  if (override !== undefined && override !== null) return [override]
  if (site.foremen && site.foremen.length > 0) return site.foremen
  return site.foreman !== undefined && site.foreman !== null ? [site.foreman] : []
}

/**
 * 職長承認ができる人（2026-10-01 代表決定）。
 *
 * 「その月の現場の職長として登録されている」かつ「人員マスタの職種が職長（jobType='shokucho'）」の人だけ。
 * 職長でない人（とび・役員など）が現場マスタの職長に登録されている現場は、事業責任者（政仁さん）が
 * 職長承認を代行する（{@link isProxyApprovalSite}）。出面の入力などの権限は変えない（承認だけの決まり）。
 */
export function approvingForemenOfSite(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
): number[] {
  // 職種は Firestore の生データでは job、lib/workers で整形後は jobType
  return foremenOfSiteForMonth(site, mforeman, ym)
    .filter(id => { const w = workers.find(x => x.id === id); return (w?.jobType ?? w?.job) === 'shokucho' })
}

/** 職長承認を政仁さんが代行する現場か（承認できる職長がいない現場） */
export function isProxyApprovalSite(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
): boolean {
  return approvingForemenOfSite(site, mforeman, ym, workers).length === 0
}

/**
 * その日に職長承認できる職長（長い休み＝帰国・育休などの人を除く・2026-11-14 代表）。
 *
 * 白戸職長の育休（2026-12-07〜12-19・12-26〜2027-02-16）で、休みの日の職長承認が止まらないよう、
 * 承認できる職長が全員休みの日は、政仁さん（事業責任者）が代わりに承認する（{@link isProxyApprovalDay}）。
 * 職長が出ている日は今までどおり職長が承認する。休みの記録は homeLongLeave（最終承認済み）。
 */
export function approvingForemenOnDay(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
  dateIso: string,
  leaves: { workerId: number; startDate: string; endDate: string }[],
): number[] {
  return approvingForemenOfSite(site, mforeman, ym, workers)
    .filter(id => !leaves.some(l => l.workerId === id && dateIso >= l.startDate && dateIso <= l.endDate))
}

/** その日の職長承認を政仁さんが代わりに行うか（承認できる職長がいない現場、または職長が全員休みの日） */
export function isProxyApprovalDay(
  site: { id: string; foreman?: number; foremen?: number[] },
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
  workers: { id: number; jobType?: string; job?: string }[],
  dateIso: string,
  leaves: { workerId: number; startDate: string; endDate: string }[],
): boolean {
  return approvingForemenOnDay(site, mforeman, ym, workers, dateIso, leaves).length === 0
}

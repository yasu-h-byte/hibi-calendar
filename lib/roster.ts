/**
 * 配置（名簿）の決まりは getAssign（lib/compute.ts）1つ。「人 → その月の現場」もここから作る（2026-10-02 総合点検）。
 *
 * ## なぜ必要か
 * getAssign は「その月の月別配置 massign → 無ければ過去12か月の月別配置をさかのぼる → 既定配置 assign」で決め、
 * PC の出面画面・給与計算・職長の名簿（lib/foreman-todo.ts）がこれを使う。一方で「人からその月の現場を引く」側
 * （getStaffSites・getForeignWorkersForSite・スタッフのスマホ・ダッシュボードの職長名・帰国の hk を書く現場）は
 * `massign[当月] ?? assign` と自前に書いていて、さかのぼらなかった。
 *   例: IHI の 8月の月別配置に A さんがいて、10月の月別配置が無く、既定配置は笹塚。
 *       職長の名簿では10月も IHI（未入力に数える）なのに、本人のスマホの最初の現場は笹塚になり、
 *       そのまま打つと IHI では未入力・笹塚では配置外になっていた。
 *
 * 純関数（Firestore を読まない）。main ドキュメントの生データ（sites / assign / massign）をそのまま渡す。
 */
import { getAssign, type MainData } from './compute'

/** getAssign が見る main の部分（demmen/main の生データと同じ形） */
export type AssignSource = {
  sites: { id: string; name?: string; archived?: boolean; parentId?: string }[]
  assign?: Record<string, { workers?: number[]; subcons?: string[]; dispatch?: number[] } | undefined>
  massign?: Record<string, { workers?: number[]; subcons?: string[]; dispatch?: number[] } | undefined>
}

const asMain = (src: AssignSource): MainData =>
  ({ sites: src.sites, assign: src.assign || {}, massign: src.massign || {} } as unknown as MainData)

/** 現場×月の配置の人（getAssign そのまま） */
export function workerIdsOfSiteForMonth(src: AssignSource, siteId: string, ym: string): number[] {
  return getAssign(asMain(src), siteId, ym.replace('-', '')).workers
}

/**
 * その人がその月に配置されている現場（終了した現場は除く。工種サイトは含める＝旧 getStaffSites と同じ範囲）。
 * 並びは main.sites の順。
 */
export function sitesOfWorkerForMonth(
  src: AssignSource, workerId: number, ym: string, opts?: { includeWorkTypeSites?: boolean },
): { id: string; name: string }[] {
  const ymKey6 = ym.replace('-', '')
  const out: { id: string; name: string }[] = []
  for (const site of src.sites) {
    if (site.archived) continue
    if (opts?.includeWorkTypeSites === false && site.parentId) continue
    if (workerIdsOfSiteForMonth(src, site.id, ymKey6).includes(workerId)) out.push({ id: site.id, name: site.name || '' })
  }
  return out
}

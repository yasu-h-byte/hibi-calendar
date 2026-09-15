/**
 * 工種サイト（親現場の下の「鉄骨」「仮設」などの入力先）の解決（2026-09-15）。
 *
 * ## 仕組み
 * 工種は `demmen/main.sites` の通常の現場レコードとして持ち、`parentId`（親現場 id）と
 * `workType`（工種名）を付ける。出面・配置・単価（受取単価 rates / 借りる単価 subconRates）は
 * 工種サイトの id で持つので、既存の出面入力・集計がそのまま工種ごとに分かれる。
 *
 * 一方で次のものは **親現場から引き継ぐ**（工種を増やしても手間を増やさないため・代表決定 2026-09-15）:
 * - 就業カレンダー（siteCalendar / siteWorkDays）と、その署名
 * - 職長（site.foreman / mforeman）
 * - 勤務時間（site.workSchedule）
 * - 請負体制（gcId / primeId / ownerId）と種別（siteType / client）
 *
 * 親子は1階層だけ（工種の下に工種は作らない）。
 */

export interface HierarchySite {
  id: string
  name: string
  parentId?: string
  workType?: string
  archived?: boolean
}

/** 工種サイトか */
export function isWorkTypeSite(site: { parentId?: string } | undefined | null): boolean {
  return !!site?.parentId
}

/**
 * カレンダー・署名・職長・勤務時間を引くときに使う現場 id。
 * 工種サイトなら親現場の id、それ以外（親が見つからない場合も）は自分の id。
 */
export function calendarSiteIdOf(sites: HierarchySite[], siteId: string): string {
  const s = sites.find(x => x.id === siteId)
  if (!s?.parentId) return siteId
  return sites.some(x => x.id === s.parentId) ? s.parentId : siteId
}

/** 親現場の工種サイト一覧（アーカイブを含むかは呼び出し側で絞る） */
export function workTypeSitesOf<T extends HierarchySite>(sites: T[], parentId: string): T[] {
  return sites.filter(s => s.parentId === parentId)
}

/** 画面表示用の現場名。工種サイトは「親現場名（工種）」 */
export function siteDisplayName(sites: HierarchySite[], siteId: string): string {
  const s = sites.find(x => x.id === siteId)
  if (!s) return siteId
  if (!s.parentId) return s.name
  const p = sites.find(x => x.id === s.parentId)
  return p ? `${p.name}（${s.workType || s.name}）` : s.name
}

/**
 * siteId をキーにしたカレンダー系のマップ（siteWorkDays[ym] や calendarDays）に、
 * 工種サイトの分を親現場の値で補って返す（元のマップは変更しない）。
 * 工種サイト自身に値がある場合（旧データ等）は上書きしない。
 */
export function withWorkTypeSiteCalendars<V>(sites: HierarchySite[], map: Record<string, V> | undefined): Record<string, V> {
  const out: Record<string, V> = { ...(map || {}) }
  for (const s of sites) {
    if (!s.parentId) continue
    if (out[s.id] !== undefined) continue
    const v = out[s.parentId]
    if (v !== undefined) out[s.id] = v
  }
  return out
}

/** 親現場・工種サイトを「親 → その工種」の順に並べる（現場の選択肢用） */
export function orderSitesWithWorkTypes<T extends HierarchySite>(sites: T[]): T[] {
  const parents = sites.filter(s => !s.parentId || !sites.some(p => p.id === s.parentId))
  const out: T[] = []
  for (const p of parents) {
    out.push(p)
    for (const c of sites.filter(x => x.parentId === p.id)) out.push(c)
  }
  return out
}

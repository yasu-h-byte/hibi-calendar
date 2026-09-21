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

/**
 * その月に現場が始まっているか（工期の開始月 <= 対象月）。2026-09-21 追加。
 *
 * 就業カレンダーの月別一覧・全体状況で、後から追加した現場（出光 10/1〜・川崎 9/25〜）が
 * 過去月にも「未作成の現場」として数えられ、7〜8月が 2/4 のまま「対応中」になっていた。
 * 終了側（end）は見ない: 工期の終了日は延長されても直されないことが多く、見ると稼働中の現場の
 * カレンダーが消える。終わった現場は「アーカイブ」で外す運用。
 * start は 'YYYY-MM' / 'YYYY-MM-DD'。未設定なら常に対象。
 */
export function isSiteStartedByMonth(site: { start?: string } | undefined | null, ym: string): boolean {
  const start = (site?.start || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(start)) return true
  const n = (ym || '').replace('-', '')
  if (!/^\d{6}$/.test(n)) return true
  return start <= `${n.slice(0, 4)}-${n.slice(4, 6)}`
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

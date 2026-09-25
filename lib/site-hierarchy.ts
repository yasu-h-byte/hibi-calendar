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

/**
 * 請求書・請求一覧用の現場名。工種サイトは「親現場名（工種）」、
 * 工種サイトを持つ親現場に「工種を選ばない日の呼び方」（workType・例: 仮設工事）があれば「親現場名（仮設工事）」。
 */
export function siteBillingName(sites: HierarchySite[], siteId: string): string {
  const s = sites.find(x => x.id === siteId)
  if (s && !s.parentId && s.workType && sites.some(x => x.parentId === s.id)) return `${s.name}（${s.workType}）`
  return siteDisplayName(sites, siteId)
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

/**
 * 親現場 id + その工種サイト id 一覧（親を先頭に含む）。
 * 出面グリッドで「この親現場の下ならどの id に入力されていても良い」という
 * 対象範囲を作るのに使う（2026-09-25・工種の出し分け）。
 */
export function parentAndWorkTypeSiteIds<T extends HierarchySite>(sites: T[], parentId: string): string[] {
  return [parentId, ...workTypeSitesOf(sites, parentId).map(s => s.id)]
}

/** 親現場+工種サイトをまたいだ「同じ人・同じ日」の重複入力 */
export interface WorkTypeDuplicate {
  kind: 'worker' | 'subcon'
  /** workerId（文字列化）または subconId */
  id: string
  day: number
  /** 入力が見つかった現場 id（2件以上） */
  siteIds: string[]
}

/**
 * 親現場 + 工種サイトをまたいで、同じ作業員（または外注先）・同じ日に
 * 複数の現場へ入力されているものを検出する（純関数・2026-09-25）。
 *
 * `entries` は出面ドキュメントの `d`（作業員）または `sd`（外注）マップをそのまま渡す
 * （`{siteId}_{entryId}_{ym}_{day}` 形式のキー。`lib/attendance.ts` の `attKey` と同形式）。
 * 既に取得済みの att ドキュメントから絞り込むだけなので、呼び出し側で Firestore を
 * 読み直す必要はない（読み取り回数を増やさない）。
 *
 * 対象 `siteIds` は `parentAndWorkTypeSiteIds` で作った「親 + その工種」の一覧を渡す。
 * 現場 id 自体に `_` を含み得るため、候補 id を長い順に試して前方一致させる。
 */
export function findWorkTypeDuplicates(
  entries: Record<string, unknown>,
  siteIds: string[],
  ym: string,
  kind: 'worker' | 'subcon',
): WorkTypeDuplicate[] {
  const candidates = [...siteIds].sort((a, b) => b.length - a.length)
  const groups = new Map<string, Set<string>>()

  for (const key of Object.keys(entries)) {
    if (entries[key] == null) continue
    const parsed = parseAttKeyForSites(key, candidates)
    if (!parsed || parsed.ym !== ym) continue
    const groupKey = `${parsed.entryId}\u0000${parsed.day}`
    if (!groups.has(groupKey)) groups.set(groupKey, new Set())
    groups.get(groupKey)!.add(parsed.siteId)
  }

  const out: WorkTypeDuplicate[] = []
  for (const [groupKey, sids] of groups) {
    if (sids.size < 2) continue
    const [entryId, dayStr] = groupKey.split('\u0000')
    out.push({ kind, id: entryId, day: Number(dayStr), siteIds: Array.from(sids) })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.day - b.day)
}

/**
 * `{siteId}_{entryId}_{ym}_{day}` 形式のキーを、候補の現場 id（長い順に並べ済み）で
 * 前方一致させて分解する。合わなければ null。
 */
function parseAttKeyForSites(
  key: string,
  candidatesLongestFirst: string[],
): { siteId: string; entryId: string; ym: string; day: number } | null {
  const siteId = candidatesLongestFirst.find(sid => key.startsWith(`${sid}_`))
  if (!siteId) return null
  const parts = key.slice(siteId.length + 1).split('_')
  if (parts.length < 3) return null
  const day = parts[parts.length - 1]
  const ym = parts[parts.length - 2]
  if (!/^\d+$/.test(day)) return null
  return { siteId, entryId: parts.slice(0, parts.length - 2).join('_'), ym, day: Number(day) }
}

/**
 * 新しく入力する日の保存先を決める（2026-09-25・純関数）。
 *
 * 優先順位（上ほど強い）:
 *   1. その日のエントリが既にある現場（`existingSite`）— 既存分の書き込み先は動かさない
 *   2. その日の工種指定（`dayWorkType`。日付の見出し／期間で「この日は鉄骨」と決めたもの）
 *   3. 作業員／外注先ごとの既定の工種（`workerDefault`）
 *   4. 親現場そのもの（代表決定 2026-09-25: 親現場＝仮設の単価、鉄骨工事だけ工種サイトを作る）
 */
export function resolveWorkTypeSiteId(
  parentId: string,
  opts: { existingSite?: string | null; dayWorkType?: string | null; workerDefault?: string | null } = {},
): string {
  return opts.existingSite || opts.dayWorkType || opts.workerDefault || parentId
}

/** 1日まるごと工種を切り替えるときの移動計画（純関数・実際の書き込みは呼び出し側） */
export interface DayWorkTypeMovePlan {
  moves: { kind: 'worker' | 'subcon'; id: string; fromSiteId: string; fromKey: string; toKey: string }[]
  skipped: { kind: 'worker' | 'subcon'; id: string; reason: 'duplicate' }[]
}

/**
 * 親 + 工種サイトの出面マップから、指定日の全エントリ（作業員 `d`・外注 `sd`）を
 * `toSiteId` へ移す計画を作る。
 * - 既に `toSiteId` に入っているものは触らない
 * - 同じ人が2箇所以上に入っている（重複）ものは移さず `skipped` に載せる（先に解消してもらう）
 */
export function planDayWorkTypeMoves(
  d: Record<string, unknown>,
  sd: Record<string, unknown>,
  siteIds: string[],
  ym: string,
  day: number,
  toSiteId: string,
): DayWorkTypeMovePlan {
  const candidates = [...siteIds].sort((a, b) => b.length - a.length)
  const plan: DayWorkTypeMovePlan = { moves: [], skipped: [] }
  const scan = (map: Record<string, unknown>, kind: 'worker' | 'subcon') => {
    const found = new Map<string, string[]>() // entryId → siteIds
    for (const key of Object.keys(map)) {
      if (map[key] == null) continue
      const p = parseAttKeyForSites(key, candidates)
      if (!p || p.ym !== ym || p.day !== day) continue
      if (!found.has(p.entryId)) found.set(p.entryId, [])
      found.get(p.entryId)!.push(p.siteId)
    }
    for (const [entryId, sids] of found) {
      if (sids.length > 1) { plan.skipped.push({ kind, id: entryId, reason: 'duplicate' }); continue }
      const fromSiteId = sids[0]
      if (fromSiteId === toSiteId) continue
      plan.moves.push({
        kind, id: entryId, fromSiteId,
        fromKey: `${fromSiteId}_${entryId}_${ym}_${day}`,
        toKey: `${toSiteId}_${entryId}_${ym}_${day}`,
      })
    }
  }
  scan(d, 'worker')
  scan(sd, 'subcon')
  return plan
}

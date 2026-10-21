
/**
 * 月次ロック判定の共通ヘルパー（2026-06-12 監査 Sprint2-B）
 *
 * 背景: 月次ロック(locks)のチェックが grid API のデフォルト保存パスにしか無く、
 * 有給承認・スタッフのスマホ入力・職長編集・有給日付変更・時季指定・帰国承認などが
 * ロック済み月にも書き込めた。給与確定（締め→振込）後にデータが変わると
 * 支払額とシステムが食い違う。全書込経路の入口で本ヘルパーを通すこと。
 *
 * locks のキー体系（demmen/main.locks）:
 *   - `${ym}`        … レガシー全体ロック
 *   - `${ym}_hibi`   … 日比建設のみロック
 *   - `${ym}_hfu`    … HFU のみロック
 */
/**
 * 会社の判定（2026-10-02 総合点検）: 人員マスタの生データ org は 'hfu' / 'HFU' のどちらもありうる。
 * 旧は画面・API ごとに `=== 'hfu'`・`=== 'HFU'`・両方、と書き方が違っていた。ここ1つに寄せる
 */
export function orgKeyOf(org: unknown): 'hibi' | 'hfu' {
  return String(org || '').toLowerCase() === 'hfu' ? 'hfu' : 'hibi'
}

export function isMonthLockedInLocks(
  locks: Record<string, unknown> | null | undefined,
  ym: string,
  org?: string,
): boolean {
  if (!locks) return false
  if (locks[ym]) return true  // legacy 全体ロック
  const lockedHibi = !!locks[`${ym}_hibi`]
  const lockedHfu = !!locks[`${ym}_hfu`]
  if (org) return orgKeyOf(org) === 'hfu' ? lockedHfu : lockedHibi
  // org 不明の書込は「両組織ロック時のみ」拒否（安全側に倒しすぎて業務停止しない）
  return lockedHibi && lockedHfu
}


/**
 * 「その人の会社が締め済みか」を純関数で判定する（2026-10-02 総合点検）。
 * - workerIds の誰か1人でも、その人の会社（日比建設／HFU）が締め済みなら true
 * - 人が決まらない書き込み（workerIds が空・人員マスタにいない）は unknownOrg で決める:
 *     'either' … どちらかの会社が締め済みなら true（給与に効く書き込み。安全側）
 *     'both'   … 両方締め済みのときだけ true（外注の人工など、どちらの給与にも入らないもの）
 */
export function isMonthLockedForWorkers(
  locks: Record<string, unknown> | null | undefined,
  rawWorkers: readonly { id?: unknown; org?: unknown }[] | null | undefined,
  ym: string,
  workerIds: readonly number[],
  unknownOrg: 'either' | 'both' = 'either',
): boolean {
  if (!locks) return false
  const orgs: (string | null)[] = workerIds.map(id => {
    const w = (rawWorkers || []).find(x => Number(x.id) === Number(id))
    if (!w) return null
    return orgKeyOf(w.org)
  })
  const known = orgs.filter((o): o is string => !!o)
  if (known.some(o => isMonthLockedInLocks(locks, ym, o))) return true
  if (known.length === workerIds.length && workerIds.length > 0) return false
  // 会社が決まらない分
  if (unknownOrg === 'both') return isMonthLockedInLocks(locks, ym)
  return isMonthLockedInLocks(locks, ym, 'hibi') || isMonthLockedInLocks(locks, ym, 'hfu')
}


/** ISO 日付 (YYYY-MM-DD) から ym (YYYYMM) を得る */
export function ymOfDate(dateIso: string): string {
  return dateIso.slice(0, 7).replace('-', '')
}

import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'

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
export function isMonthLockedInLocks(
  locks: Record<string, unknown> | null | undefined,
  ym: string,
  org?: string,
): boolean {
  if (!locks) return false
  if (locks[ym]) return true  // legacy 全体ロック
  const lockedHibi = !!locks[`${ym}_hibi`]
  const lockedHfu = !!locks[`${ym}_hfu`]
  if (org) {
    const o = org === 'hfu' || org === 'HFU' ? 'hfu' : 'hibi'
    return o === 'hfu' ? lockedHfu : lockedHibi
  }
  // org 不明の書込は「両組織ロック時のみ」拒否（安全側に倒しすぎて業務停止しない）
  return lockedHibi && lockedHfu
}

/**
 * Firestore からロック状態を取得して判定。ロック済みならエラーメッセージを返す。
 * 判定不能（読み取り失敗）時は null（= 書込許可）。ロック判定のために業務を止めない。
 *
 * @param ym  YYYYMM
 * @param org 'hibi' | 'hfu' | ワーカーの org 値（日比/HFU表記も可）。省略時は全体ロックのみ判定
 */
export async function checkMonthLocked(ym: string, org?: string): Promise<string | null> {
  if (!/^\d{6}$/.test(ym)) return null
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    const locks = snap.exists() ? (snap.data().locks as Record<string, unknown> | undefined) : undefined
    if (isMonthLockedInLocks(locks, ym, org)) {
      return `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月は月次締め（ロック）済みのため変更できません。変更が必要な場合は月次集計画面でロックを解除してください`
    }
    return null
  } catch {
    return null
  }
}

/** 締めのメッセージ（checkMonthLocked と同じ文言） */
function lockedMessage(ym: string): string {
  return `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月は月次締め（ロック）済みのため変更できません。変更が必要な場合は月次集計画面でロックを解除してください`
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
    return String(w.org || '').toLowerCase() === 'hfu' ? 'hfu' : 'hibi'
  })
  const known = orgs.filter((o): o is string => !!o)
  if (known.some(o => isMonthLockedInLocks(locks, ym, o))) return true
  if (known.length === workerIds.length && workerIds.length > 0) return false
  // 会社が決まらない分
  if (unknownOrg === 'both') return isMonthLockedInLocks(locks, ym)
  return isMonthLockedInLocks(locks, ym, 'hibi') || isMonthLockedInLocks(locks, ym, 'hfu')
}

/**
 * 出面など「人に付く書き込み」の締めチェック（2026-10-02 総合点検）。締め済みならエラーメッセージを返す。
 *
 * 根本原因: checkMonthLocked(ym) を会社なしで呼ぶと「両社とも締めたときだけ」拒否になる。
 *   スタッフのスマホ（Worker 型に org が無く常に undefined）・職長トークン・工種の移動・履歴からの復元・運転者の記録が
 *   これで、片方の会社（例: 日比建設）だけ締めた間、その会社の人の出面を書けた（締め後に支給額が変わる）。
 *   出面グリッドは判定を自前で書き、30秒キャッシュの人員マスタを使っていた（締めた直後は古い状態で通る）。
 * 対処: 人の会社は人員マスタ（生データの org）から引く。main は読み直す（キャッシュを使わない）。
 */
export async function checkMonthLockedForWorkers(
  ym: string,
  workerIds: readonly (number | string | null | undefined)[],
  unknownOrg: 'either' | 'both' = 'either',
): Promise<string | null> {
  if (!/^\d{6}$/.test(ym)) return null
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    if (!snap.exists()) return null
    const data = snap.data()
    const ids = workerIds.map(Number).filter(Number.isFinite)
    const locked = isMonthLockedForWorkers(
      data.locks as Record<string, unknown> | undefined,
      (data.workers || []) as { id?: unknown; org?: unknown }[],
      ym, ids, unknownOrg,
    )
    return locked ? lockedMessage(ym) : null
  } catch {
    return null
  }
}

/**
 * 締めの状態と人員マスタを1回だけ読み、何人・何か月ぶんも判定するための入れ物（一覧の処理用）。
 * 読めなければ「締めていない」扱い（checkMonthLocked と同じ・締めの判定のために業務を止めない）
 */
export async function loadLockContext(): Promise<{ isLocked: (ym: string, workerId: number) => boolean }> {
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    const data = snap.exists() ? snap.data() : {}
    const locks = data.locks as Record<string, unknown> | undefined
    const rawWorkers = (data.workers || []) as { id?: unknown; org?: unknown }[]
    return { isLocked: (ym, workerId) => isMonthLockedForWorkers(locks, rawWorkers, ym, [workerId], 'either') }
  } catch {
    return { isLocked: () => false }
  }
}

/** ISO 日付 (YYYY-MM-DD) から ym (YYYYMM) を得る */
export function ymOfDate(dateIso: string): string {
  return dateIso.slice(0, 7).replace('-', '')
}

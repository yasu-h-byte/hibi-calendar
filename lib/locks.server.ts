/**
 * 月次締め（ロック）の判定のうち Firestore を読むもの（**サーバー専用**・2026-10-21 総点検で lib/locks.ts から移した）
 *
 * 純粋な判定（isMonthLockedInLocks / isMonthLockedForWorkers / orgKeyOf / ymOfDate）は lib/locks.ts のまま。
 * 画面（スマホ出面など）は lib/locks.ts だけを import するので、Firebase Web SDK がクライアント JS に載らない。
 *
 * 会社なしで呼べた checkMonthLocked(ym, org?) は 2026-10-21 に廃止（org が undefined だと「両社とも締めたときだけ」
 * 拒否になり、人員マスタに無い人・会社を自前で判定した経路が抜けていた）。人に付く書き込みは
 * checkMonthLockedForWorkers（1 回）か loadLockContext（何か月・何人も）を使う。
 */
import 'server-only'
import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { isMonthLockedInLocks, isMonthLockedForWorkers, orgKeyOf } from './locks'

/** 締めのメッセージ（締め済みのときに API が返す文言） */
export function lockedMessage(ym: string): string {
  return `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月は締めが済んでいるため変えられません。直すときは、事務か政仁さんに締めを外してもらってください（月次集計・締めの画面）`
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
 * 「この日から」（適用開始日 'YYYY-MM-DD'）以降に締め済みの月があれば、その締めのキー（'202609_hibi' など）を返す。
 * 号俸の改定（app/api/jp-wage/revision）と人員マスタの給与欄の開始日（app/api/workers）で共通（2026-10-21 代表決定）。
 * 開始日を締め済みの月の途中にすると、按分で締めた月の支給額が変わるため、先に締めを解除してもらう。
 * @param org 会社（'hibi' / 'hfu'）。渡すとその会社の締めだけ（全体ロック含む）。省略＝どの会社の締めでも
 */
export async function lockedMonthsFrom(effectiveIso: string, org?: string): Promise<string[]> {
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    const locks = ((snap.exists() ? snap.data() : {}) as { locks?: Record<string, boolean> }).locks || {}
    const fromYm = effectiveIso.slice(0, 4) + effectiveIso.slice(5, 7)
    const orgKey = org ? orgKeyOf(org) : null
    return Object.entries(locks)
      .filter(([k, v]) => v === true && /^\d{6}(_|$)/.test(k) && k.slice(0, 6) >= fromYm)
      .filter(([k]) => !orgKey || k.length === 6 || k.endsWith('_' + orgKey))
      .map(([k]) => k)
  } catch {
    return []
  }
}

/**
 * 締めの状態と人員マスタを1回だけ読み、何人・何か月ぶんも判定するための入れ物（一覧の処理用）。
 * 読めなければ「締めていない」扱い（締めの判定のために業務を止めない）
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

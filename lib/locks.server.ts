/**
 * 月次締め（ロック）の判定のうち Firestore を読むもの（**サーバー専用**・2026-10-21 総点検で lib/locks.ts から移した）
 *
 * 純粋な判定（isMonthLockedInLocks / isMonthLockedForWorkers / orgKeyOf / ymOfDate）は lib/locks.ts のまま。
 * 画面（スマホ出面など）は lib/locks.ts だけを import するので、Firebase Web SDK がクライアント JS に載らない。
 *
 * ⚠️ 会社なしの checkMonthLocked(ym) は「両社とも締めたときだけ」拒否になる。人に付く書き込みは
 *    checkMonthLockedForWorkers を使う（CLAUDE.md「並べる方式をやめ、既定を安全側にする」）
 */
import 'server-only'
import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { isMonthLockedInLocks, isMonthLockedForWorkers } from './locks'

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

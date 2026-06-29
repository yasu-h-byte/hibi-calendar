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

/** ISO 日付 (YYYY-MM-DD) から ym (YYYYMM) を得る */
export function ymOfDate(dateIso: string): string {
  return dateIso.slice(0, 7).replace('-', '')
}

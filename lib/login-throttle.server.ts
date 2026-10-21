/**
 * ログインの試行回数制限（**サーバー専用**・2026-10-21 代表決定「10 回失敗したら 15 分止める」）。
 *
 * 旧: 公開のログイン口（/api/auth）に回数制限がなく、1 回の試行で保存済み全員分のパスワード照合（scrypt）を回していた。
 * 新: 相手（IP）ごとに失敗を数え、15 分の窓で 10 回失敗したら 15 分は 429 で止める。成功したら数え直す。
 *
 * - 記録は Firestore `loginThrottle/{IP のハッシュ}`（生の IP は保存しない）
 * - 読めない・書けないときは止めない（ログインの制限のために業務を止めない。失敗の記録は黙って諦める）
 * - Vercel の有料 WAF は使わない
 */
import 'server-only'
import { createHash } from 'crypto'
import { db } from './firebase'
import { doc, getDoc, setDoc, deleteDoc } from '@/lib/fsdb'

export const LOGIN_MAX_FAILURES = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_LOCK_MS = 15 * 60 * 1000
const COLLECTION = 'loginThrottle'

interface ThrottleDoc {
  failures: number
  /** 窓の始まり（ISO）。これから LOGIN_WINDOW_MS 過ぎたら数え直す */
  windowStart: string
  /** この時刻（ISO）までは止める */
  lockedUntil?: string
}

function keyOf(ip: string | null | undefined): string {
  return createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24)
}

/** 純関数: 今の記録と今の時刻から「止めるべきか」 */
export function isLoginLocked(rec: ThrottleDoc | null | undefined, nowMs: number): boolean {
  return !!rec?.lockedUntil && Date.parse(rec.lockedUntil) > nowMs
}

/** 純関数: 失敗を 1 回足した後の記録（窓が過ぎていれば数え直し、上限に達したら lockedUntil を付ける） */
export function nextThrottleAfterFailure(rec: ThrottleDoc | null | undefined, nowMs: number): ThrottleDoc {
  const inWindow = !!rec && Date.parse(rec.windowStart) + LOGIN_WINDOW_MS > nowMs
  const failures = (inWindow ? rec!.failures : 0) + 1
  const out: ThrottleDoc = { failures, windowStart: inWindow ? rec!.windowStart : new Date(nowMs).toISOString() }
  if (failures >= LOGIN_MAX_FAILURES) out.lockedUntil = new Date(nowMs + LOGIN_LOCK_MS).toISOString()
  return out
}

/** 止めるべきなら、解除の時刻（ISO）を返す。そうでなければ null。読めないときも null（止めない） */
export async function loginLockedUntil(ip: string | null | undefined): Promise<string | null> {
  try {
    const snap = await getDoc(doc(db, COLLECTION, keyOf(ip)))
    const rec = snap.exists() ? (snap.data() as ThrottleDoc) : null
    return isLoginLocked(rec, Date.now()) ? rec!.lockedUntil! : null
  } catch {
    return null
  }
}

/** 失敗を 1 回記録する（書けなくても何もしない） */
export async function recordLoginFailure(ip: string | null | undefined): Promise<void> {
  try {
    const ref = doc(db, COLLECTION, keyOf(ip))
    const snap = await getDoc(ref)
    const rec = snap.exists() ? (snap.data() as ThrottleDoc) : null
    await setDoc(ref, nextThrottleAfterFailure(rec, Date.now()))
  } catch { /* 記録できなくてもログインは続ける */ }
}

/** 成功したら数え直す */
export async function clearLoginFailures(ip: string | null | undefined): Promise<void> {
  try { await deleteDoc(doc(db, COLLECTION, keyOf(ip))) } catch { /* ignore */ }
}

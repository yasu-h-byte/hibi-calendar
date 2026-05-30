/**
 * カレンダー署名の共通ロジック（2026-05-27 集約）
 *
 * /api/calendar/sign（旧: workerId 直渡し）と
 * /api/calendar/sign-self（新: token 認証）で共通する処理:
 *   - IP ハッシュ
 *   - 1 件の署名トランザクション（承認済み確認 + 冪等処理 + 書き込み）
 *
 * 以前は同じロジックが両 route で重複していた。
 */
import { db } from './firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'

/**
 * IP アドレスを短い hash 文字列に変換
 * 個人特定防止のため平文では保存しない
 */
export function hashIP(ip: string): string {
  let hash = 0
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export interface SignResult {
  siteId: string
  success: boolean
  error?: string
  signedAt?: string
}

/**
 * 1 件のサイト × 月 × ワーカーの署名を実行
 *
 * - siteCalendar の approved 確認（サーバ側の改ざん対策）
 * - 冪等: 既存署名があればその signedAt を返してスキップ
 * - 新規: calendarSign/{workerId}_{ym}_{siteId} に書き込み
 *
 * @param method 'tap' (旧フロー) / 'self_tap' (新フロー) — 分析用
 */
export async function signOneSiteForWorker(
  workerId: number,
  ym: string,
  siteId: string,
  ipHash: string,
  method: 'tap' | 'self_tap' = 'tap',
  signedAt: string = new Date().toISOString(),
): Promise<SignResult> {
  // approved 確認（クライアント改ざん対策で必ずサーバ側で再チェック）
  const calDocId = `${siteId}_${ym}`
  const calDoc = await getDoc(doc(db, 'siteCalendar', calDocId))
  if (!calDoc.exists() || calDoc.data().status !== 'approved') {
    return { siteId, success: false, error: 'Calendar not approved' }
  }

  // 既に署名済みなら冪等にスキップ
  const signDocId = `${workerId}_${ym}_${siteId}`
  const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))
  if (existingSign.exists()) {
    return { siteId, success: true, signedAt: existingSign.data().signedAt }
  }

  await setDoc(doc(db, 'calendarSign', signDocId), {
    workerId,
    ym,
    siteId,
    signedAt,
    method,
    ipHash,
  })
  return { siteId, success: true, signedAt }
}

/**
 * 複数サイトを並列にサインする（モバイル回線でも高速）
 *
 * 既存処理は for ループで sequential await していたため
 * 10 現場 = 20 RTT になっていた。並列化で 1〜2 RTT 相当に。
 */
export async function signMultipleSitesForWorker(
  workerId: number,
  ym: string,
  siteIds: string[],
  ipHash: string,
  method: 'tap' | 'self_tap' = 'tap',
): Promise<SignResult[]> {
  const signedAt = new Date().toISOString()
  return Promise.all(
    siteIds.map(siteId => signOneSiteForWorker(workerId, ym, siteId, ipHash, method, signedAt))
  )
}

/**
 * リクエストから IP を取り出して hash する
 */
export function getRequestIpHash(headers: Headers): string {
  const ip = headers.get('x-forwarded-for') || headers.get('x-real-ip') || 'unknown'
  return hashIP(ip)
}

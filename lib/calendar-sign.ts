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
 * 永続アーカイブ（calendarSignLog）への追記。
 *
 * 変形労働時間制の「事前確定・周知・同意」の法的証跡を**消えない形**で残すための
 * append-only ログ。live の calendarSign は承認取消(revert)/初期化(reset)で削除されるが、
 * 本ログは**絶対に削除しない**（過去どの月の承認状況もいつでも台帳出力できるようにするため）。
 *
 * - 1署名イベント = 1ドキュメント（再署名も別ドキュメントとして履歴を残す）
 * - signedDays: 署名した瞬間のカレンダー休日設定スナップショット（後から修正されても凍結）
 * - docId は (worker, ym, site, signedAt) で決まり冪等（同一イベントの二重起動でも重複しない）
 * - 署名本体が成功していれば、ログ書き込みの失敗は致命的ではない（backfill で後追い修復可能）
 *   ため try/catch で握りつぶす（署名 UX を止めない）。
 */
async function appendSignLog(params: {
  workerId: number
  ym: string
  siteId: string
  signedAt: string
  method: string
  ipHash: string
  resignCount: number
  event: 'sign' | 'resign'
  signedDays: Record<string, string> | null
  calendarApprovedAt: string | null
  /** 同意セレモニーで本人が入力した氏名（なりすまし対策・本人同意の証跡） */
  consentName?: string
}): Promise<void> {
  try {
    const safeStamp = params.signedAt.replace(/[/:.]/g, '-')
    const id = `${params.workerId}_${params.ym}_${params.siteId}_${safeStamp}`
    await setDoc(doc(db, 'calendarSignLog', id), {
      workerId: params.workerId,
      ym: params.ym,
      siteId: params.siteId,
      signedAt: params.signedAt,
      method: params.method,
      ipHash: params.ipHash,
      resignCount: params.resignCount,
      event: params.event,
      signedDays: params.signedDays ?? null,
      calendarApprovedAt: params.calendarApprovedAt ?? null,
      consentName: params.consentName || '',
      agreed: true,
      loggedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('appendSignLog failed (sign itself succeeded; backfill can repair):', e)
  }
}

/**
 * 1 件のサイト × 月 × ワーカーの署名を実行
 *
 * - siteCalendar の approved 確認（サーバ側の改ざん対策）
 * - 冪等: 既存署名がカレンダー最終更新 (updatedAt) 以降なら何もしない
 * - 再署名: 既存署名後にカレンダーが修正されていれば signedAt を更新（差分承認）
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
  consentName: string = '',
): Promise<SignResult> {
  // approved 確認（クライアント改ざん対策で必ずサーバ側で再チェック）
  const calDocId = `${siteId}_${ym}`
  const calDoc = await getDoc(doc(db, 'siteCalendar', calDocId))
  if (!calDoc.exists() || calDoc.data().status !== 'approved') {
    return { siteId, success: false, error: 'Calendar not approved' }
  }
  const calData = calDoc.data()
  const calUpdatedAt = (calData.updatedAt as string | undefined) || null
  // 署名時点のカレンダー内容スナップショット（永続アーカイブ用・B）
  const signedDays = (calData.days as Record<string, string> | undefined) || null
  const calendarApprovedAt = (calData.approvedAt as string | undefined) || null

  const signDocId = `${workerId}_${ym}_${siteId}`
  const existingSign = await getDoc(doc(db, 'calendarSign', signDocId))

  if (existingSign.exists()) {
    const existingSignedAt = existingSign.data().signedAt as string
    // 既存署名がカレンダー最終更新以降なら、再署名不要（冪等）
    if (!calUpdatedAt || existingSignedAt >= calUpdatedAt) {
      return { siteId, success: true, signedAt: existingSignedAt }
    }
    // それ以外は「再署名」として signedAt を更新し、履歴として previousSignedAt を残す
    const newResignCount = ((existingSign.data().resignCount as number) || 0) + 1
    await setDoc(doc(db, 'calendarSign', signDocId), {
      workerId,
      ym,
      siteId,
      signedAt,                          // 新しい署名時刻
      previousSignedAt: existingSignedAt, // 直前の署名時刻（再署名の証跡）
      resignCount: newResignCount,
      method,
      ipHash,
      consentName: consentName || '',    // 同意セレモニーで本人が入力した氏名
    })
    // 永続アーカイブにも追記（再署名イベント）
    await appendSignLog({ workerId, ym, siteId, signedAt, method, ipHash, resignCount: newResignCount, event: 'resign', signedDays, calendarApprovedAt, consentName })
    return { siteId, success: true, signedAt }
  }

  // 新規署名
  await setDoc(doc(db, 'calendarSign', signDocId), {
    workerId,
    ym,
    siteId,
    signedAt,
    method,
    ipHash,
    consentName: consentName || '',      // 同意セレモニーで本人が入力した氏名
  })
  // 永続アーカイブにも追記（新規署名イベント）
  await appendSignLog({ workerId, ym, siteId, signedAt, method, ipHash, resignCount: 0, event: 'sign', signedDays, calendarApprovedAt, consentName })
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
  consentName: string = '',
): Promise<SignResult[]> {
  const signedAt = new Date().toISOString()
  return Promise.all(
    siteIds.map(siteId => signOneSiteForWorker(workerId, ym, siteId, ipHash, method, signedAt, consentName))
  )
}

/**
 * リクエストから IP を取り出して hash する
 */
export function getRequestIpHash(headers: Headers): string {
  const ip = headers.get('x-forwarded-for') || headers.get('x-real-ip') || 'unknown'
  return hashIP(ip)
}

import { NextResponse } from 'next/server'
import { isAdminSdkActive, getAdminStatus } from '@/lib/firebase-admin'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { probeStaffDocsBucket } from '@/lib/storage-admin'
import { backupHealth, type LastBackupInfo } from '@/lib/backup-plan'
import { hasDedicatedSessionSecret } from '@/lib/session-token'

/**
 * ヘルス／稼働モード確認エンドポイント（Admin SDK 移行の検証・障害診断用・2026-06〜）
 *
 * 返すもの（秘密情報は一切含めない）:
 *   - adminMode: サービスアカウント鍵が設定され Admin SDK が初期化済みなら true
 *   - status / hasRawEnv / errorHint: Admin 初期化の自己診断
 *   - readOk / readError: 実際に1件 getDoc して読み取り経路が生きているか（2026-07 追加）
 *       adminMode:true なのに readOk:false のときが「初期化はOKだが読み取りが落ちる」障害。
 *       readError.message/code に生の例外を出す（demmen/toolBudget を1件読むだけ・データは返さない）。
 *   - storageOk / storageError: 書類庫のファイル置き場（Firebase Storage）に届くか（2026-09-28・中身は読まない）
 *   - backupOk / backupHoursAgo / backupErrorCount: 日次バックアップが動いているか（2026-10-02・中身は返さない）
 *   - time: サーバ時刻（ISO）
 *
 * 認証不要（公開GET）。
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  // auth: public — 稼働確認（個人情報なし）
  let adminMode = false
  let diag: ReturnType<typeof getAdminStatus> | null = null
  try {
    adminMode = isAdminSdkActive()
    diag = getAdminStatus()
  } catch (e) {
    adminMode = false
    diag = { status: 'init_error', hasRawEnv: false, hasB64Env: false, errorHint: e instanceof Error ? e.message.slice(0, 140) : String(e) }
  }

  // 実読み取りプローブ（失敗している経路の生エラーを掴む）
  let readOk = false
  let readError: { message: string; code: string | number | null; name: string } | null = null
  try {
    const snap = await getDoc(doc(db, 'demmen', 'toolBudget'))
    readOk = snap.exists()
  } catch (e) {
    readError = {
      message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      code: (e as { code?: string | number })?.code ?? null,
      name: e instanceof Error ? e.name : 'unknown',
    }
  }

  const storage = await probeStaffDocsBucket()

  // 日次バックアップの最終実行（demmen/system.lastBackup）。失敗の中身は返さない（件数だけ）
  let backup: { ok: boolean; hoursAgo: number | null; errorCount: number } = { ok: false, hoursAgo: null, errorCount: 0 }
  try {
    const sysSnap = await getDoc(doc(db, 'demmen', 'system'))
    const last = (sysSnap.exists() ? sysSnap.data().lastBackup : null) as LastBackupInfo | null
    const h = backupHealth(last, Date.now())
    backup = { ok: h.ok, hoursAgo: h.hoursAgo, errorCount: last?.errors?.length ?? 0 }
  } catch { /* readError 側に出る */ }

  return NextResponse.json({
    ok: true,
    adminMode,
    // 通行証の署名鍵に専用の SESSION_SECRET（32 文字以上）が使われているか（2026-10-21。未設定だと鍵がパスワードそのもの）
    sessionSecret: hasDedicatedSessionSecret(),
    ...diag,
    readOk,
    readError,
    storageOk: storage.ok,
    storageError: storage.error,
    backupOk: backup.ok,
    backupHoursAgo: backup.hoursAgo,
    backupErrorCount: backup.errorCount,
    // Vercel が動かしている Node の版（2026-10-23・eMudhra 認証局事件の対応確認用。
    // 偽の証明書を弾く修正は Node 22.23.4 / 24.22.1 / 26.12.1 以上。これより古ければ再デプロイで取り込む）
    node: process.version,
    time: new Date().toISOString(),
  })
}

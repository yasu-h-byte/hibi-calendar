import { NextResponse } from 'next/server'
import { isAdminSdkActive, getAdminStatus } from '@/lib/firebase-admin'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'

/**
 * ヘルス／稼働モード確認エンドポイント（Admin SDK 移行の検証・障害診断用・2026-06〜）
 *
 * 返すもの（秘密情報は一切含めない）:
 *   - adminMode: サービスアカウント鍵が設定され Admin SDK が初期化済みなら true
 *   - status / hasRawEnv / errorHint: Admin 初期化の自己診断
 *   - readOk / readError: 実際に1件 getDoc して読み取り経路が生きているか（2026-07 追加）
 *       adminMode:true なのに readOk:false のときが「初期化はOKだが読み取りが落ちる」障害。
 *       readError.message/code に生の例外を出す（demmen/toolBudget を1件読むだけ・データは返さない）。
 *   - time: サーバ時刻（ISO）
 *
 * 認証不要（公開GET）。
 */
export const dynamic = 'force-dynamic'

export async function GET() {
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

  return NextResponse.json({
    ok: true,
    adminMode,
    ...diag,
    readOk,
    readError,
    time: new Date().toISOString(),
  })
}

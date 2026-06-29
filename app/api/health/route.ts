import { NextResponse } from 'next/server'
import { isAdminSdkActive } from '@/lib/firebase-admin'

/**
 * ヘルス／稼働モード確認エンドポイント（Admin SDK 移行の検証用・2026-06）
 *
 * 目的:
 *   Admin SDK 移行（守る①）は「鍵を入れた瞬間だけ Web→Admin に切り替わる」デュアルモード。
 *   しかし外から見ると Web/Admin どちらでも 200 を返すため、**鍵が効いて Admin モードで
 *   動いているのか区別できない**＝検証ができない、という欠落があった。
 *   本エンドポイントは `isAdminSdkActive()` を公開し、その区別を可能にする。
 *
 * 返すもの（秘密情報は一切含めない）:
 *   - adminMode: サービスアカウント鍵が設定され Admin SDK が初期化済みなら true
 *   - ok: 常に true（到達確認）
 *   - time: サーバ時刻（ISO）
 *
 * 認証不要（公開GET）。漏れる情報は「Admin SDK を使っているか否か」のbool のみで、
 * 攻撃者の利得はない。検証スクリプトから鍵なしで叩けるよう公開にしている。
 */
export const dynamic = 'force-dynamic'

export function GET() {
  let adminMode = false
  try {
    adminMode = isAdminSdkActive()
  } catch {
    adminMode = false
  }
  return NextResponse.json({
    ok: true,
    adminMode,
    time: new Date().toISOString(),
  })
}

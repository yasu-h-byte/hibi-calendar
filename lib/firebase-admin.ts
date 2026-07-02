/**
 * Firebase Admin SDK の遅延初期化（2026-06-13 監査 Sprint3）。
 *
 * 目的: サーバ（API ルート）からの Firestore アクセスを「サービスアカウント権限」で
 * 行えるようにし、その後 firestore.rules を deny-by-default に切り替えても
 * サーバ機能が動くようにする（rules バイパスは Admin SDK の特権）。
 *
 * 【重要 - デュアルモード】
 *  - サービスアカウントが未設定なら getAdminDb() は null を返す。
 *    その場合、呼び出し側（lib/fsdb.ts）は従来どおり Web SDK を使う。
 *    → env を設定するまで挙動は1ミリも変わらない（完全な後方互換）。
 *  - 設定方法は docs/admin-sdk-migration.md を参照。
 *
 * 【クライアントバンドル混入の回避】
 *  - 'firebase-admin' を静的 import せず、関数内で eval('require') する。
 *    Next.js/webpack の静的解析に引っかからないため、クライアントバンドルに
 *    Node 専用パッケージが混入しない。クライアントから本ファイルが import されても
 *    getAdminDb() は（window 環境では）null を返すだけで壊れない。
 *
 * 環境変数（いずれか）:
 *  - FIREBASE_SERVICE_ACCOUNT_B64 : サービスアカウント JSON を base64 した文字列（推奨）
 *  - FIREBASE_SERVICE_ACCOUNT     : サービスアカウント JSON をそのまま（1行）
 */

// firebase-admin の型は any 扱い（依存は遅延ロード）
/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminFirestore = any

let cached: { db: AdminFirestore | null; admin: any | null } | null = null

/**
 * Admin SDK 初期化の状態（/api/health 経由の遠隔診断用）。
 * - 'unset'       : 鍵 env が未設定（＝Web モードで正常運用中）
 * - 'active'      : 鍵を読み Admin SDK 初期化成功（Admin モード）
 * - 'parse_error' : env はあるが JSON 解析に失敗（貼り付けで改行崩れ等）
 * - 'init_error'  : 解析は通ったが cert()/require で失敗（private_key 不正・依存欠落等）
 * - 'browser'     : ブラウザ実行（Admin は使わない）
 */
export type AdminInitStatus = 'unset' | 'active' | 'parse_error' | 'init_error' | 'browser'
let initStatus: AdminInitStatus = 'unset'
let initErrorHint: string | null = null

/** 鍵 env の存在チェック（値は返さない・bool 判定のみ） */
function readServiceAccountEnv(): { present: boolean; value?: string; isB64?: boolean } {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (b64 && b64.trim()) return { present: true, value: b64.trim(), isB64: true }
  if (raw && raw.trim()) return { present: true, value: raw.trim(), isB64: false }
  return { present: false }
}

/** env から JSON を取り出してパース。解析失敗時は throw（呼び出し側で parse_error 判定） */
function loadServiceAccount(): Record<string, unknown> | null {
  const env = readServiceAccountEnv()
  if (!env.present) return null
  const json = env.isB64 ? Buffer.from(env.value as string, 'base64').toString('utf-8') : (env.value as string)
  return JSON.parse(json)
}

/**
 * Admin SDK の Firestore インスタンスを返す。未設定なら null（= Web SDK にフォールバック）。
 */
export function getAdminDb(): AdminFirestore | null {
  // ブラウザでは絶対に Admin SDK を使わない
  if (typeof window !== 'undefined') {
    initStatus = 'browser'
    return null
  }
  if (cached) return cached.db

  const env = readServiceAccountEnv()
  if (!env.present) {
    initStatus = 'unset'
    cached = { db: null, admin: null }
    return null
  }

  let svc: Record<string, unknown> | null = null
  try {
    svc = loadServiceAccount()
  } catch (e) {
    initStatus = 'parse_error'
    initErrorHint = (e instanceof Error ? e.message : String(e)).slice(0, 140)
    console.error('[firebase-admin] サービスアカウントの解析に失敗（env の値を確認）:', e)
    cached = { db: null, admin: null }
    return null
  }
  if (!svc) {
    initStatus = 'unset'
    cached = { db: null, admin: null }
    return null
  }

  try {
    // firebase-admin は next.config.js の experimental.serverComponentsExternalPackages
    // でサーバ外部依存として扱う（クライアントに出さず、サーバ関数には同梱トレース）。
    // 以前は eval('require') でバンドル回避していたが、それだと Next の依存トレーサからも
    // 隠れてしまい Vercel 上で "Cannot find module 'firebase-admin'" になった（2026-06 判明）。
    //
    // firebase-admin v14 はモジュラー API。app 関数は 'firebase-admin/app'、
    // Firestore は 'firebase-admin/firestore' から取得する（旧 namespaced な
    // admin.apps / admin.credential / admin.firestore() は存在しない）。
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { initializeApp, getApps, cert } = require('firebase-admin/app')
    const firestoreMod = require('firebase-admin/firestore')
    /* eslint-enable @typescript-eslint/no-var-requires */
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(svc as any),
        projectId: (svc as any).project_id,
      })
    }
    const adminDb = firestoreMod.getFirestore()
    // gRPC idle 切断（2026-06-30 の断続500）対策で REST 固定にする。
    //   ※ 2026-07-02 の恒常 500 は preferRest とは無関係の Firestore 読み取りクォータ超過
    //     （Sparkプランの日次上限）で、gRPC/REST どちらでも RESOURCE_EXHAUSTED になることを確認済み。
    //     根本対策は Blaze 化＋読み取り量削減。preferRest はサーバレス安定性のため維持する。
    try {
      adminDb.settings({ preferRest: true })
    } catch { /* 既に設定済み/操作後なら無視 */ }
    // cached.admin には firestore モジュールを保持（getAdminFieldValue が FieldValue を使う）
    cached = { db: adminDb, admin: firestoreMod }
    initStatus = 'active'
    return cached.db
  } catch (e) {
    initStatus = 'init_error'
    initErrorHint = (e instanceof Error ? e.message : String(e)).slice(0, 140)
    console.error('[firebase-admin] 初期化に失敗（firebase-admin 未インストール？private_key 不正？）:', e)
    cached = { db: null, admin: null }
    return null
  }
}

/**
 * Admin モード時の FieldValue（deleteField 等のセンチネル生成用）。
 * 未設定（Web モード）なら null。lib/fsdb.ts の deleteField() が使う。
 */
export function getAdminFieldValue(): any | null {
  getAdminDb() // 初期化を保証（cached を埋める）
  // cached.admin は 'firebase-admin/firestore' モジュール。FieldValue.delete() 等を提供。
  return cached?.admin ? cached.admin.FieldValue : null
}

/** サーバが Admin SDK モードで動いているか（運用画面での可視化用） */
export function isAdminSdkActive(): boolean {
  return getAdminDb() !== null
}

/**
 * 初期化状態の遠隔診断（/api/health 用・秘密情報は含めない）。
 * - status: 上記 AdminInitStatus
 * - hasRawEnv / hasB64Env: 鍵 env がこのランタイムに届いているか（bool のみ）
 * - errorHint: parse/init 失敗時のエラー要約（先頭140字・鍵素材は含まない）
 */
export function getAdminStatus(): {
  status: AdminInitStatus
  hasRawEnv: boolean
  hasB64Env: boolean
  errorHint: string | null
} {
  getAdminDb() // 初期化を試行して initStatus を確定
  return {
    status: initStatus,
    hasRawEnv: !!(process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.trim()),
    hasB64Env: !!(process.env.FIREBASE_SERVICE_ACCOUNT_B64 && process.env.FIREBASE_SERVICE_ACCOUNT_B64.trim()),
    errorHint: initErrorHint,
  }
}

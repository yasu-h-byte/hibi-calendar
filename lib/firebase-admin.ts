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

function loadServiceAccount(): Record<string, unknown> | null {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  try {
    if (b64 && b64.trim()) {
      const json = Buffer.from(b64.trim(), 'base64').toString('utf-8')
      return JSON.parse(json)
    }
    if (raw && raw.trim()) {
      return JSON.parse(raw.trim())
    }
  } catch (e) {
    console.error('[firebase-admin] サービスアカウントの解析に失敗（env の値を確認）:', e)
  }
  return null
}

/**
 * Admin SDK の Firestore インスタンスを返す。未設定なら null（= Web SDK にフォールバック）。
 */
export function getAdminDb(): AdminFirestore | null {
  // ブラウザでは絶対に Admin SDK を使わない
  if (typeof window !== 'undefined') return null
  if (cached) return cached.db

  const svc = loadServiceAccount()
  if (!svc) {
    cached = { db: null, admin: null }
    return null
  }

  try {
    // 静的解析回避のための eval-require（webpack にバンドルさせない）
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
    const req = eval('require') as NodeRequire
    const admin = req('firebase-admin')
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(svc as any),
        projectId: (svc as any).project_id,
      })
    }
    cached = { db: admin.firestore(), admin }
    return cached.db
  } catch (e) {
    console.error('[firebase-admin] 初期化に失敗（firebase-admin 未インストール？）:', e)
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
  return cached?.admin ? cached.admin.firestore.FieldValue : null
}

/** サーバが Admin SDK モードで動いているか（運用画面での可視化用） */
export function isAdminSdkActive(): boolean {
  return getAdminDb() !== null
}

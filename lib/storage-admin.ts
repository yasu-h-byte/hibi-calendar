/**
 * Firebase Storage（Admin SDK）— 書類庫のファイル置き場（2026-09-28）。
 *
 * バケット: dedura-kanri.firebasestorage.app（東京 asia-northeast1）
 *   - セキュリティルールは本番モード（allow read, write: if false）＝ブラウザの Firebase SDK からは一切触れない
 *   - 公開アクセス防止（publicAccessPrevention: enforced）＝誤って公開URLにできない
 *   - CORS: https://hibi-calendar.vercel.app と http://localhost:3000 からの PUT/GET だけ許可
 *     （署名つきURLへブラウザが直接アップロード・閲覧するため）
 * 読み書きは必ずこのファイル経由のサーバー（Admin SDK・サービスアカウント権限）で行い、
 * ブラウザには「15分で切れる署名つきURL」だけを渡す。
 *
 * サーバー専用。クライアントからは import しないこと（next.config.js で firebase-admin/storage は空モジュール化）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { getAdminDb } from './firebase-admin'

export const STAFF_DOCS_BUCKET = 'dedura-kanri.firebasestorage.app'

/** 署名つきURLの有効期限 */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000

/** Admin SDK のバケット。サービスアカウント未設定（ローカル開発など）なら null */
export function getStaffDocsBucket(): any | null {
  if (typeof window !== 'undefined') return null
  // app の初期化は getAdminDb() が担う（サービスアカウント鍵が無ければ null）
  if (!getAdminDb()) return null
  const { getStorage } = require('firebase-admin/storage')
  return getStorage().bucket(STAFF_DOCS_BUCKET)
}

/** ブラウザから直接 PUT するための署名つきURL（Content-Type はこの値で固定される） */
export async function signedUploadUrl(path: string, contentType: string): Promise<string> {
  const bucket = getStaffDocsBucket()
  if (!bucket) throw new Error('STORAGE_UNAVAILABLE')
  const [url] = await bucket.file(path).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + SIGNED_URL_TTL_MS,
    contentType,
  })
  return url
}

/** 閲覧用の署名つきURL（ブラウザで開く。ダウンロードではなく表示） */
export async function signedReadUrl(path: string, fileName: string): Promise<string> {
  const bucket = getStaffDocsBucket()
  if (!bucket) throw new Error('STORAGE_UNAVAILABLE')
  const [url] = await bucket.file(path).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
    responseDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  })
  return url
}

/** アップロード済みか（commit 時の確認）。大きさも返す */
export async function fileMeta(path: string): Promise<{ exists: boolean; size: number; contentType: string }> {
  const bucket = getStaffDocsBucket()
  if (!bucket) throw new Error('STORAGE_UNAVAILABLE')
  const f = bucket.file(path)
  const [exists] = await f.exists()
  if (!exists) return { exists: false, size: 0, contentType: '' }
  const [meta] = await f.getMetadata()
  return { exists: true, size: Number(meta.size || 0), contentType: String(meta.contentType || '') }
}

export async function deleteFile(path: string): Promise<void> {
  const bucket = getStaffDocsBucket()
  if (!bucket) throw new Error('STORAGE_UNAVAILABLE')
  await bucket.file(path).delete({ ignoreNotFound: true })
}

/** /api/health 用: バケットに届くか（中身は読まない） */
export async function probeStaffDocsBucket(): Promise<{ ok: boolean; error: string | null }> {
  try {
    const bucket = getStaffDocsBucket()
    if (!bucket) return { ok: false, error: 'admin_unavailable' }
    const [exists] = await bucket.exists()
    return { ok: !!exists, error: exists ? null : 'bucket_not_found' }
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 140) }
  }
}

/**
 * demmen/main ドキュメントへのアクセスを集約するリポジトリ層
 *
 * 36+箇所で重複していた `doc(db, 'demmen', 'main')` + getDoc/updateDoc
 * のパターンを一元化。型安全な読み取りと統一的な書き込みを提供。
 *
 * キャッシュ層により、同一リクエスト内での重複読み取りを削減。
 */

import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc, setDoc, FieldValue } from 'firebase/firestore'

const MAIN_DOC_PATH = ['demmen', 'main'] as const

/** demmen/main ドキュメントの型（Firestoreに保存されている生データ） */
export type MainDocData = Record<string, unknown>

// ────────────────────────────────────────
//  キャッシュ
// ────────────────────────────────────────

let cachedData: MainDocData | null = null
let cacheTimestamp = 0
const CACHE_TTL = 5_000 // 5秒（同一リクエスト内の重複読み込み防止）

/** キャッシュをクリア（書き込み後に呼ぶ） */
export function clearMainDataCache(): void {
  cachedData = null
  cacheTimestamp = 0
}

// ────────────────────────────────────────
//  Read
// ────────────────────────────────────────

/**
 * demmen/main の生データを取得（キャッシュあり）
 *
 * @param noCache true の場合キャッシュを無視
 */
export async function getMainDocRaw(noCache = false): Promise<MainDocData> {
  const now = Date.now()
  if (!noCache && cachedData && now - cacheTimestamp < CACHE_TTL) {
    return cachedData
  }
  const snap = await getDoc(doc(db, MAIN_DOC_PATH[0], MAIN_DOC_PATH[1]))
  if (!snap.exists()) {
    cachedData = {}
    cacheTimestamp = now
    return {}
  }
  cachedData = snap.data() as MainDocData
  cacheTimestamp = now
  return cachedData
}

/**
 * 特定のフィールドだけを取得（型キャスト付き）
 * 存在しない場合は defaultValue を返す
 */
export async function getMainDocField<T>(
  field: string,
  defaultValue: T,
): Promise<T> {
  const data = await getMainDocRaw()
  const value = data[field]
  return value === undefined || value === null ? defaultValue : (value as T)
}

// ────────────────────────────────────────
//  Write
// ────────────────────────────────────────

/**
 * 部分更新（updateDoc）
 * 書き込み後にキャッシュをクリア
 */
export async function updateMainDoc(updates: Record<string, unknown>): Promise<void> {
  await updateDoc(doc(db, MAIN_DOC_PATH[0], MAIN_DOC_PATH[1]), updates)
  clearMainDataCache()
}

/**
 * マージ書き込み（setDoc with merge）
 * フィールドが存在しない場合の作成にも対応
 */
export async function mergeMainDoc(updates: Record<string, unknown>): Promise<void> {
  await setDoc(doc(db, MAIN_DOC_PATH[0], MAIN_DOC_PATH[1]), updates, { merge: true })
  clearMainDataCache()
}

/**
 * フィールドを削除（FieldValue.delete()）
 */
export async function deleteMainDocField(field: string): Promise<void> {
  const { deleteField } = await import('firebase/firestore')
  await updateDoc(doc(db, MAIN_DOC_PATH[0], MAIN_DOC_PATH[1]), {
    [field]: deleteField() as unknown as FieldValue,
  })
  clearMainDataCache()
}

// ────────────────────────────────────────
//  ヘルパー: ドキュメント参照を直接取得
// ────────────────────────────────────────

/** 既存コードがdoc(db, 'demmen', 'main')を直接使うパターン用の互換関数 */
export function mainDocRef() {
  return doc(db, MAIN_DOC_PATH[0], MAIN_DOC_PATH[1])
}

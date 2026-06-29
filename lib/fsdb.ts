/**
 * Firestore アクセスの抽象シム（Admin SDK 移行・Sprint3-2 / 2026-06）
 *
 * サーバ側の各ファイルは `from 'firebase/firestore'` を `from '@/lib/fsdb'` に差し替えるだけで、
 * 「Admin SDK（サービスアカウント鍵あり）」と「Web SDK（鍵なし＝従来どおり）」を自動で切り替える。
 *
 * 【最重要・後方互換】
 *   サービスアカウント鍵が未設定なら getAdminDb() は null を返し、本シムは Web SDK へ
 *   完全パススルーする。つまり**鍵を入れるまで挙動は1ミリも変わらない**。
 *   鍵を入れた瞬間だけ Admin SDK（rules バイパス特権）に切り替わり、deny-by-default の
 *   firestore.rules でもサーバ機能が動くようになる。
 *
 * Web SDK と同じ関数シグネチャを提供する（doc/getDoc/setDoc/...）。Admin SDK の
 * 戻り値は Web 形式（snap.exists() メソッド等）にラップして返す。
 *
 * クライアントからは絶対に import しないこと（サーバ専用）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as web from 'firebase/firestore'
import { db as webDb } from './firebase'
import { getAdminDb, getAdminFieldValue } from './firebase-admin'

// 型はそのまま Web SDK のものを再エクスポート（型注釈用・実行時に影響なし）
export type {
  DocumentReference, FieldValue, DocumentData, QueryDocumentSnapshot,
  DocumentSnapshot, QueryConstraint, CollectionReference, Query, QuerySnapshot,
  Transaction, WhereFilterOp, OrderByDirection,
} from 'firebase/firestore'

// Web/Admin 両対応のスナップショット型（呼び出し側の d:any を防ぐため最小限を型付け）
export interface FsDocSnap {
  exists: () => boolean
  data: () => any
  id: string
  ref: any
}
export interface FsQuerySnap {
  docs: FsDocSnap[]
  size: number
  empty: boolean
  forEach: (cb: (d: FsDocSnap, index?: number) => void) => void
}

/** Admin モードなら admin の Firestore、そうでなければ null */
function adb(): any | null {
  return getAdminDb()
}

/**
 * 第1引数として渡される db。Web モードでは実 db、Admin モードでも非null であれば十分
 * （本シムの各関数は内部でモードを判定し、この値は実際には使わない）。
 */
export const db: any = webDb

// ── 参照の生成 ──
export function doc(_db: any, ...segments: string[]): any {
  const a = adb()
  if (!a) return (web.doc as any)(webDb, ...segments)
  return a.doc(segments.join('/'))
}

export function collection(_db: any, ...segments: string[]): any {
  const a = adb()
  if (!a) return (web.collection as any)(webDb, ...segments)
  return a.collection(segments.join('/'))
}

// ── クエリ制約（Admin では「クエリに適用する関数」として表現） ──
export function where(field: string, op: any, value: any): any {
  const a = adb()
  if (!a) return web.where(field, op, value)
  return (q: any) => q.where(field, op, value)
}
export function orderBy(field: string, direction?: any): any {
  const a = adb()
  if (!a) return web.orderBy(field, direction)
  return (q: any) => q.orderBy(field, direction)
}
export function limit(n: number): any {
  const a = adb()
  if (!a) return web.limit(n)
  return (q: any) => q.limit(n)
}
export function query(collectionRef: any, ...constraints: any[]): any {
  const a = adb()
  if (!a) return (web.query as any)(collectionRef, ...constraints)
  return constraints.reduce((q: any, c: any) => c(q), collectionRef)
}

// ── 読み取り ──
function wrapDocSnap(snap: any): FsDocSnap {
  return {
    exists: () => snap.exists,
    data: () => snap.data(),
    id: snap.id,
    ref: snap.ref,
  }
}
export async function getDoc(ref: any): Promise<FsDocSnap> {
  const a = adb()
  if (!a) return (await web.getDoc(ref)) as unknown as FsDocSnap
  return wrapDocSnap(await ref.get())
}
export async function getDocs(q: any): Promise<FsQuerySnap> {
  const a = adb()
  if (!a) return (await web.getDocs(q)) as unknown as FsQuerySnap
  const snap = await q.get()
  const docs: FsDocSnap[] = snap.docs.map((d: any) => ({
    id: d.id,
    data: () => d.data(),
    ref: d.ref,
    exists: () => d.exists,
  }))
  return {
    docs,
    size: snap.size,
    empty: snap.empty,
    forEach: (cb: (d: FsDocSnap, index?: number) => void) => docs.forEach(cb),
  }
}

// ── 書き込み ──
export async function setDoc(ref: any, data: any, options?: any): Promise<void> {
  const a = adb()
  if (!a) return web.setDoc(ref, data, options)
  await ref.set(data, options || {})
}
export async function updateDoc(ref: any, data: any): Promise<void> {
  const a = adb()
  if (!a) return web.updateDoc(ref, data)
  await ref.update(data)
}
export async function deleteDoc(ref: any): Promise<void> {
  const a = adb()
  if (!a) return web.deleteDoc(ref)
  await ref.delete()
}
export async function addDoc(collectionRef: any, data: any): Promise<any> {
  const a = adb()
  if (!a) return web.addDoc(collectionRef, data)
  return collectionRef.add(data)
}

// ── センチネル ──
export function deleteField(): any {
  const a = adb()
  if (!a) return web.deleteField()
  return getAdminFieldValue().delete()
}

// ── トランザクション ──
export async function runTransaction<T>(_db: any, updateFn: (tx: any) => Promise<T>): Promise<T> {
  const a = adb()
  if (!a) return web.runTransaction(webDb, updateFn as any) as Promise<T>
  return a.runTransaction(async (tx: any) => {
    const wrappedTx = {
      get: async (ref: any) => wrapDocSnap(await tx.get(ref)),
      set: (ref: any, data: any, options?: any) => tx.set(ref, data, options || {}),
      update: (ref: any, data: any) => tx.update(ref, data),
      delete: (ref: any) => tx.delete(ref),
    }
    return updateFn(wrappedTx)
  })
}

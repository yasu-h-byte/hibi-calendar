/**
 * Firestore 安全書き込みヘルパー
 *
 * ⚠️ 背景 (2026-05-07):
 *   Firebase JS SDK v11 の `setDoc(ref, data, { merge: true })` は、
 *   data 内で子フィールドの値として **空マップ `{}`** を渡すと、
 *   既存のそのフィールド全体が `{}` に置換される。
 *
 *   例: 既存 `{ d: { a: 1, b: 2 }, sd: { c: 3 } }` に対して
 *     setDoc(ref, { d: {} }, { merge: true })
 *   を実行すると、結果は `{ d: {}, sd: { c: 3 } }` になる（d内の子が全消失）。
 *
 *   この罠で 2026-05-07 に att_202605 の出面データが全消失する事故が発生。
 *
 * 安全な代替:
 *   - ドキュメント存在保証だけ → `ensureDocExists(ref)` を使う
 *   - 子フィールドの追加/更新 → 値が必ず非空であることを呼び出し側で保証する
 *   - 子フィールドの削除 → updateDoc + dot-notation + deleteField()
 *
 * このファイルの関数のみを使い、生の `setDoc(ref, { 何か: {} }, { merge: true })`
 * は **使わない** こと。
 */
import { DocumentReference, setDoc, getDoc, updateDoc } from 'firebase/firestore'

/**
 * ドキュメントが存在することを保証する。
 * 既存データには一切影響を与えない。
 *
 * 内部実装は `setDoc(ref, {}, { merge: true })`：
 *   - ドキュメント未存在 → 空ドキュメントを作成
 *   - ドキュメント存在 → 何も変更しない（top-level field を一切 mention しないため安全）
 */
export async function ensureDocExists(ref: DocumentReference): Promise<void> {
  await setDoc(ref, {}, { merge: true })
}

/**
 * ドキュメントが存在し、かつ指定の top-level field が存在することを保証する。
 * 必要な場合のみ初期値を書き込む（既に存在する場合は触らない）。
 *
 * 用途: att_YYYYMM ドキュメントを新規作成するとき、`d` と `sd` を
 * それぞれ空マップで初期化したいケース。ただし既存ドキュメントの
 * これらのフィールドには絶対に触れない。
 */
/**
 * Map 型フィールドの worker 単位更新（2026-06-XX 追加・CR-5 対応）
 *
 * 用途: plData = { "1": [...], "2": [...], ... } のような worker ID キーの
 * Map 型フィールドを「dot-notation で worker ごとに更新」する。
 *
 * これにより:
 * - `setDoc(ref, { plData: {} }, { merge: true })` の罠を完全回避
 * - 並列実行時の race condition を最小化（他 worker は触らない）
 * - 大量データ書き込みを 400件ずつチャンク化
 *
 * 注意: 既存 worker のレコードを「上書き」する用途。差分マージはしない。
 *       追加・削除も含めた完全置換なら、書き込み前にメモリ上で構築済みの
 *       worker レコード配列を渡すこと。
 *
 * @param ref       書き込み対象のドキュメント
 * @param mapField  対象フィールド名 (例: "plData")
 * @param updates   { workerId: 新しい値, ... } の map
 */
export async function updateMapByKey(
  ref: DocumentReference,
  mapField: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(updates)
  if (keys.length === 0) return
  // 400件ごとにチャンク化（Firestore updateDoc の上限を回避）
  const CHUNK = 400
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK)
    const payload: Record<string, unknown> = {}
    for (const k of chunk) {
      payload[`${mapField}.${k}`] = updates[k]
    }
    await updateDoc(ref, payload)
  }
}

export async function ensureFieldsInitialized(
  ref: DocumentReference,
  fields: string[]
): Promise<void> {
  const snap = await getDoc(ref)
  if (snap.exists()) {
    const data = snap.data()
    const missing: Record<string, unknown> = {}
    for (const f of fields) {
      if (data[f] === undefined) {
        missing[f] = {}
      }
    }
    if (Object.keys(missing).length > 0) {
      // ★ ここで { merge: true } を使うが、missing には新規フィールドのみ含まれるため
      //   既存フィールドは絶対に上書きされない。
      await setDoc(ref, missing, { merge: true })
    }
  } else {
    const init: Record<string, unknown> = {}
    for (const f of fields) {
      init[f] = {}
    }
    await setDoc(ref, init)
  }
}

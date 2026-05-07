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
import { DocumentReference, setDoc, getDoc } from 'firebase/firestore'

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

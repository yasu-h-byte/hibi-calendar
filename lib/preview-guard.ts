/**
 * お試しサイト（Vercel の Preview）から本番のデータを書き換えない（2026-11-10 全体点検）。
 *
 * 根本原因: お試しサイトは本番と同じ Firestore・同じファイル置き場につながっている（lib/firebase.ts は projectId 固定）。
 *   まだ確かめていない PR のコードで保存・締め・復元をすると、本番のデータがそのまま書き換わる。
 * 対処: お試しサイトでは、書き込みを既定で止める（読むのはこれまでどおり）。外すものだけを理由つきで並べる。
 *   - データベース: lib/fsdb.ts の書き込みの入口（setDoc / updateDoc / deleteDoc / addDoc / トランザクション）
 *   - ファイル置き場: lib/storage-admin.ts（置く・消す・置くための署名つきURL）
 * 保存まで試したい PR のときだけ、Vercel の Preview の環境変数に PREVIEW_ALLOW_WRITES=1 を入れて作り直す
 *   （本番のデータが変わるので、代表の OK をもらってから。終わったら外す）。
 * 本番と手元（VERCEL_ENV が preview でない）では何もしない。
 *
 * 根治は「お試し用の Firebase プロジェクトを分ける」こと（製品化の第1段階で、接続先を環境変数にするときに行う）。
 */

type Env = Record<string, string | undefined>

/** お試しサイトで、書き込みを止めている状態か */
export function isPreviewReadOnly(env: Env = process.env): boolean {
  return env.VERCEL_ENV === 'preview' && env.PREVIEW_ALLOW_WRITES !== '1'
}

/**
 * お試しサイトでも書いてよい場所（外すものだけを理由つきで並べる）。パスの先頭で見る。
 * ここに業務のデータ（demmen・有給・請求・評価など）を足さないこと。
 */
export const PREVIEW_WRITE_ALLOW_PREFIXES = [
  'loginThrottle/',   // ログインの失敗回数（止めると、お試しサイトの入口で総当たりの歯止めが効かなくなる）
  'accessLog/',       // スタッフのアクセス履歴（消えても業務に影響なし・バックアップの対象外）
] as const

export const PREVIEW_READ_ONLY_MESSAGE = 'お試しサイトでは保存できません（本番のデータを守るため、書き込みを止めています）'

/** お試しサイトで止めた書き込み */
export class PreviewReadOnlyError extends Error {
  constructor(public readonly path: string) {
    super(`${PREVIEW_READ_ONLY_MESSAGE}: ${path}`)
    this.name = 'PreviewReadOnlyError'
  }
}

/** その場所への書き込みを止めるか（純粋） */
export function isPreviewWriteBlocked(path: string | undefined | null, env: Env = process.env): boolean {
  if (!isPreviewReadOnly(env)) return false
  const p = `${path || ''}/`.replace(/\/+$/, '/')
  return !PREVIEW_WRITE_ALLOW_PREFIXES.some(prefix => p.startsWith(prefix))
}

/** 書き込みの入口で呼ぶ。止める場所なら PreviewReadOnlyError を投げる */
export function assertPreviewWritable(path: string | undefined | null, env: Env = process.env): void {
  if (isPreviewWriteBlocked(path, env)) throw new PreviewReadOnlyError(String(path || '(不明)'))
}

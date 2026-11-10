/**
 * demmen/main の「読んでから書く」あいだに、ほかの人が同じ所を書き換えていないかを確かめる（2026-11-10 全体点検）。
 *
 * 根本原因: 有給の記録（plData.{人}）・人員一覧（workers）・お知らせ（announcements）は
 *   「main を読む → 手元で配列を直す → 配列をまるごと書く」作りで、トランザクションが無かった。
 *   本人の申請の処理と事務の操作が重なると、あとから書いたほうが先の変更を黙って消す（後勝ち）。
 * 対処: 読んだ時点の中身を控えておき（captureMainGuard）、書く瞬間にトランザクションの中で読み直して、
 *   控えと違っていたら書かずに止める（lib/main-guard.server.ts guardedMainUpdate）。
 *   止めたときは 409 で「もう一度」と伝える。黙って消すより、やり直してもらうほうが安全。
 *
 * ここは純粋な決まりだけ（テストから読める）。書き込みは lib/main-guard.server.ts。
 */

/** 配列まるごとで書く top-level の項目。足すときはここに足す */
export const GUARD_FIELDS = ['workers', 'sites', 'announcements'] as const
export type GuardField = (typeof GUARD_FIELDS)[number]

export interface MainGuard {
  /** plData の人ごとの控え（キー = workerId の文字列） */
  pl: Record<string, string>
  /** 配列まるごとの項目の控え */
  fields: Record<GuardField, string>
}

export interface GuardCheck {
  /** 確かめる plData のキー。'all' は全員（一括の付与・時効・繰越） */
  plKeys?: string[] | 'all'
  /** 確かめる配列まるごとの項目 */
  fields?: GuardField[]
}

export const MAIN_CONFLICT_MESSAGE = 'ほかの人の操作と重なりました。画面を読み込み直して、もう一度お試しください'

/** ほかの人の書き込みと重なった（書かずに止めた） */
export class MainConflictError extends Error {
  constructor(public readonly where: string) {
    super(`main conflict: ${where}`)
    this.name = 'MainConflictError'
  }
}

/** キーの順番に左右されない JSON（Firestore のマップは読むたびに順番が変わりうる）。undefined の項目は無いものと同じ */
export function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 読んだ直後（手元で直す前）に呼ぶ */
export function captureMainGuard(data: Record<string, unknown> | undefined | null): MainGuard {
  const d = data || {}
  const plData = (d.plData || {}) as Record<string, unknown>
  const pl: Record<string, string> = {}
  for (const k of Object.keys(plData)) pl[k] = stableJson(plData[k])
  const fields = {} as Record<GuardField, string>
  for (const f of GUARD_FIELDS) fields[f] = stableJson(d[f])
  return { pl, fields }
}

/** 控えと今の中身を比べる。違っていた最初の場所（無ければ null） */
export function findMainConflict(guard: MainGuard, fresh: Record<string, unknown> | undefined | null, check: GuardCheck): string | null {
  const d = fresh || {}
  const plNow = (d.plData || {}) as Record<string, unknown>
  const keys = check.plKeys === 'all'
    ? Array.from(new Set([...Object.keys(guard.pl), ...Object.keys(plNow)]))
    : (check.plKeys || [])
  for (const k of keys) {
    if ((guard.pl[k] ?? 'null') !== stableJson(plNow[k])) return `plData.${k}`
  }
  for (const f of check.fields || []) {
    if (guard.fields[f] !== stableJson(d[f])) return f
  }
  return null
}

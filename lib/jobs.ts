/**
 * 職種分類の単一の真理ソース（2026-05-27 追加）
 *
 * 以前は以下のロジックが 4 ファイル以上に散在していた:
 *   `job === 'tobi' || job === 'tobi_apprentice' || job === 'shokucho' || job === 'yakuin'`
 *
 * 新しい職種を追加するたびに 4 箇所修正が必要で、追加漏れが起きやすい
 * （実際 `tobi_apprentice` 追加時に複数のファンアウト箇所を直す必要があった）。
 *
 * 本モジュールに集約することで、新規追加は配列を 1 行更新するだけで済む。
 */

/** 「鳶」集計に含める職種コード一覧（フッター人工合計・原価集計・ダッシュボード） */
export const TOBI_GROUP_JOBS = ['tobi', 'tobi_apprentice', 'shokucho', 'yakuin'] as const

/** 「土工」集計に含める職種コード */
export const DOKO_GROUP_JOBS = ['doko'] as const

/** 給与 / 出勤計算の対象外（事務系） */
export const NON_FIELD_JOBS = ['jimu'] as const

/**
 * 「鳶」グループ（鳶/見習い/職長/役員）か判定
 * 用途: 出面フッター合計、原価集計、ダッシュボードの人工分類など
 */
export function isTobiGroup(job: string | undefined | null): boolean {
  if (!job) return false
  return (TOBI_GROUP_JOBS as readonly string[]).includes(job)
}

/** 「土工」グループか判定 */
export function isDokoGroup(job: string | undefined | null): boolean {
  if (!job) return false
  return (DOKO_GROUP_JOBS as readonly string[]).includes(job)
}

/** 現場稼働しない職種（事務・役員）か判定。給与計算の主集計から外す用途 */
export function isNonFieldJob(job: string | undefined | null): boolean {
  if (!job) return false
  return (NON_FIELD_JOBS as readonly string[]).includes(job)
}

/** 職種コード → 日本語表示ラベル */
export const JOB_LABELS: Record<string, string> = {
  yakuin: '役員',
  shokucho: '職長',
  tobi: 'とび',
  tobi_apprentice: '鳶見習い',
  doko: '土工',
  jimu: '事務',
}

/** 表示用ラベル（不明なコードはそのまま返す） */
export function jobLabel(job: string | undefined | null): string {
  if (!job) return '—'
  return JOB_LABELS[job] || job
}

/** 短縮ラベル（出面の配置リスト等、スペースが狭い場所で使用） */
export const JOB_SHORT_LABELS: Record<string, string> = {
  yakuin: '役員',
  shokucho: '職長',
  tobi: '鳶',
  tobi_apprentice: '鳶見習い',
  doko: '土工',
  jimu: '事務',
}

export function jobShortLabel(job: string | undefined | null): string {
  if (!job) return ''
  return JOB_SHORT_LABELS[job] || job
}

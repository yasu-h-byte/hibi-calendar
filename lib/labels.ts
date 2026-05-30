/**
 * バッジ・ラベル表示の共通ヘルパー（2026-05-27 集約）
 *
 * 以前は visaBadge / orgBadge / jobBadge が attendance、cost、workers、
 * tool-budget の 4 ファイルに散在し、shape も挙動も微妙に違っていた:
 *   - 一方は "実習1号"、他方は "技能実習" を返す → ラベルドリフト
 *   - 一方は null 許容、他方は空文字 → 呼び出し側の null 判定が不揃い
 *
 * 本モジュールに集約。役職分類は lib/jobs.ts を参照（label 系のみここ）。
 */

// ─────────────────────────────────────────────────────────────
// ビザ
// ─────────────────────────────────────────────────────────────

/** ビザ別バッジ情報。日本人は null（バッジを出さない） */
export interface VisaBadge {
  label: string
  cls: string
}

/**
 * ビザコード → バッジ表示情報
 * 日本人（visa='none' or 空）は null を返す
 *
 * - jisshu1/2/3 → 実習1/2/3号（オレンジ）
 * - jisshu (旧) → 技能実習（オレンジ）
 * - tokutei1/2 → 特定1/2号（ピンク）
 * - tokutei (旧) → 特定技能（ピンク）
 */
export function visaBadge(visa: string | undefined | null): VisaBadge | null {
  if (!visa || visa === 'none') return null
  if (visa.startsWith('jisshu')) {
    const num = visa.replace('jisshu', '')
    return { label: num ? `実習${num}号` : '技能実習', cls: 'bg-orange-100 text-orange-700' }
  }
  if (visa.startsWith('tokutei')) {
    const num = visa.replace('tokutei', '')
    return { label: num ? `特定${num}号` : '特定技能', cls: 'bg-pink-100 text-pink-700' }
  }
  return null
}

/** ビザコード → ラベル文字列のみ（バッジ色不要な場合） */
export function visaLabel(visa: string | undefined | null): string {
  const b = visaBadge(visa)
  return b ? b.label : ''
}

// ─────────────────────────────────────────────────────────────
// 所属 (org × visa)
// ─────────────────────────────────────────────────────────────

/**
 * 所属バッジの CSS クラス
 *   外国人 → visa 色（実習: オレンジ、特定: ピンク）
 *   日本人 → org 色（hfu: 紫、hibi: 青）
 */
export function orgBadgeCls(org: string | undefined | null, visa: string | undefined | null): string {
  const v = visaBadge(visa)
  if (v) return v.cls
  return org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
}

/**
 * 所属バッジのラベル
 *   外国人 → ビザ短縮表記（実習1号 / 特定2号 など）
 *   日本人 → 会社名（HFU / 日比）
 */
export function orgBadgeLabel(org: string | undefined | null, visa: string | undefined | null): string {
  const v = visaBadge(visa)
  if (v) return v.label
  return org === 'hfu' ? 'HFU' : '日比'
}

// ─────────────────────────────────────────────────────────────
// 職種
// ─────────────────────────────────────────────────────────────

export interface JobBadge {
  label: string
  cls: string
}

/**
 * 職種コード → ラベル + 色クラスのペア（人員マスタ等の表示用）
 * Japanese-input compatibility（旧データで `'とび'` 等の日本語コードが入っている場合）も対応
 */
export function jobBadge(jobType?: string | null): JobBadge {
  switch (jobType) {
    case 'yakuin': case '役員': return { label: '役員', cls: 'bg-red-100 text-red-700' }
    case 'shokucho': case '職長': return { label: '職長', cls: 'bg-blue-100 text-blue-700' }
    case 'tobi': case 'とび': return { label: 'とび', cls: 'bg-green-100 text-green-700' }
    case 'tobi_apprentice': return { label: '鳶見習い', cls: 'bg-lime-100 text-lime-700' }
    case 'doko': case '土工': return { label: '土工', cls: 'bg-gray-200 text-gray-600' }
    case 'jimu': case '事務': return { label: '事務', cls: 'bg-purple-100 text-purple-700' }
    default: return { label: jobType || '—', cls: 'bg-gray-100 text-gray-500' }
  }
}

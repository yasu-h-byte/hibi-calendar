/**
 * 評価画面（app/(app)/evaluation/page.tsx）の純粋な関数・定数（2026-10-21 総点検 §7-2 で分離。中身は変えていない）。
 * 画面の見た目の決まり（ランクの色・評価日の計算・担当の範囲など）。Firestore は読まない。
 */
import { notify } from '@/lib/notify'
import { ABCGrade, Evaluation, EvaluationRank, EvaluationReview, EvaluationScores, EvaluationSessionStatus } from '@/types'
import { addMonthsSafe } from '@/lib/date-utils'
import { yearsFromHire as yearsFromDate } from '@/lib/evaluation-config'
import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'

export function notifyBulkResult(what: string, d: { updated?: number; skipped?: number; errors?: unknown[] }) {
  const detail = `更新 ${d.updated ?? 0}件・対象外 ${d.skipped ?? 0}件`
  if (d.errors?.length) notify.error(`${what}を再計算できなかったセッションが ${d.errors.length}件あります`, detail)
  else notify.success(`${what}を再計算しました`, detail)
}

export function rankColor(r: EvaluationRank): string {
  switch (r) {
    case 'S': return 'text-purple-600 dark:text-purple-400'
    case 'A': return 'text-blue-600 dark:text-blue-400'
    case 'B': return 'text-green-600 dark:text-green-400'
    case 'C': return 'text-yellow-600 dark:text-yellow-400'
    case 'D': return 'text-red-600 dark:text-red-400'
  }
}

export const VISA_LABELS: Record<string, string> = {
  none: '日本人',
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号',
  jisshu: '技能実習', tokutei: '特定技能',
}

// 昇給テーブル / getRaiseAmount / yearsFromDate は lib/evaluation-config.ts に移動済み（import 経由）

/**
 * 次回評価日の計算:
 * - システムで一度も評価していない → 入社日の次の記念日（アラート対象外）
 * - 評価済み → 最後の承認済み評価日から1年後
 */
export function nextEvalDate(hireDate: string, evaluations: Evaluation[]): string {
  const approved = evaluations.filter(e => e.status === 'approved')
  if (approved.length > 0) {
    // 最新の承認済み評価日から1年後
    const latestDate = approved
      .map(e => e.evaluationDate)
      .sort((a, b) => b.localeCompare(a))[0]
    return addMonthsSafe(latestDate, 12)
  }
  // 未評価: 入社日の次の記念日を表示（アラートは出さない）
  if (!hireDate) return '--'
  const currentYears = yearsFromDate(hireDate)
  const nextY = Math.max(1, currentYears + 1)
  return addMonthsSafe(hireDate, 12 * nextY)
}

/** システムで評価済みかどうか */
export function hasBeenEvaluated(evaluations: Evaluation[]): boolean {
  return evaluations.some(e => e.status === 'approved')
}

export function sessionStatusLabel(s: EvaluationSessionStatus, reviews: EvaluationReview[], evaluatorIds: number[]): { text: string; cls: string } {
  switch (s) {
    case 'collecting': {
      const count = reviews.length
      const total = evaluatorIds.length
      return {
        text: `収集中 (${count}/${total}提出)`,
        cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200',
      }
    }
    case 'reviewing':
      return { text: '最終確認中', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' }
    case 'approved':
      return { text: '承認済み', cls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200' }
    default:
      return { text: '不明', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
  }
}


// All 9 evaluation items in flat list for comparison table (generated from criteria definitions)
export const EVAL_ITEMS = EVALUATION_CATEGORIES.flatMap(cat =>
  cat.criteria.map(c => ({ category: cat.key, key: c.key, label: c.label, A: c.A, B: c.B, C: c.C }))
)

// Category-level descriptions for section headers
export const CATEGORY_INFO = Object.fromEntries(
  EVALUATION_CATEGORIES.map(c => [c.key, { label: c.label, icon: c.icon, color: c.color, weightLabel: c.weightLabel }])
)

export function getScoreValue(scores: EvaluationScores, category: string, key: string): ABCGrade {
  const cat = scores[category as keyof EvaluationScores]
  return (cat as Record<string, ABCGrade>)[key]
}

export function setScoreValue(scores: EvaluationScores, category: string, key: string, value: ABCGrade): EvaluationScores {
  const copy = JSON.parse(JSON.stringify(scores)) as EvaluationScores
  const cat = copy[category as keyof EvaluationScores] as Record<string, ABCGrade>
  cat[key] = value
  return copy
}

export const EVALUATOR_COLORS = [
  { bg: 'bg-blue-100 dark:bg-blue-900', text: 'text-blue-700 dark:text-blue-300', header: 'bg-blue-500' },
  { bg: 'bg-green-100 dark:bg-green-900', text: 'text-green-700 dark:text-green-300', header: 'bg-green-500' },
  { bg: 'bg-orange-100 dark:bg-orange-900', text: 'text-orange-700 dark:text-orange-300', header: 'bg-orange-500' },
  { bg: 'bg-purple-100 dark:bg-purple-900', text: 'text-purple-700 dark:text-purple-300', header: 'bg-purple-500' },
]

/**
 * 評価者が当該カテゴリの評価対象かどうかを判定（2026-05-12 スコープ分担）
 *   - 生活態度 (living): 靖仁さん (id=0) のみ評価対象
 *   - 日本語/勤務態度/職業能力: 靖仁さん以外（職長 + 政仁さん）が対象
 */
export function isCategoryInScope(evaluatorId: number, categoryKey: string): boolean {
  const isAdmin = evaluatorId === 0
  const isLiving = categoryKey === 'living'
  if (isLiving && !isAdmin) return false   // 生活態度は admin のみ
  if (!isLiving && isAdmin) return false   // 非生活態度は admin 以外
  return true
}

/**
 * 評価セッションの提出済み review から、最終評価の初期値（加重平均ベース）を計算する。
 *
 * 動作:
 *   - 各評価項目について、スコープ内の評価者の点数 (A=3,B=2,C=1) を重み付き加重平均
 *   - しきい値 ≥2.5=A / ≥1.5=B / それ以下=C
 *   - 該当評価者0人の項目は B のまま（EMPTY_SCORES のデフォルト）
 *   - 評価者の重みは session.evaluatorWeights から取得（未設定なら 1.0）
 *
 * 2026-05-13: 複数の入口（承認タブの「確認・承認」、一覧・履歴の「承認へ」）から
 *   呼ばれるため共通化。以前は片方の入口でこの初期化が走らず、全項目が「B」で
 *   表示されるバグがあった。
 */
export function computePrefillScores(session: Evaluation): EvaluationScores {
  const prefill = JSON.parse(JSON.stringify(EMPTY_SCORES)) as EvaluationScores
  if (!session.reviews || session.reviews.length === 0) return prefill
  for (const item of EVAL_ITEMS) {
    let weightedSum = 0
    let totalWeight = 0
    for (const r of session.reviews) {
      if (!isCategoryInScope(r.evaluatorId, item.category)) continue
      const g = getScoreValue(r.scores, item.category, item.key)
      const gradeNum = g === 'A' ? 3 : g === 'B' ? 2 : 1
      const w = session.evaluatorWeights?.[r.evaluatorId]?.weight ?? 1.0
      weightedSum += gradeNum * w
      totalWeight += w
    }
    if (totalWeight === 0) continue   // 該当者0 → B のまま
    const avg = weightedSum / totalWeight
    const best: ABCGrade = avg >= 2.5 ? 'A' : avg >= 1.5 ? 'B' : 'C'
    const cat = prefill[item.category as keyof EvaluationScores] as Record<string, ABCGrade>
    cat[item.key] = best
  }
  return prefill
}

// 評価者IDから名前を引く（apiEvaluators 優先 → workers → ID表示）
export function evaluatorNameLookup(
  id: number,
  apiEvaluators: { id: number; name: string }[],
  workers: { id: number; name: string }[],
): string {
  const a = apiEvaluators.find(e => e.id === id)
  if (a) return a.name
  const w = workers.find(w2 => w2.id === id)
  if (w) return w.name
  return `ID:${id}`
}

// "MM/DD HH:mm" 短縮形式
export function fmtDateShort(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 提出日からの経過日数
export function daysSince(iso: string): number {
  if (!iso) return 0
  const d = new Date(iso)
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

export type TabId = 'list' | 'review' | 'monitor' | 'approve' | 'history'
export type EvState = 'collecting' | 'reviewing' | 'approved' | 'none'
export type EvFilter = 'all' | 'collecting' | 'reviewing' | 'approved' | 'soon' | 'mine'
export const EV_COLS = 'lg:grid-cols-[minmax(0,1fr)_100px_60px_minmax(0,1fr)_60px_150px]'

export const EMPTY_SCORES: EvaluationScores = {
  japanese: { understanding: 'B' as ABCGrade, reporting: 'B' as ABCGrade, safety: 'B' as ABCGrade },
  attitude: { punctuality: 'B' as ABCGrade, safetyAwareness: 'B' as ABCGrade, teamwork: 'B' as ABCGrade, compliance: 'B' as ABCGrade },
  skill: { level: 'B' as ABCGrade, speed: 'B' as ABCGrade, planning: 'B' as ABCGrade },
  living: { neighborCare: 'B' as ABCGrade, ruleCompliance: 'B' as ABCGrade, cleanliness: 'B' as ABCGrade },
}

// ── Main Component ──

/**
 * 評価ロジックの単一の真理ソース（2026-05-15 集約）
 *
 * 過去にフロント (app/(app)/evaluation/page.tsx) とバックエンド
 * (app/api/evaluation/route.ts) で評価ロジックが別々に実装されており、
 * 片方だけ更新されてズレが発生する事故が起きていた。具体例:
 *   - フロント側で WEIGHTS や RAISE_TABLE を更新しても、API側の DEFAULT は古いまま
 *   - フロント側で 4 項目 + living を採用しても、API側は 3 項目で living 無視
 *   - 結果として「画面表示と保存値が違う」ランクや昇給額のズレが頻発
 *
 * このモジュールを唯一の真理ソースとし、フロント・バックエンド両方が
 * import して使うことで、上記のドリフトを物理的に発生不能にする。
 *
 * ⚠️ 修正時の鉄則: 評価ロジックを変更したい場合はこのファイルだけを編集する。
 *    他の場所に同じ定数や関数を書いた場合は必ず壊れる。
 */
import type { ABCGrade, EvaluationScores, EvaluationRank } from '@/types'

// ────────────────────────────────────────
//  カテゴリ別 重み係数
// ────────────────────────────────────────

/**
 * カテゴリ別の重み係数。
 * 満点: 日本語9×1.0 + 勤務態度12×1.5 + 職業能力9×1.0 + 生活態度9×1.0 = 45.0
 * + 皆勤ボーナス最大3 → 最大48.0
 */
export const EVALUATION_WEIGHTS = {
  japanese: 1.0,
  attitude: 1.5,
  skill: 1.0,
  living: 1.0,
} as const

// ────────────────────────────────────────
//  ABC → 数値
// ────────────────────────────────────────

export function gradeToScore(g: ABCGrade): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : 1
}

// ────────────────────────────────────────
//  手動スコア算出（4カテゴリ・13項目）
// ────────────────────────────────────────

export interface ManualScoreBreakdown {
  japanese: number          // 素点 (max 9)
  attitude: number          // 素点 (max 12 — 4項目)
  skill: number             // 素点 (max 9)
  living: number            // 素点 (max 9)
  japaneseW: number         // 重み後
  attitudeW: number         // 重み後
  skillW: number            // 重み後
  livingW: number           // 重み後
  total: number             // 合計（皆勤ボーナス前）
}

/**
 * EvaluationScores から重み付き手動スコアを算出する。
 *
 * 対象項目:
 *   - 日本語: understanding / reporting / safety (3項目)
 *   - 勤務態度: punctuality / safetyAwareness / teamwork / compliance (4項目)
 *   - 職業能力: level / speed / planning (3項目)
 *   - 生活態度: neighborCare / ruleCompliance / cleanliness (3項目)
 */
export function calculateManualScore(scores: EvaluationScores): ManualScoreBreakdown {
  const jp =
    gradeToScore(scores.japanese.understanding) +
    gradeToScore(scores.japanese.reporting) +
    gradeToScore(scores.japanese.safety)
  const att =
    gradeToScore(scores.attitude.punctuality) +
    gradeToScore(scores.attitude.safetyAwareness) +
    gradeToScore(scores.attitude.teamwork) +
    gradeToScore(scores.attitude.compliance || 'B')
  const sk =
    gradeToScore(scores.skill.level) +
    gradeToScore(scores.skill.speed) +
    gradeToScore(scores.skill.planning)
  const lv =
    gradeToScore(scores.living?.neighborCare || 'B') +
    gradeToScore(scores.living?.ruleCompliance || 'B') +
    gradeToScore(scores.living?.cleanliness || 'B')
  const jpW = jp * EVALUATION_WEIGHTS.japanese
  const attW = att * EVALUATION_WEIGHTS.attitude
  const skW = sk * EVALUATION_WEIGHTS.skill
  const lvW = lv * EVALUATION_WEIGHTS.living
  return {
    japanese: jp,
    attitude: att,
    skill: sk,
    living: lv,
    japaneseW: jpW,
    attitudeW: attW,
    skillW: skW,
    livingW: lvW,
    total: jpW + attW + skW + lvW,
  }
}

// ────────────────────────────────────────
//  ランク判定
// ────────────────────────────────────────

/**
 * 合計スコア (手動スコア + 皆勤ボーナス) から S/A/B/C/D を判定。
 * 満点48基準のしきい値:
 *   S ≥ 39 (81%+)
 *   A ≥ 32 (67%+)
 *   B ≥ 25 (52%+)
 *   C ≥ 17 (35%+)
 *   D < 17
 */
export function calculateRank(totalScore: number): EvaluationRank {
  if (totalScore >= 39) return 'S'
  if (totalScore >= 32) return 'A'
  if (totalScore >= 25) return 'B'
  if (totalScore >= 17) return 'C'
  return 'D'
}

// ────────────────────────────────────────
//  昇給テーブル
// ────────────────────────────────────────

export interface RaiseTableRow {
  year: number
  S: number
  A: number
  B: number
  C: number
}

/**
 * 昇給テーブル（1,300円スタート → 10年目で S:2,700 A:2,380 B:2,060 C:1,740 到達）
 * D評価は現在時給の1%（法定最低限の昇給義務）
 *
 * `year` の意味: 入社からの完了年数（完了年数=N で N年目の行を引く）
 * 例: 2023-10 入社で 2026-05 評価 → 完了2年 → year=2 行を引く
 */
export const RAISE_TABLE: RaiseTableRow[] = [
  { year: 1, S: 220, A: 170, B: 120, C: 80 },
  { year: 2, S: 200, A: 160, B: 110, C: 65 },
  { year: 3, S: 180, A: 140, B: 100, C: 55 },
  { year: 4, S: 170, A: 130, B: 90, C: 50 },
  { year: 5, S: 160, A: 120, B: 80, C: 50 },
  { year: 6, S: 140, A: 110, B: 75, C: 45 },
  { year: 7, S: 120, A: 90, B: 65, C: 35 },
  { year: 8, S: 110, A: 80, B: 60, C: 30 },
  { year: 9, S: 100, A: 80, B: 60, C: 30 },
]

/**
 * 昇給額を算出する。
 *
 * - S/A/B/C: テーブルから直接引く
 * - D: 現在時給の1%（法定最低限）
 *
 * `yearsFromHire` がテーブル最大年（9）を超えた場合は最大年でキャップする。
 *
 * @param raiseTable オプション。指定しなければデフォルトテーブルを使用。
 *                   admin 設定からテーブルを上書きしたい場合のみ渡す。
 */
export function getRaiseAmount(
  rank: EvaluationRank,
  yearsFromHire: number,
  currentHourlyRate?: number,
  raiseTable: RaiseTableRow[] = RAISE_TABLE,
): number {
  if (rank === 'D') {
    const rate = currentHourlyRate || 1300
    return Math.ceil(rate * 0.01)
  }
  const maxYear = Math.max(...raiseTable.map(r => r.year))
  const yearKey = Math.min(Math.max(1, yearsFromHire), maxYear)
  const row = raiseTable.find(r => r.year === yearKey) || raiseTable[raiseTable.length - 1]
  return row[rank as 'S' | 'A' | 'B' | 'C']
}

// ────────────────────────────────────────
//  入社年数
// ────────────────────────────────────────

/**
 * 入社日から経過した「完了年数」を返す（記念日未到達の年はカウントしない）。
 * 例: 2023-10-23 → 2026-05-15 で 2 を返す（2026-10-23 未到達のため）。
 */
export function yearsFromHire(hireDate: string): number {
  if (!hireDate) return 1
  const hire = new Date(hireDate)
  const now = new Date()
  let y = now.getFullYear() - hire.getFullYear()
  const mDiff = now.getMonth() - hire.getMonth()
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < hire.getDate())) y--
  return Math.max(1, y)
}

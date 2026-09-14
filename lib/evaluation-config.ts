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
import { curveRaiseAt, CURVE_BASE_RAISE, CURVE_DECAY, CURVE_MIN_RAISE } from './wage-curve'

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
 * 旧昇給テーブル（〜2026-09-14）。記録として残す（計算には使わない）。
 * 1,300円スタートの独自表で、賃金カーブ（160円−8円×年数）と最大24円ずれていた。
 * `year` は「評価日時点の完了年数」だったため、記念日の前に評価すると1年前の行を引いていた。
 */
export const LEGACY_RAISE_TABLE_2026_05: RaiseTableRow[] = [
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
 * 評価ランクごとの倍率（A評価＝賃金カーブの昇給額 に対する比）。2026-09-14 代表決定で導入。
 * 旧テーブルの平均的な比（S≒1.28 / B≒0.72 / C≒0.40）を丸めた値。
 * 固定比にすることで、どの年も S > A > B > C かつ年数とともに単調に下がる。
 */
export const RANK_RAISE_RATIO = { S: 1.25, A: 1, B: 0.7, C: 0.4 } as const

/** 5円単位に四捨五入 */
function round5(v: number): number {
  return Math.round(v / 5) * 5
}

/**
 * 昇給テーブル（2026-09-14〜）。**A評価 = 賃金カーブ（lib/wage-curve.ts）の昇給額**そのもの。
 * S/B/C は RANK_RAISE_RATIO を掛けて5円単位に丸める。D評価は現在時給の1%（法定最低限の昇給義務）。
 *
 * `year` の意味: **N回目の入社記念日の昇給**（評価日に最も近い記念日。raiseYearAt 参照）。
 *   A = curveRaiseAt(N − 1)。1回目=160円、8回目=104円、11回目以降=80円（下限）。
 */
export const RAISE_TABLE: RaiseTableRow[] = (() => {
  const lastYear = Math.ceil((CURVE_BASE_RAISE - CURVE_MIN_RAISE) / CURVE_DECAY) + 1  // 下限に達する年（=11）
  const rows: RaiseTableRow[] = []
  for (let year = 1; year <= lastYear; year++) {
    const A = curveRaiseAt(year - 1)
    rows.push({ year, S: round5(A * RANK_RAISE_RATIO.S), A, B: round5(A * RANK_RAISE_RATIO.B), C: round5(A * RANK_RAISE_RATIO.C) })
  }
  return rows
})()

/**
 * 昇給額を算出する。
 *
 * - S/A/B/C: テーブルから直接引く
 * - D: 現在時給の1%（法定最低限）
 *
 * `yearsFromHire`（＝N回目の記念日の昇給。raiseYearAt）がテーブル最大年（11）を超えた場合は最大年でキャップする。
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
//  法令フロア（2026-08-04 追加 / 賃金モデル突合検証）
// ────────────────────────────────────────

/**
 * 昇給後の時給に法令下限を適用する。
 *
 * ■ なぜ必要か
 *   評価テーブルの昇給ペースは C連続で年3.3%・B連続で年5.3%。一方、東京都最低賃金は
 *   直近3年で年4〜5%上昇しており、さらに建設分野の特定技能1号は
 *   「地域別最低賃金 × 1.1 以上」が認定要件（国交省 国不国第654号）。
 *   シミュレーションでは C連続は特定技能移行時点で下限割れ、B連続も
 *   現最賃起点だと10年目に割る。テーブルどおりの昇給額をそのまま確定すると
 *   法令割れが起きるため、承認時にフロアで底上げする。
 *
 * ■ 使い方
 *   minWage には評価時点の地域別最低賃金を渡す（lib/wage-analysis.ts の minWageAt）。
 *   将来の最賃は読めないため「毎年の評価のたびに、その時点の最賃で底上げ」する設計。
 *   currentHourlyRate が不明な場合はフロアを適用できないのでテーブル値をそのまま返す。
 */
export interface LegalFloorResult {
  /** 適用後の昇給額（フロア発動時はテーブル値より大きくなる） */
  raiseAmount: number
  /** フロアで底上げされたか */
  floored: boolean
  /** 適用した下限時給（最賃 × 係数、円未満切上げ） */
  legalMinRate: number
  /** テーブル由来の昇給額（記録用） */
  baseRaise: number
}

export function applyLegalWageFloor(args: {
  baseRaise: number
  currentHourlyRate?: number
  /** RawWorker.visa（'tokutei1' 等）。tokutei* のとき 1.1 倍が適用される */
  visa?: string
  /** 評価時点の地域別最低賃金 */
  minWage: number
}): LegalFloorResult {
  const { baseRaise, currentHourlyRate, visa, minWage } = args
  const isTokutei = !!visa && visa.startsWith('tokutei')
  // ×1.1 は整数演算（×11÷10）で行う。浮動小数点だと 1430×1.1=1573.0000000000002 の
  // ような誤差で切上げ結果が1円ズレる
  const legalMinRate = isTokutei ? Math.ceil((minWage * 11) / 10) : Math.ceil(minWage)

  if (!currentHourlyRate || currentHourlyRate <= 0 || !minWage) {
    return { raiseAmount: baseRaise, floored: false, legalMinRate, baseRaise }
  }

  const afterRaise = currentHourlyRate + baseRaise
  if (afterRaise >= legalMinRate) {
    return { raiseAmount: baseRaise, floored: false, legalMinRate, baseRaise }
  }
  return {
    raiseAmount: legalMinRate - currentHourlyRate,
    floored: true,
    legalMinRate,
    baseRaise,
  }
}

// ────────────────────────────────────────
//  入社年数
// ────────────────────────────────────────

/**
 * 入社日から経過した「完了年数」を返す（記念日未到達の年はカウントしない）。
 * 例: 2023-10-23 → 2026-05-15 で 2 を返す（2026-10-23 未到達のため）。
 */
export function yearsFromHire(hireDate: string): number {
  // ⚠️ 表示用の「完了年数」。昇給テーブルを引くときは raiseYearAt(hireDate, evaluationDate) を使うこと
  if (!hireDate) return 1
  const hire = new Date(hireDate)
  const now = new Date()
  let y = now.getFullYear() - hire.getFullYear()
  const mDiff = now.getMonth() - hire.getMonth()
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < hire.getDate())) y--
  return Math.max(1, y)
}

/**
 * 昇給テーブルを引く年（何回目の入社記念日の昇給か）を返す（2026-09-14 追加）。
 *
 * 評価は「入社記念日の前後1ヶ月」で行うため、評価日に**最も近い記念日**を採用する。
 * 旧実装は評価日時点の完了年数だったので、記念日の前に評価すると1年前の行を引いていた
 * （例: アイン 2018-11-01 入社・2026-09-10 評価 → 完了7年 → 7年目表。実際の昇給は 11/1 の8回目）。
 *
 * @param hireDate       入社日 'YYYY-MM-DD'
 * @param evaluationDate 評価日 'YYYY-MM-DD'
 */
export function raiseYearAt(hireDate: string, evaluationDate: string): number {
  if (!hireDate || !evaluationDate) return 1
  const h = new Date(hireDate + 'T00:00:00Z')
  const e = new Date(evaluationDate + 'T00:00:00Z')
  let n = e.getUTCFullYear() - h.getUTCFullYear()
  // 評価日の年の記念日、その前後の記念日のうち最も近いもの
  let best = n
  let bestDiff = Infinity
  for (const k of [n - 1, n, n + 1]) {
    const ann = Date.UTC(h.getUTCFullYear() + k, h.getUTCMonth(), h.getUTCDate())
    const diff = Math.abs(ann - e.getTime())
    if (diff < bestDiff) { bestDiff = diff; best = k }
  }
  n = best
  return Math.max(1, n)
}


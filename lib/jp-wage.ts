/**
 * 日本人社員の賃金制度（号俸制）の単一の真理ソース。
 *
 * `docs/wage-system.md` をコードに落としたもの。号俸表・4つの調整・評語・
 * 昇格読み替え・賞与点数を、すべてここに集約する。画面・API・帳票はこの
 * モジュールを import して使い、同じ数字を二重に持たない。
 *
 * ⚠️ 制度を変えたい場合はこのファイルと docs/wage-system.md の両方を直す。
 *    他の場所に号俸表や調整表を書き写すと必ずズレる（過去に評価ロジックが
 *    フロント/API で二重化して事故になった前例あり。evaluation-config.ts 参照）。
 *
 * 前提（2026-07 代表確定）:
 *   - 6等級（1G〜6G）＋ 土工。役員(7G)は年俸制で対象外。
 *   - 各等級 全60号。上限(60号)の年収は 1G=450万 → 6G=900万 の一定割合(×約1.149)。
 *   - 評語は5段階 SS/S/A/B/C（基本A・相対評価・降給なし）。
 */

// ────────────────────────────────────────
//  型
// ────────────────────────────────────────

/** 賃金等級。'doko' は土工（3Gの90%）。役員(7G)は本制度の対象外。 */
export type JpGrade = '1G' | '2G' | '3G' | '4G' | '5G' | '6G' | 'doko'

/** 昇給評語（5段階）。基本はA。 */
export type Hyogo = 'SS' | 'S' | 'A' | 'B' | 'C'

/** 経常利益率のランク（利益調整用）。 */
export type ProfitRank = 'over10' | 'over5' | 'profit' | 'loss'

// ────────────────────────────────────────
//  号俸表（初号 + 逓減ピッチ）
// ────────────────────────────────────────

export const MAX_STEP = 60
export const ANNUAL_DAYS = 290 // 既存社員の年間所定日数（年収換算用）

/** 号のレンジ境界（このstep以下ならそのゾーン）。 */
const ZONE1_MAX = 25
const ZONE2_MAX = 45

/**
 * 各等級の 初号日額 と 3レンジのピッチ [1〜25号, 26〜45号, 46〜60号]。
 * 上限(60号)が 450万→900万 の一定割合になるよう z1 を逆算し、
 * z2=z1×80%・z3=z1×60%（5円四捨五入）としたもの。
 */
const GRADE_TABLE: Record<Exclude<JpGrade, 'doko'>, { base: number; pitch: [number, number, number] }> = {
  '1G': { base: 10850, pitch: [95, 75, 55] },
  '2G': { base: 11650, pitch: [125, 100, 75] },
  '3G': { base: 13200, pitch: [150, 120, 90] },
  '4G': { base: 15000, pitch: [175, 140, 105] },
  '5G': { base: 16500, pitch: [215, 170, 130] },
  '6G': { base: 18300, pitch: [260, 210, 155] },
}

/** 5円単位で四捨五入。 */
function round5(v: number): number {
  return Math.round(v / 5) * 5
}

/** そのstepに到達するための増分（1つ前のstepからの1号分ピッチ）。 */
function pitchAt(pitch: [number, number, number], step: number): number {
  if (step <= ZONE1_MAX) return pitch[0]
  if (step <= ZONE2_MAX) return pitch[1]
  return pitch[2]
}

/**
 * 等級・号数から確定日給（円/日）を返す。
 * doko（土工）は 3G の90%（5円四捨五入）。
 */
export function dailyForStep(grade: JpGrade, step: number): number {
  if (step < 1 || step > MAX_STEP) {
    throw new Error(`jp-wage: step out of range 1..${MAX_STEP}: ${step}`)
  }
  if (grade === 'doko') {
    return round5(dailyForStep('3G', step) * 0.9)
  }
  const g = GRADE_TABLE[grade]
  let v = g.base
  for (let i = 2; i <= step; i++) v += pitchAt(g.pitch, i)
  return v
}

/** 等級のピッチ [1〜25, 26〜45, 46〜60]（土工は3Gベース・参考）。 */
export function pitchOf(grade: JpGrade): [number, number, number] {
  if (grade === 'doko') return GRADE_TABLE['3G'].pitch
  return GRADE_TABLE[grade].pitch
}

/** 上限(60号)の日額。 */
export function capDaily(grade: JpGrade): number {
  return dailyForStep(grade, MAX_STEP)
}

/** ベース年収（確定日給 × 年間所定日数）。 */
export function baseAnnual(daily: number, annualDays: number = ANNUAL_DAYS): number {
  return daily * annualDays
}

/**
 * 「その等級で、指定した日額を上回る（以上になる）最初の号」を返す。
 * 昇格の読み替え・新卒の日給着地・移行の読み替えに使う共通ロジック。
 * どの号でも届かない場合は上限(60)を返す。
 */
export function stepForDaily(grade: JpGrade, dailyYen: number): number {
  for (let n = 1; n <= MAX_STEP; n++) {
    if (dailyForStep(grade, n) >= dailyYen) return n
  }
  return MAX_STEP
}

// ────────────────────────────────────────
//  新卒（月給制 → 日給月給制）
// ────────────────────────────────────────

/** 月給から日給換算（月給 × 12 ÷ 年間所定日数、円未満四捨五入）。 */
export function dailyFromMonthly(monthly: number, annualWorkDays: number): number {
  return Math.round((monthly * 12) / annualWorkDays)
}

// ────────────────────────────────────────
//  評語 → 昇給ピッチ（5段階・基本A）
// ────────────────────────────────────────

export const HYOGO_PITCH: Record<Hyogo, number> = {
  SS: 6,
  S: 5,
  A: 4,
  B: 3,
  C: 1,
}

// ────────────────────────────────────────
//  年齢調整
// ────────────────────────────────────────

const GRADE_INDEX: Record<Exclude<JpGrade, 'doko'>, number> = {
  '1G': 0, '2G': 1, '3G': 2, '4G': 3, '5G': 4, '6G': 5,
}

/** 年齢帯 [上限年齢, [1G..6G の調整]]。上限を超えたら次の帯。 */
const AGE_TABLE: Array<[number, number[]]> = [
  [25, [3, 2, 1, 0, 0, 0]],
  [30, [1, 1, 0, 0, 0, 0]],
  [35, [0, 0, 0, 0, 0, 0]],
  [40, [-1, -1, 0, 0, 0, 0]],
  [45, [-2, -2, -1, 0, 0, 0]],
  [50, [-3, -3, -2, -1, 0, 0]],
  [55, [-4, -3, -3, -2, -1, -1]],
  [59, [-4, -4, -3, -3, -2, -2]],
  [Infinity, [-4, -4, -3, -3, -3, -3]], // 60歳〜（再雇用）
]

/** 年齢と等級から年齢調整ピッチを返す（土工は3G相当で扱う）。 */
export function ageAdjustment(age: number, grade: JpGrade): number {
  const gi = grade === 'doko' ? GRADE_INDEX['3G'] : GRADE_INDEX[grade]
  for (const [maxAge, row] of AGE_TABLE) {
    if (age <= maxAge) return row[gi]
  }
  return 0
}

// ────────────────────────────────────────
//  利益調整
// ────────────────────────────────────────

const PROFIT_TABLE: Record<ProfitRank, number[]> = {
  over10: [0, 0, 1, 2, 2, 3],
  over5: [0, 0, 0, 1, 1, 2],
  profit: [0, 0, 0, 0, 0, 1],
  loss: [0, 0, -1, -2, -2, -3],
}

/** 経常利益率(%)からランクを判定。 */
export function profitRankOf(profitRatePercent: number): ProfitRank {
  if (profitRatePercent >= 10) return 'over10'
  if (profitRatePercent >= 5) return 'over5'
  if (profitRatePercent >= 0) return 'profit'
  return 'loss'
}

/** 利益ランクと等級から利益調整ピッチを返す。 */
export function profitAdjustment(rank: ProfitRank, grade: JpGrade): number {
  const gi = grade === 'doko' ? GRADE_INDEX['3G'] : GRADE_INDEX[grade]
  return PROFIT_TABLE[rank][gi]
}

// ────────────────────────────────────────
//  特別調整（事由リスト・合計±3上限）
// ────────────────────────────────────────

export interface SpecialReason {
  key: string
  label: string
  pitch: number
}

export const SPECIAL_REASONS: SpecialReason[] = [
  { key: 'qualification', label: '職長資格・施工管理技士等の取得（取得年度のみ）', pitch: 1 },
  { key: 'newsite', label: '新規現場の立ち上げ・大型現場の職長就任', pitch: 1 },
  { key: 'offsite', label: '採用・育成など現場外での貢献', pitch: 1 },
  { key: 'accident', label: '労災の発生（本人の重大な不安全行動による）', pitch: -1 },
  { key: 'discipline', label: '重大な規律違反', pitch: -2 },
  { key: 'longleave', label: '長期離脱（私傷病等）', pitch: -1 },
]

export const SPECIAL_CAP = 3

/** 選択された事由キーから特別調整合計を算出（±3でクランプ）。 */
export function specialAdjustment(reasonKeys: string[]): number {
  const sum = reasonKeys.reduce((acc, k) => {
    const r = SPECIAL_REASONS.find(x => x.key === k)
    return acc + (r ? r.pitch : 0)
  }, 0)
  return Math.max(-SPECIAL_CAP, Math.min(SPECIAL_CAP, sum))
}

// ────────────────────────────────────────
//  年1回の改定（昇給）
// ────────────────────────────────────────

export interface RevisionInput {
  grade: JpGrade
  currentStep: number
  hyogo: Hyogo
  age: number
  profitRank: ProfitRank
  specialKeys?: string[]
}

export interface RevisionResult {
  hyogoPitch: number
  agePitch: number
  profitPitch: number
  specialPitch: number
  totalPitch: number          // 合計（マイナスは0にクランプ＝降給なし）
  newStep: number
  oldDaily: number
  newDaily: number
  raisePerDay: number
  newBaseAnnual: number
  upRate: number              // 昇給率（新日額/旧日額 − 1）
}

/**
 * 改定の計算。合計ピッチ = 評語 + 年齢 + 利益 + 特別。
 * 合計がマイナスなら0（降給なし）。新号 = 現号 + 合計（60でキャップ）。
 */
export function computeRevision(input: RevisionInput): RevisionResult {
  const hyogoPitch = HYOGO_PITCH[input.hyogo]
  const agePitch = ageAdjustment(input.age, input.grade)
  const profitPitch = profitAdjustment(input.profitRank, input.grade)
  const specialPitch = specialAdjustment(input.specialKeys ?? [])
  const rawTotal = hyogoPitch + agePitch + profitPitch + specialPitch
  const totalPitch = Math.max(0, rawTotal)
  const newStep = Math.min(MAX_STEP, input.currentStep + totalPitch)
  const oldDaily = dailyForStep(input.grade, input.currentStep)
  const newDaily = dailyForStep(input.grade, newStep)
  return {
    hyogoPitch, agePitch, profitPitch, specialPitch, totalPitch, newStep,
    oldDaily, newDaily,
    raisePerDay: newDaily - oldDaily,
    newBaseAnnual: baseAnnual(newDaily),
    upRate: oldDaily > 0 ? newDaily / oldDaily - 1 : 0,
  }
}

// ────────────────────────────────────────
//  昇格（等級アップ）
// ────────────────────────────────────────

export interface PromotionResult {
  readStep: number   // 新等級で現日額を上回る最初の号
  newStep: number    // そこに当期ピッチを加算した号
  newDaily: number
}

/**
 * 昇格の読み替え。
 * ① 新等級で「現在の日額を上回る最初の号」に読み替える。
 * ② その号に当期の合計ピッチ（addPitch）を加算する。
 */
export function promote(newGrade: JpGrade, currentDaily: number, addPitch: number): PromotionResult {
  const readStep = stepForDaily(newGrade, currentDaily)
  const newStep = Math.min(MAX_STEP, readStep + Math.max(0, addPitch))
  return { readStep, newStep, newDaily: dailyForStep(newGrade, newStep) }
}

// ────────────────────────────────────────
//  賞与（点数ラダー × 評語シフト）
// ────────────────────────────────────────

/**
 * 賞与の基礎点ラダー（2段ごとに倍・√2刻み）。
 * 評語は「等級を上下にシフト」と等価：SS=+2 / S=+1 / A=0 / B=−1 / C=−2。
 * 各等級のA基準は BONUS_BASE_INDEX の位置。
 */
const BONUS_LADDER = [50, 70, 100, 140, 200, 280, 400, 560, 800, 1120, 1600, 2240]

const BONUS_BASE_INDEX: Record<Exclude<JpGrade, 'doko'>, number> = {
  '1G': 2, '2G': 3, '3G': 4, '4G': 5, '5G': 6, '6G': 7, // A基準 100/140/200/280/400/560
}

const BONUS_SHIFT: Record<Hyogo, number> = {
  SS: 2, S: 1, A: 0, B: -1, C: -2,
}

/** 等級×評語 → 賞与点数。土工は3G相当。 */
export function bonusPoints(grade: JpGrade, hyogo: Hyogo): number {
  const baseIdx = grade === 'doko' ? BONUS_BASE_INDEX['3G'] : BONUS_BASE_INDEX[grade]
  const idx = Math.max(0, Math.min(BONUS_LADDER.length - 1, baseIdx + BONUS_SHIFT[hyogo]))
  return BONUS_LADDER[idx]
}

export interface BonusMember {
  workerId: number
  grade: JpGrade
  hyogo: Hyogo
}

export interface BonusAllocation extends BonusMember {
  points: number
  amount: number       // 千円未満は四捨五入（配分の慣行）
}

/**
 * 原資（総額）を点数比で配分する。
 *   単価 = 原資 ÷ 総点数、各人 = 点数 × 単価（千円丸め）。
 * 原資は代表が決める前提。役員はこの配分の外（呼び出し側で除外）。
 */
export function allocateBonus(pool: number, members: BonusMember[]): { unit: number; totalPoints: number; allocations: BonusAllocation[] } {
  const withPoints = members.map(m => ({ ...m, points: bonusPoints(m.grade, m.hyogo) }))
  const totalPoints = withPoints.reduce((s, m) => s + m.points, 0)
  const unit = totalPoints > 0 ? pool / totalPoints : 0
  const allocations: BonusAllocation[] = withPoints.map(m => ({
    ...m,
    amount: Math.round((m.points * unit) / 1000) * 1000,
  }))
  return { unit, totalPoints, allocations }
}

// ────────────────────────────────────────
//  等級ラベル
// ────────────────────────────────────────

export const GRADE_LABEL: Record<JpGrade, string> = {
  '1G': '初級職', '2G': '中級職', '3G': '班長',
  '4G': '上級班長', '5G': '職長', '6G': '上級職長',
  'doko': '土工',
}

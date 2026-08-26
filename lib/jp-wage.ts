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
// ────────────────────────────────────────
//  号俸表（初号 + 逓減ピッチ）
// ────────────────────────────────────────

export const MAX_STEP = 60

/** 等級の呼称（docs/wage-system.md 第2節）。 */
export const GRADE_LABELS: Record<JpGrade, string> = {
  '1G': '初級職', '2G': '中級職', '3G': '班長',
  '4G': '上級班長', '5G': '職長', '6G': '上級職長',
  doko: '土工（3G相当）',
}

/** 号俸表を持つ等級を並び順で。 */
export const GRADES_IN_ORDER: JpGrade[] = ['1G', '2G', '3G', '4G', '5G', '6G', 'doko']
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
/** 画面に表を出すための年齢帯ラベル（AGE_TABLE と同じ並び）。 */
export const AGE_BAND_LABELS = [
  '25歳まで', '26〜30歳', '31〜35歳', '36〜40歳', '41〜45歳',
  '46〜50歳', '51〜55歳', '56〜59歳', '60歳〜（再雇用）',
] as const

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

/** 年齢調整の全表（表示用）。[帯ラベル, 1G..6G の調整] */
export function ageTableForDisplay(): Array<{ band: string; pitches: number[] }> {
  return AGE_TABLE.map((row, i) => ({ band: AGE_BAND_LABELS[i], pitches: row[1] }))
}

/** 年齢と等級から年齢調整ピッチを返す（土工は3G相当で扱う）。 */
export function ageAdjustment(age: number, grade: JpGrade): number {
  const gi = grade === 'doko' ? GRADE_INDEX['3G'] : GRADE_INDEX[grade]
  for (const [maxAge, row] of AGE_TABLE) {
    if (age <= maxAge) return row[gi]
  }
  return 0
}

// ────────────────────────────────────────
//  利益調整（2026-08 撤廃）
// ────────────────────────────────────────
//
// 会社の業績を昇給（号数）へ反映する仕組みを置いていたが撤廃した。
//
// 理由は2つ。
// ① **賞与で既に業績連動している。** 賞与は「原資を代表が業績を見て決め、
//    等級×評語の点数で配分する」方式。総額の決定にすでに業績が入っているので、
//    昇給にも掛けると二重連動になる。
// ② **昇給で背負わせると等級が逆転する。** 上位等級ほど大きく引く設計にすると、
//    赤字の年に「4G班長 700円 > 5G職長 430円 > 6G上級職長 260円」が起きる。
//    号のピッチ差（等級1段で15〜25%）より、1ピッチ減の影響のほうが大きいため、
//    表をどう組んでも避けられない。
//
// さらに、号は一度上げると定年まで残る。単年の業績を恒久的な賃金へ変換することに
// なり、性質が合わない（好調な年に在籍していたかどうかで生涯賃金が変わる）。
//
// 業績連動は賞与に一本化した。docs/wage-system.md 第7節を参照。

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
  specialKeys?: string[]
  /**
   * 代表加算。事由リストに当てはまらないものを、代表の判断で直接足し引きする号数。
   *
   * 特別調整（SPECIAL_REASONS・±3上限）とは別枠にしている。あちらは事由が決まっていて
   * 誰が計算しても同じ結果になるもの、こちらは**その時の判断**。混ぜると、
   * 規則で決まった分と裁量で足した分の区別がつかなくなり、翌年の説明ができない。
   * 上限は設けないが、理由の記録を必須にする（呼び出し側で検査）。
   */
  discretionaryPitch?: number
}

export interface RevisionResult {
  hyogoPitch: number
  agePitch: number
  specialPitch: number
  /** 代表加算（裁量分） */
  discretionaryPitch: number
  totalPitch: number          // 合計（マイナスは0にクランプ＝降給なし）
  newStep: number
  oldDaily: number
  newDaily: number
  raisePerDay: number
  newBaseAnnual: number
  upRate: number              // 昇給率（新日額/旧日額 − 1）
}

/**
 * 改定の計算。合計ピッチ = 評語 + 年齢 + 特別 + 代表加算。
 * 合計がマイナスなら0（降給なし）。新号 = 現号 + 合計（60でキャップ）。
 */
export function computeRevision(input: RevisionInput): RevisionResult {
  const hyogoPitch = HYOGO_PITCH[input.hyogo]
  const agePitch = ageAdjustment(input.age, input.grade)
  const specialPitch = specialAdjustment(input.specialKeys ?? [])
  const discretionaryPitch = Math.trunc(input.discretionaryPitch ?? 0)
  const rawTotal = hyogoPitch + agePitch + specialPitch + discretionaryPitch
  const totalPitch = Math.max(0, rawTotal)
  const newStep = Math.min(MAX_STEP, input.currentStep + totalPitch)
  const oldDaily = dailyForStep(input.grade, input.currentStep)
  const newDaily = dailyForStep(input.grade, newStep)
  return {
    hyogoPitch, agePitch, specialPitch, discretionaryPitch, totalPitch, newStep,
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
  /**
   * 支給額。**千円未満は切り上げ**。
   * 実際の配分表がそうなっている（75,472 → 76,000 / 52,830 → 53,000）。
   * 切り上げのぶん、合計は原資をわずかに超える（10名で3,000円程度）。
   */
  amount: number
}

/**
 * 原資（総額）を点数比で配分する。
 *
 *   単価 = 原資 ÷ 総点数 → 各人 = 点数 × 単価（千円切り上げ）
 *
 * **業績連動はこの原資の決定に集約している。** 代表が利益を見て総額を決めるので、
 * 配分側にも昇給側にも業績の係数は掛けない（掛けると二重連動になる。第7節）。
 * 役員はこの配分の外（呼び出し側で除外する）。
 */
export function allocateBonus(pool: number, members: BonusMember[]): { unit: number; totalPoints: number; allocations: BonusAllocation[] } {
  const withPoints = members.map(m => ({ ...m, points: bonusPoints(m.grade, m.hyogo) }))
  const totalPoints = withPoints.reduce((s, m) => s + m.points, 0)
  const unit = totalPoints > 0 ? pool / totalPoints : 0
  const allocations: BonusAllocation[] = withPoints.map(m => ({
    ...m,
    amount: Math.ceil((m.points * unit) / 1000) * 1000,
  }))
  return { unit, totalPoints, allocations }
}

// ────────────────────────────────────────
//  等級ラベル
// ────────────────────────────────────────

// 等級ラベルは GRADE_LABELS（ファイル冒頭）に集約した

// ────────────────────────────────────────
//  名簿単位の改定（10月1日の年次改定を回すための層）
// ────────────────────────────────────────

/**
 * 基準日時点の満年齢。
 *
 * ⚠️ ISO 文字列のまま比較する。`new Date('2000-01-01')` は UTC 深夜として解釈されるため、
 *    日本時間で評価すると1日ずれて年齢が1つ変わることがある（誕生日が基準日と同日の場合）。
 */
export function ageOn(birthDate: string, onDateIso: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const [oy, om, od] = onDateIso.split('-').map(Number)
  let age = oy - by
  if (om < bm || (om === bm && od < bd)) age -= 1
  return age
}

/**
 * 評語の分布がペアのルール（docs/wage-system.md 第5節）を満たすか。
 *
 * 「S を1人出したら B を1人出す」「SS を1人出したら C を1人出す」。
 * 全体が A に寄りすぎず甘くなりすぎないための歯止めで、昇給総額の自然な抑制にもなる。
 */
export interface HyogoBalance {
  counts: Record<Hyogo, number>
  /** B が何人不足しているか（0 なら充足） */
  needB: number
  /** C が何人不足しているか（0 なら充足） */
  needC: number
  ok: boolean
  messages: string[]
}

export function checkHyogoBalance(list: Hyogo[]): HyogoBalance {
  const counts: Record<Hyogo, number> = { SS: 0, S: 0, A: 0, B: 0, C: 0 }
  for (const h of list) counts[h] += 1
  const needB = Math.max(0, counts.S - counts.B)
  const needC = Math.max(0, counts.SS - counts.C)
  const messages: string[] = []
  if (needB > 0) messages.push(`S が ${counts.S}名に対して B が ${counts.B}名。あと ${needB}名 B が必要`)
  if (needC > 0) messages.push(`SS が ${counts.SS}名に対して C が ${counts.C}名。あと ${needC}名 C が必要`)
  return { counts, needB, needC, ok: needB === 0 && needC === 0, messages }
}

/**
 * 初回改定の対象になる最短の在籍月数。
 *
 * 基準日時点でこれに満たない人は、評価する期間そのものが無いので改定しない。
 * 入社時の賃金は採用時に決めたばかりで、直後に改定する理由もない。
 * ※ 就業規則・仕様書に明文の規定が無いため、運用上の既定値として置いている
 *   （2026-08 時点。中途採用が続くようなら docs/wage-system.md に条文化すること）。
 */
export const FIRST_REVISION_MIN_MONTHS = 6

/** 満月数。日付は文字列のまま扱う（new Date は UTC 解釈でずれる）。 */
export function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  let m = (ty - fy) * 12 + (tm - fm)
  if (td < fd) m -= 1
  return m
}

export interface RosterMember {
  id: number
  name: string
  grade: JpGrade
  /** 現在の号。未確定なら null */
  currentStep: number | null
  /** 生年月日 'YYYY-MM-DD'。未登録なら null */
  birthDate: string | null
  /** 入社日 'YYYY-MM-DD'。在籍が浅い人を初回改定から外す判定に使う */
  hireDate?: string | null
  /** 在籍が浅くても改定対象に含める（個別判断で既定を上書きする） */
  forceInclude?: boolean
  hyogo: Hyogo
  /** S以上・B以下は理由が必須（第5節） */
  reason?: string
  specialKeys?: string[]
  /** 代表加算（裁量で足し引きする号数）。0以外なら理由が必須 */
  discretionaryPitch?: number
  /** 代表加算の理由 */
  discretionaryReason?: string
  /** 処遇固定。号を動かさない */
  fixed?: boolean
  /** 号俸額に上乗せする調整給（移籍調整給など） */
  adjustment?: number
}

/**
 * - `ok`         … 改定を計算した
 * - `fixed`      … 処遇固定。号を動かさない
 * - `ineligible` … 在籍が浅く初回改定の対象外
 * - `blocked`    … 入力が足りず計算できない
 */
export type RosterStatus = 'ok' | 'fixed' | 'ineligible' | 'blocked'

export interface RosterRow {
  member: RosterMember
  status: RosterStatus
  /** 計算できた場合の結果。できなければ null */
  result: RevisionResult | null
  /** 調整給を含めた改定前後の日額 */
  oldTotal: number | null
  newTotal: number | null
  /** 基準日時点の在籍月数（入社日が無ければ null） */
  tenureMonths: number | null
  /** 計算しなかった理由 */
  blockers: string[]
}

export interface RosterRevision {
  rows: RosterRow[]
  balance: HyogoBalance
  /** 改定できた人数 */
  applied: number
  /** 入力が足りず計算できなかった人数 */
  blocked: number
  /** 在籍が浅く初回改定の対象外だった人数 */
  ineligible: number
  /** 1日あたりの昇給額 合計 */
  raisePerDay: number
  /** 年間の増加額（`annualDays` 日換算） */
  annualCost: number
}

/**
 * 名簿全体の改定を計算する。
 *
 * 入力が欠けている人は計算せず `blockers` に理由を積む。**欠けたまま概算を出さない**のは、
 * 年齢調整が −4〜+3ピッチと大きく、A評価（4ピッチ）を丸ごと打ち消すことがあるため。
 * 生年月日が無い状態の「仮の改定額」は本人へ提示できる数字にならない。
 */
export function computeRosterRevision(
  members: RosterMember[],
  opts: { asOf: string; annualDays?: number },
): RosterRevision {
  const annualDays = opts.annualDays ?? ANNUAL_DAYS

  const rows: RosterRow[] = members.map(m => {
    const adj = m.adjustment ?? 0
    const cur = m.currentStep === null ? null : dailyForStep(m.grade, m.currentStep) + adj
    const tenureMonths = m.hireDate ? monthsBetween(m.hireDate, opts.asOf) : null

    if (m.fixed) {
      // 処遇固定。等級の上限に置いてあるので号は動かないが、意図を明示するため計算しない
      return {
        member: m, status: 'fixed', result: null, oldTotal: cur, newTotal: cur,
        tenureMonths, blockers: ['処遇固定（改定対象外）'],
      }
    }

    // 在籍が浅い人は初回改定の対象外。individual に含める判断をしたら forceInclude で上書きする
    if (!m.forceInclude && tenureMonths !== null && tenureMonths < FIRST_REVISION_MIN_MONTHS) {
      return {
        member: m, status: 'ineligible', result: null, oldTotal: cur, newTotal: cur, tenureMonths,
        blockers: [`在籍${tenureMonths}ヶ月（初回改定は${FIRST_REVISION_MIN_MONTHS}ヶ月以上）`],
      }
    }

    const blockers: string[] = []
    if (m.currentStep === null) blockers.push('号が未確定')
    if (m.birthDate === null) blockers.push('生年月日が未登録（年齢調整が出せない）')
    if ((m.hyogo === 'SS' || m.hyogo === 'S' || m.hyogo === 'B' || m.hyogo === 'C')
      && !m.reason?.trim()) blockers.push(`${m.hyogo}評価には理由の記録が必要`)
    // 裁量で動かすものほど、なぜそうしたかが残っていないと翌年に説明できない
    if ((m.discretionaryPitch ?? 0) !== 0 && !m.discretionaryReason?.trim()) {
      blockers.push('代表加算には理由の記録が必要')
    }

    if (blockers.length > 0) {
      return { member: m, status: 'blocked', result: null, oldTotal: cur, newTotal: null, tenureMonths, blockers }
    }

    const result = computeRevision({
      grade: m.grade,
      currentStep: m.currentStep!,
      hyogo: m.hyogo,
      age: ageOn(m.birthDate!, opts.asOf),
      specialKeys: m.specialKeys,
      discretionaryPitch: m.discretionaryPitch,
    })
    return {
      member: m, status: 'ok', result,
      oldTotal: result.oldDaily + adj,
      newTotal: result.newDaily + adj,
      tenureMonths, blockers: [],
    }
  })

  // 評語のバランスは、改定対象になる人だけで見る（固定・保留の人は母数に入れない）
  const balance = checkHyogoBalance(
    rows.filter(r => r.result !== null).map(r => r.member.hyogo),
  )
  const raisePerDay = rows.reduce((s, r) => s + (r.result?.raisePerDay ?? 0), 0)

  return {
    rows, balance,
    applied: rows.filter(r => r.status === 'ok').length,
    blocked: rows.filter(r => r.status === 'blocked').length,
    ineligible: rows.filter(r => r.status === 'ineligible').length,
    raisePerDay,
    annualCost: raisePerDay * annualDays,
  }
}

/**
 * 改定の基準日（毎年10月1日・docs/wage-system.md 第4節）のうち、指定日以後で最も近いもの。
 *
 * 年齢調整はこの日の満年齢で決まる。画面に「◯歳」を出すときは必ずこの日を基準にする
 * （今日の年齢を出すと、10月1日をまたぐ人の表示と実際の改定額が食い違う）。
 */
export function nextRevisionDate(todayIso: string): string {
  const year = Number(todayIso.slice(0, 4))
  const oct = `${year}-10-01`
  return todayIso <= oct ? oct : `${year + 1}-10-01`
}

// ────────────────────────────────────────
//  給料表（本人へ渡す様式）の換算
// ────────────────────────────────────────

/**
 * 年間の有給付与日数。給料表ではこの日数を「買取」として年収に含めている。
 *
 * ⚠️ 実際の付与日数は勤続年数で変わるが、給料表は全員 20日 で計算している
 *    （2025年10月改定版の実物で確認）。個人の付与実績ではなく、年収を比較する
 *    ための共通の物差しとして使っているため、ここも定数で持つ。
 */
export const PAID_LEAVE_DAYS = 20

/** ベース年収の計算日数 = 稼働290日 + 有給20日。 */
export const TOTAL_PAID_DAYS = ANNUAL_DAYS + PAID_LEAVE_DAYS

/**
 * ベース年収 = 確定日給 × 310。
 * 稼働290日分に有給20日分の買取を足したもの。給料表の「ベース年収概算」。
 */
export function baseAnnualWithLeave(daily: number): number {
  return daily * TOTAL_PAID_DAYS
}

/**
 * 実質日給 = ベース年収 ÷ 稼働日数。
 * 有給の買取分を稼働日にならすと1日いくらになるか、という指標。
 */
export function effectiveDaily(daily: number): number {
  return (daily * TOTAL_PAID_DAYS) / ANNUAL_DAYS
}

export interface PaySheetFigures {
  /** 号俸表の額（＋調整給） */
  daily: number
  /** 改訂前の日額 */
  prevDaily: number
  paidLeaveDays: number
  /** 有給買取額 = 日額 × 付与日数 */
  leaveBuyout: number
  /** 買取額の日給換算 = 買取額 ÷ 稼働日数 */
  leavePerDay: number
  effectiveDaily: number
  prevEffectiveDaily: number
  /** 昇給（日）= 実質日給の差 */
  raisePerDay: number
  baseAnnual: number
  prevBaseAnnual: number
  /** 昇給（年）= ベース年収の差 */
  raisePerYear: number
  /** UP率 */
  upRate: number
}

/** 給料表に載せる数値を一括で出す。 */
export function paySheetFigures(daily: number, prevDaily: number): PaySheetFigures {
  const leaveBuyout = daily * PAID_LEAVE_DAYS
  const eff = effectiveDaily(daily)
  const prevEff = effectiveDaily(prevDaily)
  const base = baseAnnualWithLeave(daily)
  const prevBase = baseAnnualWithLeave(prevDaily)
  return {
    daily, prevDaily,
    paidLeaveDays: PAID_LEAVE_DAYS,
    leaveBuyout,
    leavePerDay: leaveBuyout / ANNUAL_DAYS,
    effectiveDaily: eff,
    prevEffectiveDaily: prevEff,
    raisePerDay: eff - prevEff,
    baseAnnual: base,
    prevBaseAnnual: prevBase,
    raisePerYear: base - prevBase,
    upRate: prevBase > 0 ? base / prevBase - 1 : 0,
  }
}

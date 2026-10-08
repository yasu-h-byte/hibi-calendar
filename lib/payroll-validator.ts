/**
 * 給与計算の自動検算ヘルパー（2026-06-XX 新設）
 *
 * 背景:
 *   過去3回の指摘（残業式表示・所定外労働の未払い・法定外残業の二重支給）は
 *   すべて「外から見て分からない」タイプのバグ。継続的に検出する仕組みが必要。
 *
 * 戦略:
 *   各構成要素（otAllowance / nonStatutoryOTAllowance / legalHolidayAllowance / ...）
 *   が法令・実労働時間に対して妥当な範囲にあるかを個別に検証する。
 *
 *   salaryNet 全体の上下限チェックは partial-day や baseDays/prescribedDays の
 *   ズレで false positive が出やすいので採用しない。代わりに各コンポーネントを
 *   ピンポイントで verify することで、過去バグ3種を全て検出する。
 *
 * 検証する不変条件（新ルール外国人スタッフ向け）:
 *   I1. 構成要素合計 == salaryNet（内訳整合）
 *   I2. otAllowance の下限: 時給 × legalOtHours × 0.25
 *       → 「法定外残業の割増が支払われていない」バグを検出
 *   I3. otAllowance の上限: 時給 × legalOtHours × 0.5 + バッファ
 *       → 「法定外残業の二重支給(1.25倍)」バグを検出（過去のハウさんケース）
 *   I4. nonStatutoryOTAllowance の下限: 時給 × max(0, regularHours - regularWorkDays × 7)
 *       → 「所定外労働手当の支給漏れ」バグを検出（過去のサンさんケース）
 *   I5. legalHolidayAllowance: 時給 × legalHolidayHours × [1.35, 1.60]
 *       → 法定休日割増の漏れ・過剰を検出
 *   I6. nightAllowance: 時給 × nightHours × 0.25（誤差±2円）
 *       → 深夜手当の漏れ・誤計算を検出
 *   I7. compAllowance: 時給 × compDays × 7 × 0.6（誤差±2円）
 *       → 休業手当の誤計算を検出
 *
 * 注意点（2026-10-02 総合点検・2026年9月分〜）:
 *   computeMonthly が付けた payNotes（支給額は変えない「このままだと不足払い・取り違えになり得る」）を
 *   warning として出す。対象は新ルールの外国人に限らず全員（旧ルール・日本人も）。
 *   critical ではないので締めは止めない。月次集計の帯・計算根拠・Excel・PDF に同じ文で出る。
 */

import { fmtYen } from './format'

export interface PayrollValidationIssue {
  severity: 'critical' | 'warning'
  workerId: number
  workerName: string
  field: string
  message: string
  expected?: number
  actual?: number
  diff?: number
}

export interface PayrollSnapshot {
  id: number
  name: string
  visa?: string
  hourlyRate?: number
  salary?: number
  useOldRules?: boolean
  // 集計データ
  workDays: number
  actualWorkDays?: number
  actualWorkHours?: number        // = regularHours + legalHolidayHours
  regularWorkDays?: number        // 通常出勤日数（法定休日除く）
  compDays: number
  compInGuaranteeDays?: number
  plDays: number
  examDays?: number
  legalHolidayHours?: number      // 法定休日(日曜)の実労働時間
  nightHours?: number
  legalOtHours?: number
  otHours: number
  // 支給項目
  fixedBasePay?: number
  basePay?: number
  additionalAllowance?: number
  paidLeaveAllowance?: number
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  otAllowance?: number
  legalHolidayAllowance?: number
  nightAllowance?: number
  compAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
  // 遠方現場日当・運転手当（2026-10 施行）。salaryNetPay に加算済みなので I1 の構成要素に含める
  siteAllowance?: number
  driveAllowance?: number
  /** 有給精算手当（日本人の日給月給・2026-10〜）。salaryNetPay に加算済み */
  leaveSettleAllowance?: number
  leaveSettleDays?: number
  /** 休憩短縮手当（2026-09 施行）。同じく salaryNetPay に加算済み */
  breakShortenAllowance?: number
  /** 給与チェックの注意点（lib/compute.ts computeMonthly が付ける。支給額は変えない・2026-10-02） */
  payNotes?: { code: string; message: string; amount?: number }[]
}

/**
 * 1スタッフの支給結果を検算する。
 *
 * 対象: 新ルールの外国人スタッフ（useOldRules=false, visa≠'none', hourlyRate>0）。
 *   旧ルール・日本人・月給制は別の計算式なので、本検算は適用しない。
 */
export function validatePayroll(w: PayrollSnapshot): PayrollValidationIssue[] {
  const issues: PayrollValidationIssue[] = []

  // 注意点（全員）: 支給額は変えず、締める前に気づけるように warning で出す（2026-10-02 総合点検）
  for (const n of w.payNotes || []) {
    issues.push({ severity: 'warning', workerId: w.id, workerName: w.name, field: n.code, message: n.message })
  }

  // 対象判定: 新ルール外国人時給制のみ
  const isTarget = !w.useOldRules
    && w.visa !== 'none'
    && (w.hourlyRate || 0) > 0
    && (w.salary === undefined || w.salary === 0)
  if (!isTarget) return issues

  const hourlyRate = w.hourlyRate || 0
  const salaryNet = w.salaryNetPay || 0
  const actualHours = w.actualWorkHours || 0
  const legalHolidayHours = w.legalHolidayHours || 0
  const regularHours = Math.max(0, actualHours - legalHolidayHours)
  const regularWorkDays = w.regularWorkDays || 0
  const nightHours = w.nightHours || 0
  const legalOtHours = w.legalOtHours || 0
  const compDays = w.compDays || 0
  // 2026-09-15: 保証枠の中の補償日は100%支給（休業手当60%の対象外）
  const compAllowanceDays = compDays - (w.compInGuaranteeDays || 0)

  // ── 時間の0.1h丸め許容（2026-06-30 誤検知対策） ──
  // compute.ts は legalOtHours / legalHolidayHours / nightHours を return 時に
  // 0.1h 単位へ丸めるが、実支給額は丸め前の精密な時間で計算する。表示用に丸めた
  // 時間で「想定」を出すと、最大 ±0.05h 分（割増額で 時給×0.05×倍率 円）ズレる。
  // これは過払い/未払いではなく丸め差なので、各時間ベースのチェックの許容差に
  // この分を織り込む（実バグは手当まるごと欠落=桁違いなので依然として検出可能）。
  const hoursRoundSlack = (mult: number) => Math.ceil(hourlyRate * 0.05 * mult) + 2

  const push = (
    severity: 'critical' | 'warning',
    field: string,
    message: string,
    expected: number,
    actual: number,
  ) => {
    issues.push({
      severity, workerId: w.id, workerName: w.name, field, message,
      expected, actual, diff: actual - expected,
    })
  }

  // ── I1. 構成要素合計 == salaryNet ──
  const components = (w.fixedBasePay || 0)
    + (w.additionalAllowance || 0)
    + (w.paidLeaveAllowance || 0)
    + (w.nonStatutoryOTAllowance || 0)
    + (w.otAllowance || 0)
    + (w.legalHolidayAllowance || 0)
    + (w.nightAllowance || 0)
    + (w.compAllowance || 0)
    + (w.siteAllowance || 0)
    + (w.driveAllowance || 0)
    + (w.leaveSettleAllowance || 0)
    + (w.breakShortenAllowance || 0)
    - (w.absentDeduction || 0)
  if (Math.abs(components - salaryNet) > 2) {
    push('critical', 'salaryNetPay', '構成要素の合計が支給額と一致しません',
      components, salaryNet)
  }

  // ── I2/I3. otAllowance: [0.25, 0.5] 倍に収まる ──
  // 60h未満は 0.25倍、60h超は 0.5倍
  // 上限の最大: 60h以下は 0.25倍、60h超え部分が 0.5倍。
  //   即ち全部60h超でも上限 = 0.5 × legalOtHours
  const otMin = Math.round(hourlyRate * legalOtHours * 0.25)
  const otMax = Math.round(hourlyRate * legalOtHours * 0.5)
  const paidOtAllowance = w.otAllowance || 0
  if (paidOtAllowance < otMin - hoursRoundSlack(0.25)) {
    push('critical', 'otAllowance',
      '法定外残業の割増（0.25倍以上）が不足（労基法37条違反リスク）',
      otMin, paidOtAllowance)
  }
  if (paidOtAllowance > otMax + hoursRoundSlack(0.5)) {
    push('critical', 'otAllowance',
      '法定外残業手当が上限（0.5倍）を超える（二重支給の可能性）',
      otMax, paidOtAllowance)
  }

  // ── I4. nonStatutoryOTAllowance の下限 ──
  // 推定: 時給 × max(0, regularHours - regularWorkDays × 7)
  //   ※ 各日所定 7h と仮定（実際は site.workSchedule により変動するが、
  //     IHI現場(8h)等の例外を除き 7h がほとんど）
  //   ※ 過小評価する方向なので "下限" として使用 — false positive を避ける
  const expectedNonStatOT = Math.max(0, regularHours - regularWorkDays * 7) * hourlyRate
  const paidNonStatOT = w.nonStatutoryOTAllowance || 0
  // 許容差: round(=±0.5) × 各日 = regularWorkDays × hourlyRate × 0.5 + buffer
  // 簡単のため hourlyRate (1h分) を許容
  const nonStatTolerance = hourlyRate + 100
  if (paidNonStatOT < expectedNonStatOT - nonStatTolerance) {
    push('critical', 'nonStatutoryOTAllowance',
      '所定外労働手当が不足（残業欄入力分の支給漏れの可能性）',
      Math.round(expectedNonStatOT), paidNonStatOT)
  }

  // ── I5. legalHolidayAllowance: [1.35, 1.60] 倍 ──
  const lhMin = Math.round(hourlyRate * legalHolidayHours * 1.35)
  const lhMax = Math.round(hourlyRate * legalHolidayHours * 1.60)
  const paidLhAllowance = w.legalHolidayAllowance || 0
  if (paidLhAllowance < lhMin - hoursRoundSlack(1.35)) {
    push('critical', 'legalHolidayAllowance',
      '法定休日手当が下限（1.35倍）未満',
      lhMin, paidLhAllowance)
  }
  if (paidLhAllowance > lhMax + hoursRoundSlack(1.60)) {
    push('warning', 'legalHolidayAllowance',
      '法定休日手当が上限（1.60倍）超',
      lhMax, paidLhAllowance)
  }

  // ── I6. nightAllowance: 時給 × nightHours × 0.25（誤差±2円） ──
  const expectedNight = Math.round(hourlyRate * nightHours * 0.25)
  const paidNight = w.nightAllowance || 0
  if (Math.abs(paidNight - expectedNight) > hoursRoundSlack(0.25)) {
    push('critical', 'nightAllowance',
      '深夜手当が想定（0.25倍）と一致しません',
      expectedNight, paidNight)
  }

  // ── I7. compAllowance: 時給 × compDays × 7 × 0.6（誤差±2円） ──
  const expectedComp = Math.round(hourlyRate * compAllowanceDays * 7 * 0.6)
  const paidComp = w.compAllowance || 0
  if (Math.abs(paidComp - expectedComp) > 2) {
    push('critical', 'compAllowance',
      '休業手当が想定（60%）と一致しません',
      expectedComp, paidComp)
  }

  return issues
}

/**
 * 複数スタッフ分まとめて検算
 */
export function validatePayrolls(workers: PayrollSnapshot[]): {
  total: number
  critical: number
  warning: number
  issues: PayrollValidationIssue[]
  affectedWorkerIds: number[]
} {
  const allIssues: PayrollValidationIssue[] = []
  for (const w of workers) {
    allIssues.push(...validatePayroll(w))
  }
  const affectedIds = new Set(allIssues.map(i => i.workerId))
  return {
    total: allIssues.length,
    critical: allIssues.filter(i => i.severity === 'critical').length,
    warning: allIssues.filter(i => i.severity === 'warning').length,
    issues: allIssues,
    affectedWorkerIds: Array.from(affectedIds),
  }
}

// ─────────────────────────────────────────
// 計算根拠（PayrollAuditContent / 計算根拠PDF）の型・区分判定・監査チェック
//   2026-10-02 総合点検で components/monthly/PayrollAuditContent.tsx から移した（テストから読めるように）
// ─────────────────────────────────────────

export interface PayrollAuditWorker {
  id: number
  name: string
  /** キャシュモ管理の従業員番号（提出用PDFのヘッダーに載せる） */
  payrollNo?: string
  org: string
  visa: string
  job: string
  rate: number
  hourlyRate?: number
  otMul: number
  salary?: number
  workDays: number
  actualWorkDays: number
  compDays: number
  workAll: number
  otHours: number
  plDays: number
  plUsed: number
  restDays: number
  siteOffDays: number
  examDays?: number
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  prescribedHours?: number
  workerPrescribedDays?: number  // 配置現場 calendar の所定日数（baseDays とは別概念）
  hkDays?: number                // 帰国中（一時帰国・復帰未定）日数。所定から除外され無給・非欠勤
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  compBaseDeduction?: number  // 旧ルール固定給: 補償日 通常分控除（満額・60%を別途休業補償で還元）
  salaryNetPay?: number
  fixedBasePay?: number
  additionalAllowance?: number
  paidLeaveDays?: number
  paidLeaveAllowance?: number
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  legalLimit?: number
  legalHolidayHours?: number
  legalHolidayAllowance?: number
  nightHours?: number
  nightAllowance?: number
  compAllowance?: number
  // 休憩短縮手当（2026-09 施行。支給額に加算済み）
  breakShortenHours?: number
  breakShortenAllowance?: number
  // 遠方現場日当・運転手当（2026-10 施行。支給額に加算済み）
  siteAllowance?: number
  allowanceDays?: number
  driveAllowance?: number
  /** 有給精算手当（日本人の日給月給・2026-10〜）。salaryNetPay に加算済み */
  leaveSettleAllowance?: number
  leaveSettleDays?: number
  driveLegs?: number
  regularWorkDays?: number
  isDispatched?: boolean
  dispatchTo?: string
  dispatchDeduction?: number
  useOldRules?: boolean
  // ── 2026-10-02 総合点検で表示に加えた項目（lib/compute.ts WorkerMonthly と同名）──
  /** 最低20日保証の保証枠 = min(20, カレンダー所定日数) */
  guaranteeDays?: number
  /** 保証から引く本人の欠勤（カレンダーの仕事の日の「欠」・2026年9月分〜） */
  personalAbsenceDays?: number
  /** 保証枠の中で100%支給にした補償日数（2026年8月分〜） */
  compInGuaranteeDays?: number
  /** 人工（夜勤 1.5／日勤＋夜勤 2.5）。無い月は出勤日数と同じ */
  manDays?: number
  nightShiftDays?: number
  nightManDays?: number
  /** 日本人: 法定休日（日曜）の人工（8〜9月分だけ基本給から除いて別枠支給） */
  legalHolidayManDays?: number
  legalHolidayDays?: number
  /** 給与チェックの注意点（支給額は変えない） */
  payNotes?: { code: string; message: string; amount?: number }[]
}

// ─────────────────────────────────────────
// ヘルパー関数
// ─────────────────────────────────────────

export function getEmploymentMode(w: PayrollAuditWorker, ym: string): {
  label: string
  description: string
  useOldRules: boolean
} {
  const isJapanese = !w.visa || w.visa === 'none'
  const yearMonth = parseInt(ym.slice(0, 4)) * 100 + parseInt(ym.slice(4, 6))
  const workerOptedOut = (w as { useOldRules?: boolean }).useOldRules === true
  const isNewRules = yearMonth >= 202605 && !workerOptedOut
  const useOldRules = !isNewRules
  if (isJapanese) {
    if (w.salary && w.salary > 0) return {
      label: '月給制（日本人）',
      description: '基本給は月給固定、残業は時給換算 × otMul で加算',
      useOldRules,
    }
    return {
      label: '日給制（日本人）',
      description: '基本給 = 日額 × 出勤日数、残業は (日額/8) × otMul × 残業h',
      useOldRules,
    }
  }
  if (w.salary && w.salary > 0) return {
    label: '月給制（外国人）',
    description: useOldRules
      ? '基本給は固定月給（所定日数で変動しない）。残業単価・欠勤控除は日給ベースで固定（旧ルール継続者: フン等）'
      : '基本給は月給固定、時給を月給から逆算して各種手当を計算',
    useOldRules,
  }
  return {
    label: '時給制（外国人）',
    description: useOldRules
      ? '旧ルール: 月所定時間ベース、基本給 = 時給 × 月所定h'
      : '新ルール: 法令準拠の3層構造（基本給 + 追加所定 + 各種割増）',
    useOldRules,
  }
}

export function calcLegalMonthlyLimit(ym: string): number {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  return Math.round((daysInMonth * 40 / 7) * 10) / 10
}

// テーブルセル向け数値表示（0 なら '—'）
export function fmtNum(n: number | undefined | null, suffix = ''): string {
  if (n == null || n === 0) return '—'
  return `${Math.round(n * 10) / 10}${suffix}`
}

// 時間 h 表示（0でも数値表示、計算式の中で必要）
export function fmtH(n: number | undefined | null): string {
  return `${Math.round((n || 0) * 10) / 10}h`
}

// ─────────────────────────────────────────
// 監査チェック構築
// ─────────────────────────────────────────

export interface AuditCheck {
  label: string
  pass: boolean
  detail: string
}

export function buildAuditChecks(w: PayrollAuditWorker, ym: string, prescribedDays: number): AuditCheck[] {
  const checks: AuditCheck[] = []
  const legalLimit = calcLegalMonthlyLimit(ym)
  const mode = getEmploymentMode(w, ym)

  // 1. 法定上限チェック（1ヶ月単位の変形労働時間制＝新ルールの外国人だけ・2026-10-02 総合点検）
  //   旧: 日本人日給（所定時間を持たない）には「全社所定日数×7h」、旧ルール固定月給には「所定日数×6h40m」を
  //   当てていたため、全社所定が27日の月（2026年10月）は 189h／180h > 177.1h となり全員 ❌ になっていた。
  //   日本人・旧ルールは月の総枠（暦日×40÷7）で判定する制度ではないので、このチェックは出さない
  const isForeignNewRules = !mode.useOldRules && !!w.visa && w.visa !== 'none'
  if (isForeignNewRules) {
    const prescribedHours = w.prescribedHours || (prescribedDays * 7)
    checks.push({
      label: '所定労働時間が法定上限以内',
      pass: prescribedHours <= legalLimit,
      detail: `所定 ${fmtH(prescribedHours)} ≦ 法定上限 ${fmtH(legalLimit)} (= 暦日数 × 40 ÷ 7)`,
    })
  }

  // 2. 出勤日数の整合性
  //   分母はスタッフ個別の所定（配置現場カレンダー）を優先。全社所定(prescribedDays)は
  //   旧ルール用で、未設定の月に 0 が入り全員 ❌ になる時限バグだった（2026-08-27）
  const daysBasis = w.workerPrescribedDays || prescribedDays
  const daysAccountedFor = w.workDays + (w.plDays || 0) + (w.restDays || 0) + (w.siteOffDays || 0) + (w.examDays || 0) + (w.compDays || 0)
  checks.push({
    label: '出勤実績の合計が所定日数以内',
    pass: daysBasis <= 0 || daysAccountedFor <= daysBasis + 1,
    detail: `出勤${w.workDays} + 有給${w.plDays || 0} + 欠勤${w.restDays || 0} + 現場休${w.siteOffDays || 0} + 試験${w.examDays || 0} + 補償${w.compDays || 0}${(w.hkDays || 0) > 0 ? ` ＋ 帰国中${w.hkDays}（所定から除外・無給）` : ''} = ${daysAccountedFor}日 ≦ 所定${prescribedDays}日`,
  })

  // 3. 支給額の内訳整合
  const fixedBase = w.fixedBasePay || w.basePay || 0
  let sumPay: number
  if (mode.useOldRules) {
    // 2026-08-27 修正（給与総点検）: 旧ルール表示は「4月以前の全員」も通るため、
    //   日本人日給月給の構成要素（有給手当・法定休日手当）が抜けていると
    //   有給取得者・日曜出勤者で「内訳合計が一致しない」誤検知になっていた
    sumPay = fixedBase
      + (w.additionalAllowance || 0)
      + (w.paidLeaveAllowance || 0)
      + (w.legalHolidayAllowance || 0)
      + (w.otAllowance || 0)
      + (w.breakShortenAllowance || 0)
      + (w.siteAllowance || 0)
      + (w.driveAllowance || 0)
      + (w.leaveSettleAllowance || 0)
      - (w.absentDeduction || 0)
      - (w.compBaseDeduction || 0)
  } else {
    sumPay = fixedBase
      + (w.additionalAllowance || 0)
      + (w.paidLeaveAllowance || 0)
      + (w.nonStatutoryOTAllowance || 0)
      + (w.otAllowance || 0)
      + (w.legalHolidayAllowance || 0)
      + (w.nightAllowance || 0)
      + (w.compAllowance || 0)
      + (w.breakShortenAllowance || 0)
      + (w.siteAllowance || 0)
      + (w.driveAllowance || 0)
      + (w.leaveSettleAllowance || 0)
      - (w.absentDeduction || 0)
  }
  const reported = w.salaryNetPay || 0
  checks.push({
    label: '支給額の内訳合計が一致',
    pass: Math.abs(sumPay - reported) < 2,
    detail: mode.useOldRules
      ? `基本 ${fmtYen(fixedBase)} + 休業補償 ${fmtYen(w.additionalAllowance || 0)} + 残業 ${fmtYen(w.otAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)}${(w.compBaseDeduction || 0) > 0 ? ` - 補償日通常分 ${fmtYen(w.compBaseDeduction || 0)}` : ''} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`
      : `基本 ${fmtYen(fixedBase)} + 追加所定 ${fmtYen(w.additionalAllowance || 0)} + 有給日給 ${fmtYen(w.paidLeaveAllowance || 0)} + 所定外労働 ${fmtYen(w.nonStatutoryOTAllowance || 0)} + 法定外残業 ${fmtYen(w.otAllowance || 0)} + 法定休日 ${fmtYen(w.legalHolidayAllowance || 0)} + 深夜 ${fmtYen(w.nightAllowance || 0)} + 休業 ${fmtYen(w.compAllowance || 0)}${(w.siteAllowance || 0) + (w.driveAllowance || 0) > 0 ? ` + 日当 ${fmtYen(w.siteAllowance || 0)} + 運転 ${fmtYen(w.driveAllowance || 0)}` : ''}${(w.leaveSettleAllowance || 0) > 0 ? ` + 有給精算 ${fmtYen(w.leaveSettleAllowance || 0)}` : ''} - 欠勤 ${fmtYen(w.absentDeduction || 0)} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`,
  })

  // 4. otMul の妥当性
  checks.push({
    label: '残業倍率が法定下限以上',
    pass: w.otMul >= 1.25,
    detail: `otMul = ${w.otMul} ≧ 1.25 (労基法37条)`,
  })

  // 5. 自動検算（注意点 payNotes は上の「注意点」欄に出すので、ここは不変条件だけ・2026-10-02）
  if (!mode.useOldRules) {
    const issues = validatePayroll({ ...(w as unknown as PayrollSnapshot), payNotes: undefined })
    if (issues.length === 0) {
      checks.push({
        label: '自動検算（労基法・実労働時間ベース）',
        pass: true,
        detail: '全項目 ✓: 法定外残業 [0.25, 0.5]倍 / 所定外労働の支給漏れなし / 法定休日 [1.35, 1.60]倍 / 深夜 0.25倍 / 休業 60%',
      })
    } else {
      checks.push({
        label: '自動検算（労基法・実労働時間ベース）',
        pass: false,
        detail: issues.map(i =>
          `[${i.severity}] ${i.message}: 想定 ${fmtYen(i.expected || 0)} / 実額 ${fmtYen(i.actual || 0)} (差 ${(i.diff || 0) > 0 ? '+' : ''}${fmtYen(i.diff || 0)})`
        ).join(' / '),
      })
    }
  }

  return checks
}

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
 */

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
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  otAllowance?: number
  legalHolidayAllowance?: number
  nightAllowance?: number
  compAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
}

/**
 * 1スタッフの支給結果を検算する。
 *
 * 対象: 新ルールの外国人スタッフ（useOldRules=false, visa≠'none', hourlyRate>0）。
 *   旧ルール・日本人・月給制は別の計算式なので、本検算は適用しない。
 */
export function validatePayroll(w: PayrollSnapshot): PayrollValidationIssue[] {
  const issues: PayrollValidationIssue[] = []

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
    + (w.nonStatutoryOTAllowance || 0)
    + (w.otAllowance || 0)
    + (w.legalHolidayAllowance || 0)
    + (w.nightAllowance || 0)
    + (w.compAllowance || 0)
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
  if (paidOtAllowance < otMin - 2) {
    push('critical', 'otAllowance',
      '法定外残業の割増（0.25倍以上）が不足（労基法37条違反リスク）',
      otMin, paidOtAllowance)
  }
  if (paidOtAllowance > otMax + 2) {
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
  if (paidLhAllowance < lhMin - 2) {
    push('critical', 'legalHolidayAllowance',
      '法定休日手当が下限（1.35倍）未満',
      lhMin, paidLhAllowance)
  }
  if (paidLhAllowance > lhMax + 2) {
    push('warning', 'legalHolidayAllowance',
      '法定休日手当が上限（1.60倍）超',
      lhMax, paidLhAllowance)
  }

  // ── I6. nightAllowance: 時給 × nightHours × 0.25（誤差±2円） ──
  const expectedNight = Math.round(hourlyRate * nightHours * 0.25)
  const paidNight = w.nightAllowance || 0
  if (Math.abs(paidNight - expectedNight) > 2) {
    push('critical', 'nightAllowance',
      '深夜手当が想定（0.25倍）と一致しません',
      expectedNight, paidNight)
  }

  // ── I7. compAllowance: 時給 × compDays × 7 × 0.6（誤差±2円） ──
  const expectedComp = Math.round(hourlyRate * compDays * 7 * 0.6)
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

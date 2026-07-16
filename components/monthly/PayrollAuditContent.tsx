/**
 * 給与計算の根拠表示（コンテンツ本体）
 *
 * 2026-06-XX 抽出: PayrollAuditModal から表示本体を独立化。
 *   理由: モーダル表示と印刷ページ (/monthly/audit-print) で同じ内容を
 *         レンダリングするための共通コンポーネント化。
 *
 * 設計方針:
 *   - 計算は行わない（compute.ts で既に行われた値を可視化するだけ）
 *   - 各セクションは「根拠 = 式 = 結果」の形で表記
 *   - 監査チェック（不変条件）を末尾に並べて、視覚的に ✓ / ❌ 確認
 *   - モーダル枠線・閉じるボタンは含まない、純粋に内容のみ
 */
'use client'

import { fmtYen } from '@/lib/format'
import { validatePayroll, type PayrollSnapshot } from '@/lib/payroll-validator'

// ─────────────────────────────────────────
// 型定義（PayrollAuditModal から移管）
// ─────────────────────────────────────────

export interface PayrollAuditWorker {
  id: number
  name: string
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
  regularWorkDays?: number
  isDispatched?: boolean
  dispatchTo?: string
  dispatchDeduction?: number
  useOldRules?: boolean
}

interface Props {
  worker: PayrollAuditWorker
  ym: string
  prescribedDays: number
  baseDays: number
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

  // 1. 法定上限チェック
  const prescribedHours = w.prescribedHours || (prescribedDays * 7)
  checks.push({
    label: '所定労働時間が法定上限以内',
    pass: prescribedHours <= legalLimit,
    detail: `所定 ${fmtH(prescribedHours)} ≦ 法定上限 ${fmtH(legalLimit)} (= 暦日数 × 40 ÷ 7)`,
  })

  // 2. 出勤日数の整合性
  const daysAccountedFor = w.workDays + (w.plDays || 0) + (w.restDays || 0) + (w.siteOffDays || 0) + (w.examDays || 0) + (w.compDays || 0)
  checks.push({
    label: '出勤実績の合計が所定日数以内',
    pass: daysAccountedFor <= prescribedDays + 1,
    detail: `出勤${w.workDays} + 有給${w.plDays || 0} + 欠勤${w.restDays || 0} + 現場休${w.siteOffDays || 0} + 試験${w.examDays || 0} + 補償${w.compDays || 0} = ${daysAccountedFor}日 ≦ 所定${prescribedDays}日`,
  })

  // 3. 支給額の内訳整合
  const fixedBase = w.fixedBasePay || w.basePay || 0
  let sumPay: number
  if (mode.useOldRules) {
    sumPay = fixedBase
      + (w.additionalAllowance || 0)
      + (w.otAllowance || 0)
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
      - (w.absentDeduction || 0)
  }
  const reported = w.salaryNetPay || 0
  checks.push({
    label: '支給額の内訳合計が一致',
    pass: Math.abs(sumPay - reported) < 2,
    detail: mode.useOldRules
      ? `基本 ${fmtYen(fixedBase)} + 休業補償 ${fmtYen(w.additionalAllowance || 0)} + 残業 ${fmtYen(w.otAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)}${(w.compBaseDeduction || 0) > 0 ? ` - 補償日通常分 ${fmtYen(w.compBaseDeduction || 0)}` : ''} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`
      : `基本 ${fmtYen(fixedBase)} + 追加所定 ${fmtYen(w.additionalAllowance || 0)} + 有給日給 ${fmtYen(w.paidLeaveAllowance || 0)} + 所定外労働 ${fmtYen(w.nonStatutoryOTAllowance || 0)} + 法定外残業 ${fmtYen(w.otAllowance || 0)} + 法定休日 ${fmtYen(w.legalHolidayAllowance || 0)} + 深夜 ${fmtYen(w.nightAllowance || 0)} + 休業 ${fmtYen(w.compAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`,
  })

  // 4. otMul の妥当性
  checks.push({
    label: '残業倍率が法定下限以上',
    pass: w.otMul >= 1.25,
    detail: `otMul = ${w.otMul} ≧ 1.25 (労基法37条)`,
  })

  // 5. 自動検算
  if (!mode.useOldRules) {
    const issues = validatePayroll(w as unknown as PayrollSnapshot)
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

// ─────────────────────────────────────────
// 本体コンポーネント
// ─────────────────────────────────────────

export default function PayrollAuditContent({ worker: w, ym, prescribedDays, baseDays }: Props) {
  const mode = getEmploymentMode(w, ym)
  const legalLimit = calcLegalMonthlyLimit(ym)
  const audits = buildAuditChecks(w, ym, prescribedDays)
  const passingAudits = audits.filter(a => a.pass).length
  const daysInMonth = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)), 0).getDate()

  // 基本給の式表示
  const basePayFormula = (): string => {
    if (mode.label.startsWith('月給制（日本人）')) {
      return `月給固定 ${fmtYen(w.salary || 0)}`
    }
    if (mode.label.startsWith('日給制（日本人）')) {
      return `日額 ${fmtYen(w.rate)} × 出勤日数 ${w.workDays}日 + 補償 ${fmtYen(w.rate)} × 0.6 × ${w.compDays}日 = ${fmtYen(w.basePay || 0)}`
    }
    if (mode.label.startsWith('月給制（外国人）')) {
      return `月給固定 ${fmtYen(w.salary || 0)}`
    }
    if (mode.useOldRules) {
      return `時給 ${fmtYen(w.hourlyRate || 0)} × 月所定時間 ${fmtH(w.prescribedHours)} = ${fmtYen(w.basePay || 0)}`
    }
    return `時給 ${fmtYen(w.hourlyRate || 0)} × ${baseDays}日 × 7h = ${fmtYen(w.fixedBasePay || w.basePay || 0)}`
  }

  return (
    <div className="space-y-5 text-sm">

      {/* ① 月情報 */}
      <section>
        <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">① 月情報</h3>
        <table className="w-full text-xs">
          <tbody className="[&_td]:py-1 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
            <tr><td>暦日数</td><td className="font-mono">{daysInMonth}日</td></tr>
            <tr><td>法定上限（月）</td><td className="font-mono">{daysInMonth} × 40 ÷ 7 = <strong>{fmtH(legalLimit)}</strong></td></tr>
            {(() => {
              const wpd = w.workerPrescribedDays ?? prescribedDays
              const source = mode.useOldRules
                ? '全社所定（日曜・祝日除く）'
                : '配置現場の就業カレンダー'
              return (
                <tr>
                  <td>所定日数</td>
                  <td className="font-mono">
                    <strong>{wpd}日</strong>
                    <span className="text-gray-500 ml-1">（{source}）</span>
                  </td>
                </tr>
              )
            })()}
            {!mode.useOldRules && w.prescribedHours !== undefined && (() => {
              const baseDaysFromHours = Math.round(w.prescribedHours / 7)
              const wpd = w.workerPrescribedDays ?? prescribedDays
              return (
                <tr>
                  <td>基本給ベース日数</td>
                  <td className="font-mono">
                    <strong>{baseDaysFromHours}日</strong>
                    <span className="text-gray-500 ml-1">（全社設定: 基本給 = 時給 × {baseDaysFromHours}日 × 7h）</span>
                    {wpd > baseDaysFromHours && (
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        ※ 所定 {wpd}日 が {baseDaysFromHours}日 を超える分は「追加所定手当」として別途加算
                      </div>
                    )}
                  </td>
                </tr>
              )
            })()}
            {w.legalLimit !== undefined && (
              <tr><td>本人別 法定上限</td><td className="font-mono">{fmtH(w.legalLimit)}（新ルール）</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ② 雇用区分 */}
      <section>
        <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">② 雇用区分・適用ルール</h3>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
          <div className="font-bold text-blue-900">{mode.label}</div>
          <div className="text-blue-700 mt-1">{mode.description}</div>
          <div className="text-blue-600 mt-1">
            ルール体系: <strong>{mode.useOldRules ? '旧ルール（〜2026/4）' : '新ルール（2026/5〜・法令準拠3層構造）'}</strong>
          </div>
        </div>
        <table className="w-full text-xs mt-2">
          <tbody className="[&_td]:py-1 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
            {w.rate > 0 && <tr><td>日額単価</td><td className="font-mono">{fmtYen(w.rate)}</td></tr>}
            {/* 旧ルール固定月給者(フン)の hourlyRate は計算に使われない旧値のため非表示 */}
            {w.hourlyRate && w.hourlyRate > 0 && !(mode.useOldRules && w.salary && w.salary > 0) &&
              <tr><td>時給単価</td><td className="font-mono">{fmtYen(w.hourlyRate)}</td></tr>}
            {w.salary && w.salary > 0 && <tr><td>月給</td><td className="font-mono">{fmtYen(w.salary)}</td></tr>}
            <tr><td>残業倍率 (otMul)</td><td className="font-mono">× {w.otMul}</td></tr>
            {w.isDispatched && (
              <tr><td>出向</td><td className="font-mono text-purple-700">{w.dispatchTo} へ出向中（控除 {fmtYen(w.dispatchDeduction || 0)}）</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ③ 出勤実績 */}
      <section>
        <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">③ 出勤実績の集計</h3>
        <table className="w-full text-xs">
          <tbody className="[&_td]:py-1 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
            <tr><td>出勤日数</td><td className="font-mono">{w.workDays}日 (うち補償0.6日 = {fmtNum(w.compDays, '日')})</td></tr>
            {w.actualWorkDays !== undefined && w.actualWorkDays !== w.workDays && (
              <tr><td>実出勤日数</td><td className="font-mono">{w.actualWorkDays}日（補償を含まない）</td></tr>
            )}
            <tr>
              <td>{mode.useOldRules ? '残業時間（合計）' : '時間外労働（合計）'}</td>
              <td className="font-mono">
                {mode.useOldRules ? (
                  <>
                    {fmtNum(w.otHours, 'h')}
                    <span className="text-[10px] text-gray-500 ml-1">（出面入力の残業欄合計）</span>
                  </>
                ) : (
                  <>
                    {/* 2026-07-09: 月次画面と表示を統一。所定外労働(7h超の実体)を主表示し、
                        法定外(割増対象)はその内数として添える。旧: 所定外+法定外の合算(実体のない数字)。 */}
                    {fmtNum(w.nonStatutoryOTHours || 0, 'h')}
                    <span className="text-[10px] text-gray-500 ml-1">（所定外労働。うち法定外(割増対象) {fmtNum(w.legalOtHours || 0, 'h')}。3層判定後の計算値。出面の残業欄 {fmtNum(w.otHours, 'h')} とは別）</span>
                  </>
                )}
              </td>
            </tr>
            {!mode.useOldRules && w.legalOtHours !== undefined && (
              <tr>
                <td>うち法定外残業</td>
                <td className="font-mono">
                  <span className="font-bold">{fmtNum(w.legalOtHours, 'h')}</span>
                  <span className="text-[10px] text-gray-500 ml-1">（3層判定後・基本1.0倍は所定外労働に含む。+0.25倍を法定外残業手当で支給）</span>
                </td>
              </tr>
            )}
            {!mode.useOldRules && (w.nonStatutoryOTHours || 0) > 0.05 && (
              <tr>
                <td>うち所定外労働</td>
                <td className="font-mono">
                  <span className="font-bold">{fmtNum(w.nonStatutoryOTHours, 'h')}</span>
                  <span className="text-[10px] text-gray-500 ml-1">（実労働 − 当日所定。法定内・1.0倍で全部支給）</span>
                </td>
              </tr>
            )}
            {w.actualWorkHours !== undefined && (
              <tr>
                <td>実労働時間（時間ベース）</td>
                <td className="font-mono">
                  {fmtNum(w.actualWorkHours, 'h')}
                  {w.legalLimit !== undefined && (
                    <span className="text-[10px] text-gray-500 ml-1">
                      / 法定上限 {fmtH(w.legalLimit)}（{(w.actualWorkHours || 0) <= w.legalLimit ? '✓ 範囲内' : '⚠️ 超過'}）
                    </span>
                  )}
                </td>
              </tr>
            )}
            <tr><td>有給日数</td><td className="font-mono">{w.plUsed || w.plDays || 0}日</td></tr>
            {(w.examDays || 0) > 0 && <tr><td>試験日</td><td className="font-mono">{w.examDays}日</td></tr>}
            <tr><td>欠勤日数</td><td className="font-mono">{w.absence || w.restDays || 0}日</td></tr>
            {(w.siteOffDays || 0) > 0 && <tr><td>現場休</td><td className="font-mono">{w.siteOffDays}日</td></tr>}
            {(w.legalHolidayHours || 0) > 0 && <tr><td>法定休日労働</td><td className="font-mono">{fmtNum(w.legalHolidayHours, 'h')}</td></tr>}
            {(w.nightHours || 0) > 0 && <tr><td>深夜労働</td><td className="font-mono">{fmtNum(w.nightHours, 'h')}</td></tr>}
          </tbody>
        </table>
      </section>

      {/* ④ 計算式 */}
      <section>
        <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">④ 給与計算（式と結果）</h3>
        <table className="w-full text-xs">
          <tbody className="[&_td]:py-1.5 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
            <tr>
              <td>基本給</td>
              <td className="font-mono">
                <div className="text-[10px] text-gray-500">{basePayFormula()}</div>
                <div className="font-bold text-base">{fmtYen(w.fixedBasePay || w.basePay || 0)}</div>
              </td>
            </tr>
            {(w.additionalAllowance || w.compAllowance || 0) > 0 && (
              <tr>
                <td>{mode.useOldRules ? '休業補償' : '追加所定手当 / 補償手当'}</td>
                <td className="font-mono">
                  <div className="text-[10px] text-gray-500">
                    {mode.useOldRules
                      ? '時給 × 6h40min × 0.6 × 補償日数'
                      : `時給 × 7h × MAX(0, 実出勤日数 − ベース日数20) = 追加出勤日 × 7h × 時給`}
                  </div>
                  <div className="font-bold">{fmtYen(w.additionalAllowance || w.compAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.paidLeaveAllowance || 0) > 0 && (
              <tr>
                <td>有給{w.fixedBasePay ? '日給' : '手当'}<br/><span className="text-[10px] text-gray-500">{w.fixedBasePay ? '(20日枠超の有給)' : '(有給×日額)'}</span></td>
                <td className="font-mono">
                  <div className="text-[10px] text-gray-500">
                    {w.fixedBasePay
                      ? `時給 ${fmtYen(w.hourlyRate || 0)} × 7h × ${fmtNum(w.paidLeaveDays, '日')}（基本給20日枠を超えた有給）`
                      : `日額 ${fmtYen(w.rate || 0)} × ${fmtNum(w.paidLeaveDays, '日')}（有給）`}
                  </div>
                  <div className="font-bold">{fmtYen(w.paidLeaveAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {!mode.useOldRules && (w.nonStatutoryOTAllowance || 0) > 0 && (
              <tr>
                <td>所定外労働手当<br/><span className="text-[10px] text-gray-500">(割増なし)</span></td>
                <td className="font-mono">
                  <div className="text-[10px] text-gray-500">
                    時給 {fmtYen(w.hourlyRate || 0)} × {fmtH(w.nonStatutoryOTHours)}（月所定超 − 法定外残業）
                  </div>
                  <div className="font-bold">{fmtYen(w.nonStatutoryOTAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.otAllowance || 0) > 0 && (
              <tr>
                <td>
                  {!mode.useOldRules && w.hourlyRate
                    ? <>法定外残業<br/><span className="text-[10px] text-gray-500">(割増のみ +0.25倍)</span></>
                    : '残業手当'}
                </td>
                <td className="font-mono">
                  <div className="text-[10px] text-gray-500">
                    {(() => {
                      const isVietnameseNewRules = !mode.useOldRules && w.hourlyRate
                      if (isVietnameseNewRules) {
                        return `時給 ${fmtYen(w.hourlyRate || 0)} × 0.25 × ${fmtH(w.legalOtHours)}（割増分のみ）`
                      }
                      const hUsed = w.otHours ?? 0
                      // 旧ルール固定月給(フン): 残業単価は日給ベースで固定（月給からの逆算ではない）
                      if (mode.useOldRules && w.salary && w.salary > 0 && w.rate > 0) {
                        const unit = Math.ceil(Math.round((w.rate / (20 / 3)) * w.otMul * 100) / 100)
                        return `残業単価 ${fmtYen(unit)}（= 切上(日額 ${fmtYen(w.rate)} ÷ 6.667h × ${w.otMul})・固定） × ${fmtH(hUsed)}`
                      }
                      if (w.hourlyRate) {
                        return `時給 ${fmtYen(w.hourlyRate)} × ${w.otMul} × ${fmtH(hUsed)}（残業時間）`
                      }
                      return `(日額 ${fmtYen(w.rate)} ÷ 8h) × ${w.otMul} × ${hUsed}h（残業時間）`
                    })()}
                  </div>
                  <div className="font-bold">{fmtYen(w.otAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.legalHolidayAllowance || 0) > 0 && (
              <tr>
                <td>法定休日労働手当 (1.35倍)</td>
                <td className="font-mono">
                  <div className="font-bold">{fmtYen(w.legalHolidayAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.nightAllowance || 0) > 0 && (
              <tr>
                <td>深夜労働手当 (0.25倍)</td>
                <td className="font-mono">
                  <div className="font-bold">{fmtYen(w.nightAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.absentDeduction || 0) > 0 && (
              <tr>
                <td>欠勤控除</td>
                <td className="font-mono text-red-600">
                  {mode.useOldRules && w.salary && w.salary > 0 && w.rate > 0 && (
                    <div className="text-[10px] text-gray-500">
                      日額 {fmtYen(w.rate)} × {fmtNum(w.absence, '日')}（欠勤・切捨）
                    </div>
                  )}
                  <div className="font-bold">- {fmtYen(w.absentDeduction || 0)}</div>
                </td>
              </tr>
            )}
            {mode.useOldRules && (w.compBaseDeduction || 0) > 0 && (
              <tr>
                <td>補償日 通常分控除<br/><span className="text-[10px] text-gray-500">(会社都合休: 固定給は満額前提のため一旦控除。60%は上の休業補償で還元 → 正味 日給の40%控除)</span></td>
                <td className="font-mono text-red-600">
                  <div className="text-[10px] text-gray-500">
                    {w.rate > 0
                      ? `日額 ${fmtYen(w.rate)} × ${fmtNum(w.compDays, '日')}（補償日・切捨）`
                      : `補償日 ${fmtNum(w.compDays, '日')} × 日給（切捨）`}
                  </div>
                  <div className="font-bold">- {fmtYen(w.compBaseDeduction || 0)}</div>
                </td>
              </tr>
            )}
            <tr className="border-t-2 border-hibi-navy">
              <td className="font-bold text-hibi-navy py-2">支給額</td>
              <td className="font-mono">
                <div className="font-bold text-base text-hibi-navy">{fmtYen(w.salaryNetPay || 0)}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ⑤ 監査チェック */}
      <section>
        <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1 flex items-center gap-2">
          ⑤ 監査チェック
          <span className={`text-xs px-2 py-0.5 rounded-full font-normal ${
            passingAudits === audits.length ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}>
            {passingAudits}/{audits.length} 項目
          </span>
        </h3>
        <div className="space-y-1.5">
          {audits.map((c, i) => (
            <div key={i} className={`p-2 rounded-lg text-xs ${c.pass ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-300'}`}>
              <div className="flex items-start gap-2">
                <span className={c.pass ? 'text-green-600' : 'text-red-600'}>
                  {c.pass ? '✓' : '❌'}
                </span>
                <div className="flex-1">
                  <div className={`font-bold ${c.pass ? 'text-green-800' : 'text-red-800'}`}>{c.label}</div>
                  <div className="text-[10px] mt-0.5 font-mono text-gray-600">{c.detail}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 説明・参照 */}
      <section className="bg-gray-50 rounded-lg p-3 text-[11px] text-gray-600">
        <div className="font-bold text-gray-800 mb-1">📋 注記</div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>本表示は監査・社労士確認用です。実際の支給額は「④ 支給額」の値となります</li>
          <li>計算ロジックの詳細は <code className="bg-white px-1 rounded">lib/compute.ts</code> の <code className="bg-white px-1 rounded">computeMonthly</code> 関数を参照</li>
          <li>1ヶ月単位変形労働時間制（労基法32条の2）に基づき法定上限を月単位で判定</li>
          <li>{mode.useOldRules ? '〜2026年4月: 旧ルール（月所定時間ベース）' : '2026年5月〜: 新ルール（calculateVietnameseSalary による3層構造、法令準拠）'}</li>
        </ul>
      </section>
    </div>
  )
}

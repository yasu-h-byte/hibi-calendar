/**
 * 給与計算根拠の透明化モーダル（2026-06-XX 追加）
 *
 * 給与計算の各ステップを「式と数字」で明示する監査用モーダル。
 * - 担当者が「ここおかしい」と気付きやすくする
 * - 監督署・社労士向け証跡として説明可能
 *
 * 設計方針:
 *   - 計算は表示しない（compute.ts で既に行われた値を可視化するだけ）
 *   - 各セクションは「根拠 = 式 = 結果」の形で表記
 *   - 監査チェック（不変条件）を末尾に並べて、視覚的に ✓ / ❌ 確認
 */
'use client'

import { jobShortLabel } from '@/lib/jobs'
import { fmtYen } from '@/lib/format'

interface WorkerMonthly {
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
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
  fixedBasePay?: number
  additionalAllowance?: number
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
}

interface Props {
  worker: WorkerMonthly
  ym: string
  prescribedDays: number
  baseDays: number
  onClose: () => void
}

// 雇用区分の判定（compute.ts のロジックと整合）
function getEmploymentMode(w: WorkerMonthly, ym: string): {
  label: string
  description: string
  useOldRules: boolean
} {
  const isJapanese = !w.visa || w.visa === 'none'
  const yearMonth = parseInt(ym.slice(0, 4)) * 100 + parseInt(ym.slice(4, 6))
  const isNewRules = yearMonth >= 202605  // 2026-05 以降が新ルール
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
  // 外国人
  if (w.salary && w.salary > 0) return {
    label: '月給制（外国人）',
    description: '基本給は月給固定、時給を月給から逆算して各種手当を計算',
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

// 1ヶ月単位変形労働時間制の法定上限を計算
function calcLegalMonthlyLimit(ym: string): number {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  return Math.round((daysInMonth * 40 / 7) * 10) / 10
}

// 数値表示（- なら表示しない）
function fmtNum(n: number | undefined | null, suffix = ''): string {
  if (n == null || n === 0) return '—'
  return `${Math.round(n * 10) / 10}${suffix}`
}

// 監査チェック項目
interface AuditCheck {
  label: string
  pass: boolean
  detail: string
}

function buildAuditChecks(w: WorkerMonthly, ym: string, prescribedDays: number): AuditCheck[] {
  const checks: AuditCheck[] = []
  const legalLimit = calcLegalMonthlyLimit(ym)

  // 1. 法定上限チェック
  const prescribedHours = w.prescribedHours || (prescribedDays * (w.visa === 'none' ? 8 : 7))
  checks.push({
    label: '所定労働時間が法定上限以内',
    pass: prescribedHours <= legalLimit,
    detail: `所定 ${prescribedHours}h ≦ 法定上限 ${legalLimit}h (= 暦日数 × 40 ÷ 7)`,
  })

  // 2. 出勤日数の整合性
  const daysAccountedFor = w.workDays + (w.plDays || 0) + (w.restDays || 0) + (w.siteOffDays || 0) + (w.examDays || 0)
  // 補償(0.6) は workDays に含まれるので別に加えない
  checks.push({
    label: '出勤実績の合計が所定日数以内',
    pass: daysAccountedFor <= prescribedDays + 1,  // 月によって1日のゆとり
    detail: `出勤${w.workDays} + 有給${w.plDays || 0} + 欠勤${w.restDays || 0} + 現場休${w.siteOffDays || 0} + 試験${w.examDays || 0} = ${daysAccountedFor}日 ≦ 所定${prescribedDays}日`,
  })

  // 3. 支給額の内訳整合
  const fixedBase = w.fixedBasePay || w.basePay || 0
  const sumPay = fixedBase
    + (w.additionalAllowance || w.compAllowance || 0)
    + (w.otAllowance || 0)
    + (w.legalHolidayAllowance || 0)
    + (w.nightAllowance || 0)
    - (w.absentDeduction || 0)
  const reported = w.salaryNetPay || 0
  checks.push({
    label: '支給額の内訳合計が一致',
    pass: Math.abs(sumPay - reported) < 2,  // 丸め誤差 ±1円許容
    detail: `基本 ${fmtYen(fixedBase)} + 追加 ${fmtYen(w.additionalAllowance || w.compAllowance || 0)} + 残業 ${fmtYen(w.otAllowance || 0)} + 法定休日 ${fmtYen(w.legalHolidayAllowance || 0)} + 深夜 ${fmtYen(w.nightAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`,
  })

  // 4. otMul の妥当性
  checks.push({
    label: '残業倍率が法定下限以上',
    pass: w.otMul >= 1.25,
    detail: `otMul = ${w.otMul} ≧ 1.25 (労基法37条)`,
  })

  return checks
}

export default function PayrollAuditModal({ worker: w, ym, prescribedDays, baseDays, onClose }: Props) {
  const mode = getEmploymentMode(w, ym)
  const legalLimit = calcLegalMonthlyLimit(ym)
  const audits = buildAuditChecks(w, ym, prescribedDays)
  const passingAudits = audits.filter(a => a.pass).length

  const orgName = w.org === 'hfu' ? 'HFU' : '日比建設'
  const yearStr = `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月`
  const daysInMonth = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)), 0).getDate()

  // 基本給の式表示用
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
    // 時給制外国人
    if (mode.useOldRules) {
      return `時給 ${fmtYen(w.hourlyRate || 0)} × 月所定時間 ${w.prescribedHours || 0}h = ${fmtYen(w.basePay || 0)}`
    }
    return `時給 ${fmtYen(w.hourlyRate || 0)} × ${baseDays}日 × 7h = ${fmtYen(w.fixedBasePay || w.basePay || 0)}`
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-2 flex items-start sm:items-center justify-center overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl my-4 flex flex-col max-h-[95vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="bg-hibi-navy text-white px-5 py-4 rounded-t-xl flex items-center justify-between">
          <div>
            <div className="font-bold text-lg leading-tight flex items-center gap-2">
              🔍 給与計算の根拠
              <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-normal">{yearStr}</span>
            </div>
            <div className="text-sm opacity-80 mt-0.5">
              {w.name} ({orgName} / {jobShortLabel(w.job)}) — ID:{w.id}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-sm">

          {/* ① 月情報 */}
          <section>
            <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-200 pb-1">① 月情報</h3>
            <table className="w-full text-xs">
              <tbody className="[&_td]:py-1 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
                <tr><td>暦日数</td><td className="font-mono">{daysInMonth}日</td></tr>
                <tr><td>法定上限（月）</td><td className="font-mono">{daysInMonth} × 40 ÷ 7 = <strong>{legalLimit}h</strong></td></tr>
                <tr><td>所定日数</td><td className="font-mono">{prescribedDays}日（就業カレンダーから算出）</td></tr>
                {w.legalLimit !== undefined && (
                  <tr><td>本人別 法定上限</td><td className="font-mono">{w.legalLimit}h（新ルール）</td></tr>
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
                {w.hourlyRate && w.hourlyRate > 0 && <tr><td>時給単価</td><td className="font-mono">{fmtYen(w.hourlyRate)}</td></tr>}
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
                <tr><td>残業時間（合計）</td><td className="font-mono">{fmtNum(w.otHours, 'h')}</td></tr>
                {w.actualWorkHours !== undefined && (
                  <tr><td>実労働時間（時間ベース）</td><td className="font-mono">{fmtNum(w.actualWorkHours, 'h')}</td></tr>
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
                      <div className="font-bold">{fmtYen(w.additionalAllowance || w.compAllowance || 0)}</div>
                    </td>
                  </tr>
                )}
                {(w.otAllowance || 0) > 0 && (
                  <tr>
                    <td>残業手当</td>
                    <td className="font-mono">
                      <div className="text-[10px] text-gray-500">
                        {w.hourlyRate ? `時給 ${fmtYen(w.hourlyRate)} × ${w.otMul} × ${w.otHours}h` :
                          `(日額 ${fmtYen(w.rate)} ÷ 8h) × ${w.otMul} × ${w.otHours}h`}
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
                      <div className="font-bold">- {fmtYen(w.absentDeduction || 0)}</div>
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

        {/* フッター */}
        <div className="border-t border-gray-200 px-5 py-3 bg-gray-50 rounded-b-xl flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:bg-[#243656]"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

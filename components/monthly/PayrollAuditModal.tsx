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
import { validatePayroll, type PayrollSnapshot } from '@/lib/payroll-validator'

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
  // 2026-06-XX 追加: 所定外労働手当（法定内・割増なし、新ルール時のみ）
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
  // 2026-06-XX 修正: 人員マスタの useOldRules フラグも考慮
  //   compute.ts L977 と同じ判定式: `ym >= '202605' && !workerWm?.useOldRules`
  //   個別に新ルール移行を拒否したケース（例: フン 104）は 5月以降も旧ルール継続
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
  // mode は買い直し（getEmploymentMode の戻り値を再利用）
  const mode = getEmploymentMode(w, ym)

  // 1. 法定上限チェック
  // 2026-06-XX 修正: フォールバック時の所定時間を 7h/日 に統一
  //   理由: 当社の1ヶ月単位変形労働時間制では全スタッフ 7h/日 が標準（lib/compute.ts L1379 参照）
  //   旧: 日本人 8h, 外国人 7h で食い違っていた（×8 だと 22日×8=176h で法定上限 171h を超えて誤判定）
  const prescribedHours = w.prescribedHours || (prescribedDays * 7)
  checks.push({
    label: '所定労働時間が法定上限以内',
    pass: prescribedHours <= legalLimit,
    detail: `所定 ${prescribedHours}h ≦ 法定上限 ${legalLimit}h (= 暦日数 × 40 ÷ 7)`,
  })

  // 2. 出勤日数の整合性
  // 2026-06-XX 修正 (M-3): compDays も加算 (補償日も出勤実績の一部としてカウント)
  const daysAccountedFor = w.workDays + (w.plDays || 0) + (w.restDays || 0) + (w.siteOffDays || 0) + (w.examDays || 0) + (w.compDays || 0)
  checks.push({
    label: '出勤実績の合計が所定日数以内',
    pass: daysAccountedFor <= prescribedDays + 1,  // 月によって1日のゆとり
    detail: `出勤${w.workDays} + 有給${w.plDays || 0} + 欠勤${w.restDays || 0} + 現場休${w.siteOffDays || 0} + 試験${w.examDays || 0} + 補償${w.compDays || 0} = ${daysAccountedFor}日 ≦ 所定${prescribedDays}日`,
  })

  // 3. 支給額の内訳整合
  // 2026-06-XX 修正 (I-1): 旧式は (additionalAllowance || compAllowance) の OR 結合で
  //   両方非ゼロの場合 compAllowance が消えていた。新ルールでは別項目として加算。
  //   nonStatutoryOTAllowance (所定外労働手当) も追加。
  const fixedBase = w.fixedBasePay || w.basePay || 0
  let sumPay: number
  if (mode.useOldRules) {
    // 旧ルール: additionalAllowance フィールドが休業補償として流用されている
    sumPay = fixedBase
      + (w.additionalAllowance || 0)  // 旧ルールでは = 休業補償
      + (w.otAllowance || 0)
      - (w.absentDeduction || 0)
  } else {
    // 新ルール: 各項目を独立加算
    sumPay = fixedBase
      + (w.additionalAllowance || 0)
      + (w.nonStatutoryOTAllowance || 0)  // 2026-06-XX 追加
      + (w.otAllowance || 0)
      + (w.legalHolidayAllowance || 0)
      + (w.nightAllowance || 0)
      + (w.compAllowance || 0)
      - (w.absentDeduction || 0)
  }
  const reported = w.salaryNetPay || 0
  checks.push({
    label: '支給額の内訳合計が一致',
    pass: Math.abs(sumPay - reported) < 2,  // 丸め誤差 ±1円許容
    detail: mode.useOldRules
      ? `基本 ${fmtYen(fixedBase)} + 休業補償 ${fmtYen(w.additionalAllowance || 0)} + 残業 ${fmtYen(w.otAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`
      : `基本 ${fmtYen(fixedBase)} + 追加所定 ${fmtYen(w.additionalAllowance || 0)} + 所定外労働 ${fmtYen(w.nonStatutoryOTAllowance || 0)} + 法定外残業 ${fmtYen(w.otAllowance || 0)} + 法定休日 ${fmtYen(w.legalHolidayAllowance || 0)} + 深夜 ${fmtYen(w.nightAllowance || 0)} + 休業 ${fmtYen(w.compAllowance || 0)} - 欠勤 ${fmtYen(w.absentDeduction || 0)} = ${fmtYen(sumPay)} （内訳合計）／ ${fmtYen(reported)} （支給額）`,
  })

  // 4. otMul の妥当性
  checks.push({
    label: '残業倍率が法定下限以上',
    pass: w.otMul >= 1.25,
    detail: `otMul = ${w.otMul} ≧ 1.25 (労基法37条)`,
  })

  // 5. 自動検算: lib/payroll-validator.ts (2026-06-XX 追加)
  //   各支給コンポーネントが労基法・実労働時間に対して妥当な範囲にあるかを検証
  //   過去バグ3種（残業二重支給・所定外労働漏れ・式表示不一致）を自動検出
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
                {/*
                  2026-06-XX 修正: 表示する所定日数を「実計算で使われた値」に変更。
                    旧: 常に prop の prescribedDays (= 全社カレンダー値) を表示
                    新: w.prescribedHours から逆算 (旧ルール=÷6.667, 新ルール=÷7)
                    理由: 過去バグで「画面表示23日／実計算20日」のズレが発生。
                          実計算ベースに統一することで再発防止。
                  フォールバック: w.prescribedHours が無ければ prop を使用
                */}
                {(() => {
                  // 旧ルール: 1日 20/3h, 新ルール: 1日 7h
                  const dailyH = mode.useOldRules ? (20 / 3) : 7
                  const computedDays = w.prescribedHours
                    ? Math.round(w.prescribedHours / dailyH)
                    : prescribedDays
                  const source = mode.useOldRules
                    ? '全社所定（日曜・祝日除く）'
                    : '配置現場の就業カレンダー'
                  const mismatch = w.prescribedHours && computedDays !== prescribedDays
                  return (
                    <tr>
                      <td>所定日数</td>
                      <td className="font-mono">
                        <strong>{computedDays}日</strong>
                        <span className="text-gray-500 ml-1">（{source}）</span>
                        {mismatch ? (
                          <div className="text-[10px] text-amber-600 mt-0.5">
                            ⚠ 全社設定は {prescribedDays}日 ですが、このスタッフの計算では {computedDays}日 が採用されました
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )
                })()}
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
                <tr>
                  <td>残業時間（合計）</td>
                  <td className="font-mono">
                    {fmtNum(w.otHours, 'h')}
                    <span className="text-[10px] text-gray-500 ml-1">（出面入力の残業欄合計）</span>
                  </td>
                </tr>
                {/* 2026-06-XX 追加: 残業時間の内訳を明示 */}
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
                      <span className="text-[10px] text-gray-500 ml-1">（残業欄入力分の合計。1.0倍で全部支給）</span>
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
                          / 法定上限 {w.legalLimit}h（{(w.actualWorkHours || 0) <= w.legalLimit ? '✓ 範囲内' : '⚠️ 超過'}）
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
                {/* 2026-06-XX 追加: 所定外労働手当（法定内・割増なし） */}
                {!mode.useOldRules && (w.nonStatutoryOTAllowance || 0) > 0 && (
                  <tr>
                    <td>所定外労働手当<br/><span className="text-[10px] text-gray-500">(割増なし)</span></td>
                    <td className="font-mono">
                      <div className="text-[10px] text-gray-500">
                        時給 {fmtYen(w.hourlyRate || 0)} × {w.nonStatutoryOTHours || 0}h（月所定超 − 法定外残業）
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
                      {/* 2025-06-XX 修正: 新ルール外国人は「割増分のみ 0.25倍」で支給
                          - 基本給/追加所定/所定外労働 で全労働の 1.0倍 を支払い済み
                          - 法定外残業手当 = 0.25倍 (60h超は 0.5倍)
                          - 合算で 1.25倍 (= 1.0倍 base + 0.25倍 premium) になる
                          - 旧ルール・日本人は従来通り 1.25倍 (base 含む) */}
                      <div className="text-[10px] text-gray-500">
                        {(() => {
                          const isVietnameseNewRules = !mode.useOldRules && w.hourlyRate
                          if (isVietnameseNewRules) {
                            return `時給 ${fmtYen(w.hourlyRate || 0)} × 0.25 × ${w.legalOtHours ?? 0}h（割増分のみ）`
                          }
                          const hUsed = w.otHours ?? 0
                          if (w.hourlyRate) {
                            return `時給 ${fmtYen(w.hourlyRate)} × ${w.otMul} × ${hUsed}h（残業時間）`
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
              {!mode.useOldRules && (
                <li className="text-gray-700">
                  <strong>変形労働時間制 + 月給制の支払い構造:</strong>
                  <br />・基本給は <strong>月所定時間（ベース日数20×7h=140h）</strong>のみをカバー。有給日もこの枠内。
                  <br />・残業欄の入力時間（出面の「o」欄）は、<strong>全て基本給とは別に支給</strong>される。
                  <br />・うち法定外残業（3層判定）= <strong>1.25倍</strong>（労基法37条）
                  <br />・うち所定外労働（法定内）= <strong>通常賃金</strong>（労基法24条 賃金全額払い）
                </li>
              )}
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

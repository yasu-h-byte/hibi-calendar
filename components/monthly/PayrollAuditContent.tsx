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
import { JP_SALARY_AVG_MONTHLY_HOURS, JP_AVG_MONTHLY_WORK_DAYS } from '@/lib/constants'
// 型・区分判定・監査チェックは lib/payroll-validator.ts へ移した（2026-10-02 総合点検）。
//   理由: .tsx に置くとテストから読めず（tsconfig の jsx: preserve）、監査チェックの誤検知（10月の全社所定27日で
//   日本人・旧ルールが全員 ❌ になった件）が機械的に防げなかった。画面側は再輸出だけ残す
import {
  getEmploymentMode, calcLegalMonthlyLimit, fmtNum, fmtH, buildAuditChecks,
  type PayrollAuditWorker, type AuditCheck,
} from '@/lib/payroll-validator'
export { getEmploymentMode, calcLegalMonthlyLimit, fmtNum, fmtH, buildAuditChecks, type PayrollAuditWorker, type AuditCheck }

interface Props {
  worker: PayrollAuditWorker
  ym: string
  prescribedDays: number
  baseDays: number
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
      // 月途中の入社・退職は暦日按分（基本給が月給より少ない月）
      return (w.basePay || 0) < (w.salary || 0)
        ? `月給 ${fmtYen(w.salary || 0)} を在籍日数で日割り（暦日比・切上） = ${fmtYen(w.basePay || 0)}`
        : `月給固定 ${fmtYen(w.salary || 0)}`
    }
    if (mode.label.startsWith('日給制（日本人）')) {
      // 2026-10-02 総合点検: 人工（夜勤 1.5／日勤＋夜勤 2.5）と、8〜9月分だけ別枠にした日曜の人工を式に出す。
      //   旧: 「日額 × 出勤日数」だけだったので、夜勤や日曜のある月は式の値が基本給と合わなかった
      const man = w.manDays ?? w.workDays
      const lh = w.legalHolidayManDays || 0
      const payMan = Math.max(0, Math.round((man - lh) * 100) / 100)
      const parts: string[] = [`日額 ${fmtYen(w.rate)} × 人工 ${payMan}`]
      const notes: string[] = []
      if ((w.nightShiftDays || 0) > 0) notes.push(`夜勤 ${w.nightShiftDays}回 = ${w.nightManDays}人工 を含む`)
      if (lh > 0) notes.push(`日曜の ${lh}人工 は法定休日手当で別枠`)
      if (notes.length > 0) parts.push(`（出勤 ${w.workDays}日。${notes.join('・')}）`)
      return `${parts.join('')} = ${fmtYen(w.basePay || 0)}`
    }
    if (mode.label.startsWith('月給制（外国人）')) {
      return (w.basePay || 0) < (w.salary || 0)
        ? `月給 ${fmtYen(w.salary || 0)} を在籍日数で日割り（暦日比・切上） = ${fmtYen(w.basePay || 0)}`
        : `月給固定 ${fmtYen(w.salary || 0)}`
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
                      <div className="text-3xs text-gray-500 mt-0.5">
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
            {(w.hourlyRate ?? 0) > 0 && !(mode.useOldRules && (w.salary ?? 0) > 0) &&
              <tr><td>時給単価</td><td className="font-mono">{fmtYen(w.hourlyRate ?? 0)}</td></tr>}
            {(w.salary ?? 0) > 0 && <tr><td>月給</td><td className="font-mono">{fmtYen(w.salary ?? 0)}</td></tr>}
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
                    <span className="text-3xs text-gray-500 ml-1">（出面入力の残業欄合計）</span>
                  </>
                ) : (
                  <>
                    {/* 2026-07-09: 月次画面と表示を統一。所定外労働(7h超の実体)を主表示し、
                        法定外(割増対象)はその内数として添える。旧: 所定外+法定外の合算(実体のない数字)。 */}
                    {fmtNum(w.nonStatutoryOTHours || 0, 'h')}
                    <span className="text-3xs text-gray-500 ml-1">（所定外労働。うち法定外(割増対象) {fmtNum(w.legalOtHours || 0, 'h')}。3層判定後の計算値。出面の残業欄 {fmtNum(w.otHours, 'h')} とは別）</span>
                  </>
                )}
              </td>
            </tr>
            {!mode.useOldRules && w.legalOtHours !== undefined && (
              <tr>
                <td>うち法定外残業</td>
                <td className="font-mono">
                  <span className="font-bold">{fmtNum(w.legalOtHours, 'h')}</span>
                  <span className="text-3xs text-gray-500 ml-1">（3層判定後・基本1.0倍は所定外労働に含む。+0.25倍を法定外残業手当で支給）</span>
                </td>
              </tr>
            )}
            {!mode.useOldRules && (w.nonStatutoryOTHours || 0) > 0.05 && (
              <tr>
                <td>うち所定外労働</td>
                <td className="font-mono">
                  <span className="font-bold">{fmtNum(w.nonStatutoryOTHours, 'h')}</span>
                  <span className="text-3xs text-gray-500 ml-1">（実労働 − 当日所定。法定内・1.0倍で全部支給）</span>
                </td>
              </tr>
            )}
            {w.actualWorkHours !== undefined && (
              <tr>
                <td>実労働時間（時間ベース）</td>
                <td className="font-mono">
                  {fmtNum(w.actualWorkHours, 'h')}
                  {w.legalLimit !== undefined && (
                    <span className="text-3xs text-gray-500 ml-1">
                      / 法定上限 {fmtH(w.legalLimit)}（{(w.actualWorkHours || 0) <= w.legalLimit ? '✓ 範囲内' : '⚠️ 超過'}）
                    </span>
                  )}
                </td>
              </tr>
            )}
            <tr><td>有給日数</td><td className="font-mono">{w.plUsed || w.plDays || 0}日</td></tr>
            {(w.examDays || 0) > 0 && <tr><td>試験日</td><td className="font-mono">{w.examDays}日</td></tr>}
            <tr><td>欠勤日数</td><td className="font-mono">{w.absence || 0}日{(w.restDays || 0) > 0 && <span className="text-3xs text-gray-500 ml-1">（出面の「欠」{w.restDays}日）</span>}</td></tr>
            {/* 最低20日保証（2026-09-13）・本人の欠勤（案A・2026年9月分〜）・枠内補償日（2026年8月分〜）。2026-10-02 総合点検で表示に追加 */}
            {w.guaranteeDays !== undefined && (
              <tr>
                <td>最低保証（欠勤控除の基準）</td>
                <td className="font-mono">
                  保証枠 {w.guaranteeDays}日
                  {w.personalAbsenceDays !== undefined && <> − 本人の欠勤 {w.personalAbsenceDays}日 = 保証日数 <strong>{Math.max(0, w.guaranteeDays - Math.min(w.personalAbsenceDays, w.guaranteeDays))}日</strong></>}
                  <div className="text-3xs text-gray-500">
                    保証枠 = min(20日, 配置現場カレンダーの所定日数{(w.hkDays || 0) > 0 ? '・帰国中を除いて日割り' : ''})。
                    欠勤日数 = min(本人の欠勤 ＋ max(0, 保証日数 − 算入日数), 20 − 算入日数)。算入日数 = 出勤 ＋ 有給 ＋ 試験 ＋ 枠内の補償日
                    {(w.compInGuaranteeDays || 0) > 0 && <>。補償日 {w.compDays}日のうち 枠内 {w.compInGuaranteeDays}日 は100%支給（休業手当60%の対象外）</>}
                  </div>
                </td>
              </tr>
            )}
            {(w.hkDays || 0) > 0 && <tr><td>帰国中</td><td className="font-mono">{w.hkDays}日<span className="text-3xs text-gray-500 ml-1">（在籍日数から除外・無給・欠勤に数えない。基本給・所定日数を暦日比で日割り）</span></td></tr>}
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
                <div className="text-3xs text-gray-500">{basePayFormula()}</div>
                <div className="font-bold text-base">{fmtYen(w.fixedBasePay || w.basePay || 0)}</div>
              </td>
            </tr>
            {/* 2026-10-02 総合点検: 追加所定手当と休業手当を別の行にする。
                旧: 1行で `additionalAllowance || compAllowance` を出していたため、両方ある人（出勤21日＋現場都合休2日など）は
                休業手当の行が消え、休業手当だけの人には追加所定の式が付いていた */}
            {(w.additionalAllowance || 0) > 0 && (
              <tr>
                <td>{mode.useOldRules ? '休業補償' : '追加所定手当'}</td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
                    {mode.useOldRules
                      ? `日給（時給 × 1日所定）× 0.6 × 補償日 ${fmtNum(w.compDays, '日')}`
                      : `時給 ${fmtYen(w.hourlyRate || 0)} × 7h × MAX(0, 出勤${w.regularWorkDays ?? w.actualWorkDays}＋試験${w.examDays || 0} − ベース日数${baseDays}）`}
                  </div>
                  <div className="font-bold">{fmtYen(w.additionalAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {!mode.useOldRules && (w.compAllowance || 0) > 0 && (
              <tr>
                <td>休業手当<br/><span className="text-3xs text-gray-500">(現場都合休 60%・労基法26条)</span></td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
                    時給 {fmtYen(w.hourlyRate || 0)} × 7h × 0.6 × {fmtNum((w.compDays || 0) - (w.compInGuaranteeDays || 0), '日')}
                    {(w.compInGuaranteeDays || 0) > 0 && <>（補償日 {w.compDays}日 − 保証枠内で100%支給の {w.compInGuaranteeDays}日）</>}
                  </div>
                  <div className="font-bold">{fmtYen(w.compAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.paidLeaveAllowance || 0) > 0 && (
              <tr>
                <td>有給{w.fixedBasePay ? '日給' : '手当'}<br/><span className="text-3xs text-gray-500">{w.fixedBasePay ? '(20日枠超の有給)' : '(有給×日額)'}</span></td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
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
                <td>所定外労働手当<br/><span className="text-3xs text-gray-500">(割増なし)</span></td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
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
                    ? <>法定外残業<br/><span className="text-3xs text-gray-500">(割増のみ +0.25倍)</span></>
                    : '残業手当'}
                </td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
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
                <td>法定休日労働手当 (1.35倍・8h超は1.60倍)</td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
                    {w.visa === 'none'
                      ? `時給換算（${(w.salary || 0) > 0 ? `月給 ÷ ${JP_SALARY_AVG_MONTHLY_HOURS}h` : '日額 ÷ 8h'}）× (1.35 × 8h以下 ＋ 1.60 × 8h超) × 日曜 ${fmtNum(w.legalHolidayDays, '日')} ${fmtH(w.legalHolidayHours)}（日ごとに8hの線を引く・8〜9月分だけ）`
                      : `時給 ${fmtYen(w.hourlyRate || 0)} × (1.35 × 8h以下 ＋ 1.60 × 8h超) × 日曜 ${fmtH(w.legalHolidayHours)}`}
                  </div>
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
            {(w.breakShortenAllowance || 0) > 0 && (
              <tr>
                <td>休憩短縮手当 <span className="text-3xs text-gray-500">(所定外・法定内のため割増なし)</span></td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">
                    {fmtNum(w.breakShortenHours || 0)}h（出勤日 × 短縮分）× 通常時給
                  </div>
                  <div className="font-bold">{fmtYen(w.breakShortenAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.siteAllowance || 0) > 0 && (
              <tr>
                <td>遠方現場日当 <span className="text-3xs text-gray-500">(非課税・実費弁償)</span></td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">対象 {w.allowanceDays || 0}日（判定値80分超500円/120分超1,500円・長期従事は逓減。2026-10 現在は保留中）</div>
                  <div className="font-bold">{fmtYen(w.siteAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.driveAllowance || 0) > 0 && (
              <tr>
                <td>運転手当</td>
                <td className="font-mono">
                  <div className="text-3xs text-gray-500">{w.driveLegs || 0}便 × 片道1,000円（同乗者を乗せた便だけ・「運転手当なし」の現場は除く）</div>
                  <div className="font-bold">{fmtYen(w.driveAllowance || 0)}</div>
                </td>
              </tr>
            )}
            {(w.absentDeduction || 0) > 0 && (
              <tr>
                <td>欠勤控除</td>
                <td className="font-mono text-red-600">
                  {mode.useOldRules && w.salary && w.salary > 0 && w.rate > 0 && (
                    <div className="text-3xs text-gray-500">
                      日額 {fmtYen(w.rate)} × {fmtNum(w.absence, '日')}（欠勤・切捨）
                    </div>
                  )}
                  {!mode.useOldRules && w.visa !== 'none' && (
                    <div className="text-3xs text-gray-500">
                      時給 {fmtYen(w.hourlyRate || 0)} × 7h × {fmtNum(w.absence, '日')}（欠勤日数は③の最低保証の式・切捨）
                    </div>
                  )}
                  {w.visa === 'none' && (w.salary || 0) > 0 && (
                    <div className="text-3xs text-gray-500">
                      基本給 ÷ {JP_AVG_MONTHLY_WORK_DAYS.toFixed(2)}日（年250日÷12）× {fmtNum(w.absence, '日')}（出面の「欠」＋出勤日の不足分・切捨・基本給が上限）
                    </div>
                  )}
                  <div className="font-bold">- {fmtYen(w.absentDeduction || 0)}</div>
                </td>
              </tr>
            )}
            {mode.useOldRules && (w.compBaseDeduction || 0) > 0 && (
              <tr>
                <td>補償日 通常分控除<br/><span className="text-3xs text-gray-500">(会社都合休: 固定給は満額前提のため一旦控除。60%は上の休業補償で還元 → 正味 日給の40%控除)</span></td>
                <td className="font-mono text-red-600">
                  <div className="text-3xs text-gray-500">
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

      {/* 注意点（支給額は変えない・2026-10-02 総合点検・2026年9月分〜）。給与チェックの warning と同じ文 */}
      {(w.payNotes?.length || 0) > 0 && (
        <section>
          <h3 className="font-bold text-amber-800 mb-2 border-b border-amber-200 pb-1">⚠ 注意点（支給額には入れていません・締める前に確認）</h3>
          <ul className="space-y-1.5">
            {w.payNotes!.map((n, i) => (
              <li key={i} className="p-2 rounded-lg text-xs bg-amber-50 border border-amber-300 text-amber-900">{n.message}</li>
            ))}
          </ul>
        </section>
      )}

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
                  <div className="text-3xs mt-0.5 font-mono text-gray-600">{c.detail}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 説明・参照 */}
      <section className="bg-gray-50 rounded-lg p-3 text-2xs text-gray-600">
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

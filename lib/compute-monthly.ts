/**
 * 月次集計（computeMonthly）— 月次集計ページ・帳票・原価・ダッシュボードの検算で共用（2026-10-21 総点検で lib/compute.ts から分離）。
 * compute() の結果を使いつつ、ワーカー別の支給額・注意点（PayNote）・外注・現場別に整形する。
 * 計算の中身は分離前と 1 行も変えていない（golden master: __tests__/goldenSynthetic.test.ts）。
 */
import { JP_PRESCRIBED_HOURS_PER_DAY, JP_SALARY_AVG_MONTHLY_HOURS, JP_WEEK_OVER40_NOTE_FROM_YM, MainData, OLD_RULE_BELOW_WORKED_DAYS_NOTE_FROM_YM, PAYROLL_RULES, RawSite, ceilYen, countHomeLeaveDaysInRange, createDispatchChecker, floorYen, getSubconRate, getWorkerDailyRate, isDispatchedAt, jpSundayPremiumApplies, parseDKey, parseSdKey } from './compute'
import { AttendanceEntry, NIGHT_SHIFT_MANDAYS, calcActualHours, calcDayShiftHours, calcManDays, calcNightShiftHours, calcOvertimeHours, getNightRange, timeToMinutes, type SiteWorkSchedule } from '@/types'
import { type HomeLeaveEntry } from './homeLeave'
import { type WorkerAllowanceMonthly } from './allowance'
import { withWorkTypeSiteCalendars } from './site-hierarchy'
import { effectiveHourlyRateForYm, effectiveRateForYm, effectiveSalaryForYm, isHiredByMonth, isStillActiveForMonth } from './workers'
import { isSuspectCompanyRest } from './attendance-confirm'
import { type VietnameseSalaryResult, calcLegalHolidayAllowance, calcNightMinutes, calcNightShiftLegalRequiredPay, calculateVietnameseSalary } from './compute-vn-salary'
import { detectRestMismatches } from './rest-mismatch'
import { isWorkingDay } from './attendance'
import { todayJstIso } from '@/lib/date-utils'
import { JP_AVG_MONTHLY_WORK_DAYS, JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM } from './constants'
import { LEAVE_SETTLE_FROM_YM, LEAVE_SETTLE_LABEL, LEAVE_SETTLE_MONTH_CAP_DAYS, isLeaveSettleEligible, settledDaysForYm } from './leave-settle'



// ────────────────────────────────────────
//  月次集計（computeMonthly）— 月次集計ページ用
//  compute()の結果を使いつつ、ワーカー別の詳細表示に整形
// ────────────────────────────────────────

/**
 * 給与チェックの注意点（2026-10-02 総合点検）。**支給額は変えない。**
 *
 * 賃金の決まりを変えずに「このままだと不足払い・取り違えになり得る」ことを、締める前に森田さんが
 * 月次集計の帯（給与チェック＝lib/payroll-validator.ts が warning として出す）と計算根拠で気づけるようにする。
 * 過去の締め済み月の見え方を変えないため、PAY_NOTES_FROM_YM（2026年9月分）より前の月には付けない。
 */
export interface PayNote {
  code: 'belowWorkedDays' | 'jpWeekOver40' | 'crossSiteCalendar' | 'midMonthRateOt' | 'blankDays' | 'oldRuleExtraWork' | 'jpMonthlyOffDayWork' | 'leaveSettleOverCap' | 'leaveSettleNotDaily'
  message: string
  /** 目安の金額（円）。無い注意点もある */
  amount?: number
}
export const PAY_NOTES_FROM_YM = '202609'

export interface WorkerMonthly {
  id: number
  name: string
  org: string
  visa: string
  job: string
  rate: number
  hourlyRate?: number
  otMul: number
  salary?: number
  // 2026-06-XX 追加: 旧ルール継続フラグ（人員マスタの個別設定）
  //   下流（PayrollAuditModal / Excel出力）で表示分岐するために必要
  useOldRules?: boolean
  /** キャシュモ管理の従業員番号（提出用Excel/PDFに載せる） */
  payrollNo?: string
  sites: string[]
  workDays: number
  actualWorkDays: number
  compDays: number
  workAll: number
  halfDays?: number
  otHours: number
  // ── 夜勤（2026-08 追加）──
  //   workDays は「出勤日数」のまま維持し（欠勤判定 = 所定日数 − workDays が壊れるため）、
  //   人工は manDays に分離して持つ。夜勤が無い月は manDays === workDays。
  manDays?: number          // 人工数（夜勤のみ 1.5 / 日勤＋夜勤 2.5）。支給・元請け請求の基礎
  nightShiftDays?: number   // 夜勤の回数
  nightManDays?: number     // 夜勤ぶんの人工（回数 × 1.5）
  nightShiftHours?: number  // 夜勤ブロックの実労働時間 合計
  legalRequiredPay?: number // 夜勤日の法定最低支給額 合計（1.5人工が法令を満たすかの判定用）
  nightShiftPaid?: number   // 夜勤日に実際に支払う額 合計（人工 × 日額 ＋ 残業手当）
  legalShortfall?: number   // 法定必要額 − 実支給額（プラスなら不足 = 要是正）
  lateNightRiskDays?: number // 残業hから逆算すると22時を超えるが夜勤登録が無い日数（運用ルール違反の検出）
  sundayNoRestDays?: number[] // 日本人: 前の6日すべて出勤した日曜（その週に休みが無い＝法定休日の割増が必要になり得る）。2026-10〜の警告用
  // 2026-09-13 追加: 保証枠（欠勤控除の基準日数）= min(基本給ベース20日, 配置現場カレンダーの所定日数)。
  //   閑散期でカレンダーの稼働日が20日未満の月は、全日出勤なら欠勤控除ゼロ＝基本給20日分を保証する（月給制）。
  guaranteeDays?: number
  // 2026-09-15: 保証枠の中で100%支給にした補償日数（休業手当60%の対象外）
  compInGuaranteeDays?: number
  // 2026-09-13 追加: 配置現場カレンダーの稼働日なのに出面が何も無い日数（出勤・0.6・欠・有給・帰国のいずれも無し）。
  //   入力漏れがそのまま100%控除になる事故の検出用（0.6補償の入れ忘れ等）。計算には影響しない
  calendarBlankDays?: number
  _entryDaySeen?: Set<string>
  plDays: number
  plUsed: number
  /** 「欠」の日数（同じ日の2現場は1日・2026-10-02） */
  restDays: number
  _restDaySeen?: Set<string>
  /** 保証から引く本人の欠勤（カレンダーの仕事の日に「欠」の日数・2026-09-30） */
  personalAbsenceDays?: number
  _absenceDaySeen?: Set<string>
  /** 「その他」の休みでメモが会社都合を指している日（0.6補の選び間違いの疑い・2026-09-30）。計算は変えない */
  suspectCompRestDays?: number[]
  /** 自分の都合の休みなのに、同じ日・同じ現場でほかの人が現場休み（0.6補）だった日（取り違えの疑い・lib/rest-mismatch.ts・2026-09-30） */
  restMismatchDays?: number[]
  siteOffDays: number
  examDays: number     // 試験日数（給与計算では欠勤控除対象から除外、原価には計上しない）
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  // 2026-06-XX 追加 (C8): 同一日複数現場の actualWorkDays 重複排除用
  //   内部利用のみ。集計後の表示には使わない（リファクタ時に削除可）
  _actualDaySeen?: Set<string>
  // 2026-08-13 追加: 日本人の法定休日（日曜）割増を別枠支給するための集計。
  //   基本給・残業から除外して 1.35/1.60 倍を別建てするため、人工と残業hを分離して持つ。
  //   8h超の 1.60 倍判定は「日ごと」なので実労働時間は日単位で保持する
  //   （同一日に複数現場があるとエントリ単位では8hの線が引けない）。
  legalHolidayManDays?: number   // 法定休日の人工（基本給から除外する分）
  legalHolidayOtHours?: number   // 法定休日の残業h（残業手当から除外する分）
  _lhDayHours?: Map<string, number>  // ym_day → 法定休日の実労働時間
  _jpWorkedDays?: Set<number>  // 日本人の出勤日（日曜の警告用）
  // 2026-07-06 追加: 有給/試験/休業補償も同一日複数現場で重複排除する（全日単位の概念）。
  //   これがないと同日2現場に p/exam/w=0.6 が入っている人で plUsed 等が2倍になり、
  //   有給手当の過払い・欠勤控除の漏れが発生していた（actualWorkDays と同じ扱いに統一）。
  _plDaySeen?: Set<string>
  _examDaySeen?: Set<string>
  _compDaySeen?: Set<string>
  // 出向情報
  isDispatched?: boolean         // 常時出向中（Worker.dispatchTo が設定済み）
  dispatchTo?: string            // 出向先名
  dispatchDeduction?: number     // 出向控除額（実出勤×日額＋残業 = totalCost と同等）
  // Salary calc fields (variable working hours system)
  prescribedHours?: number
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  // 2026-06-15 追加: 旧ルール固定給(フン等)の「補償日 通常分控除」。
  //   固定月給/固定所定の基本給は全所定日を満額前提とするため、会社都合休(0.6補)の日も
  //   一旦満額を控除し、別途60%を休業補償で還元する（労基法26条）。正味は日給の40%控除。
  //   これにより欠勤日数(absence)は「真の無給欠勤」だけを表し、補償日と二重計上しない。
  compBaseDeduction?: number
  salaryNetPay?: number
  // 3層構造 fields (A+X案: 2026年5月〜)
  fixedBasePay?: number        // 基本給（固定）= 時給 × ベース日数 × 7h
  additionalAllowance?: number // 追加所定手当 = 時給 × MAX(0, 実出勤日数 − ベース日数) × 7h
  // 2026-06 追加: 有給日給（20日枠を超えた有給日 × 時給 × 7h）。月給制維持での有給未払い是正用。
  paidLeaveDays?: number
  paidLeaveAllowance?: number
  legalLimit?: number          // 法定上限時間 = 暦日数 × 40 ÷ 7
  // ── 法令準拠の詳細支給項目 (2026-05-13 追加、新ルール=変形労働時間制) ──
  legalHolidayHours?: number      // 法定休日(日曜)の実労働時間
  legalHolidayDays?: number       // 法定休日(日曜)に実労働があった日数
  legalHolidayAllowance?: number  // 法定休日手当 = 時間 × 時給 × 1.35
  nightHours?: number             // 深夜(22:00-5:00)の実労働時間
  nightAllowance?: number         // 深夜手当 = 時間 × 時給 × 0.25
  compAllowance?: number          // 休業手当 = 補償日数 × 時給 × 7h × 0.6
  regularWorkDays?: number        // 通常出勤日数（日曜出勤を除く、追加所定の対象）
  // 2026-06-XX 追加: スタッフ固有の所定日数（配置現場の calendar から算出）
  //   新ルール: MAX(配置現場の siteWorkDays) — 笹塚なら 23 など
  //   旧ルール: 全社所定 (main.workDays[ym]) — 23 など
  //   基本給ベース日数 (baseDays=20) とは別概念。UI 表示で混同しないため明示保持。
  workerPrescribedDays?: number
  // 2026-07-18 追加: 当月の帰国中（一時帰国・復帰未定含む）日数。
  //   在籍日数から差し引かれ、その日は無給かつ欠勤に計上されない。UI/書類で「帰国中◯日」表示用。
  hkDays?: number
  /** 帰国申請の期間内なのに出勤打刻があった日数（＝予定より早く復帰した。申請の終了日を直すべき） */
  hkEarlyReturnDays?: number
  /** 同上の最初の日付（画面に「◯◯から復帰済み」と出すため） */
  hkEarlyReturnFirstDate?: string
  dailyStatutoryOT?: number       // 日単位の法定外残業（1日8h超）
  weeklyStatutoryOT?: number      // 週単位の法定外残業（週40h超、日単位分除く）
  monthlyStatutoryOT?: number     // 月単位の法定外残業（法定上限超、日/週分除く）
  // ── 2026-06-XX 追加: 所定外労働手当（法定内・割増なし） ──
  // 残業欄入力時間のうち、3層判定で法定外残業に該当しなかった分を
  // 通常賃金で支払う必要がある（労基法24条 賃金全額払い）。
  // 例: 出勤18日+有給2日+残業18.5h、statutoryOT=1.0h
  //     → nonStatutoryOTHours = 17.5h、手当 = 時給×17.5h
  nonStatutoryOTHours?: number    // 所定外労働時間（法定内・割増なし）
  nonStatutoryOTAllowance?: number // 所定外労働手当 = 時給 × nonStatutoryOTHours
  // ── 2026-08 追加: 遠方現場日当・運転手当（2026-10-01 施行、lib/allowance.ts が規則の唯一の置き場） ──
  //   netPay / salaryNetPay / totalCost には加算済みの状態で返る（内訳表示用にここへも分けて持つ）。
  //   施行前の月（ALLOWANCE_FROM_YM 未満）ではフィールド自体が付かない。
  // ── 2026-09 追加: 休憩短縮に伴う定例の所定外労働（フン 104 の個別契約）──
  //   休憩を40分×2 → 30分×2 に揃えた分（20分/日）を、出勤日ごとに所定外労働として
  //   法定内（1日8時間以内）だが、雇用契約書の割増率「所定超 25%」に合わせて残業と同じ単価で支払う（2026-09-15 代表決定）。
  breakShortenHours?: number      // 加算した時間（出勤日数 × 分 ÷ 60）
  breakShortenAllowance?: number  // 休憩短縮手当 = 切上(残業単価 × breakShortenHours)
  breakShortenDays?: number       // 対象の出勤日数（計算根拠の式に出す・2026-10-23）
  breakShortenMinPerDay?: number  // 1日あたりの分（同上）
  breakShortenUnitRate?: number   // 使った単価（残業単価・円。同上）
  breakShortenUnitNote?: string   // 単価の出し方（例「時給 ¥1,280 × 1.25・切上」。同上）
  siteAllowance?: number   // 遠方現場日当（非課税・実費弁償）。長期従事の逓減適用後
  allowanceDays?: number   // 日当の対象日数
  driveAllowance?: number  // 運転手当（課税。割増賃金基礎への算入は社労士レビュー後）
  driveLegs?: number       // 運転した便数（行き・帰り合計）
  /** 有給精算の日数（日本人の日給月給・2026-10〜。lib/leave-settle.ts。出面には入らない） */
  leaveSettleDays?: number
  /** 有給精算手当 = 日額 × 有給精算の日数（salaryNetPay に加算済み） */
  leaveSettleAllowance?: number
  /** 給与チェックの注意点（支給額は変えない・2026年9月分〜・2026-10-02）。無い月は付かない */
  payNotes?: PayNote[]
  /** 日曜に出勤した日（注意点用・全員） */
  _sundayWorkDays?: Set<number>
  /** 日本人: 日ごとの日勤の時間（人工×8h。週40時間超の注意点用） */
  _jpDayHours?: Map<number, number>
  /** 旧ルール: 計算に使った1日あたりの賃金（日給。注意点用） */
  _oldRuleDayRate?: number
  /**
   * 日本人の現場都合休（出面の 0.6）の日数（2026-10-02 総合点検）。
   * 日本人の 0.6 は compDays に入らず workDays に 0.6 日として入る（基本給 = 日額×0.6）ので、
   * 月次集計Excel の「補償日」列が日本人は常に 0 だった。表示用に日数だけ別に持つ（支給額には使わない）
   */
  jpCompDays?: number
  _jpCompDaySeen?: Set<string>
}

export interface SubconMonthly {
  id: string
  name: string
  type: string
  rate: number
  otRate: number
  sites: string[]
  workDays: number
  otCount: number
  cost: number
}

export interface SiteSummary {
  id: string
  name: string
  archived: boolean
  workDays: number
  subWorkDays: number
  otHours: number
  cost: number
  subCost: number
  billing: number
  profit: number
  profitRate: number
  dispatchDeduction?: number  // 出向控除額（人件費から差引、売上は既に控除済みの値が入力されている）
}

export function computeMonthly(
  main: MainData,
  attD: Record<string, AttendanceEntry>,
  attSD: Record<string, { n: number; on: number }>,
  ym: string,
  prescribedDays: number = 0,
  siteWorkDaysMap?: Record<string, number>,  // siteId -> workDays (from calendar)
  baseDays: number = 20,  // 3層構造の基本給ベース日数（管理者設定）
  // 現場×日の勤務カレンダー（siteId -> { "d": "work"|... }）。
  //   外国人給与の週残業しきい値を「カレンダー予定日ベース」で判定するために
  //   calculateVietnameseSalary へ引き渡す（監査④）。未指定時は従来動作。
  calendarDays?: Record<string, Record<string, string>>,
  // 2026-07-18 追加: 帰国中（一時帰国・復帰未定）期間。approved/foreman_approved の
  //   homeLongLeave を getAllActiveHomeLeaves() で取得して渡す。未指定時は従来動作
  //   （帰国中日の除外なし）。在籍日数按分に織り込み、帰国中日を無給かつ非欠勤扱いにする。
  homeLeaves?: HomeLeaveEntry[],
  // 2026-08 追加: 遠方現場日当・運転手当（loadMonthlyAllowances() の戻り値をそのまま渡す）。
  //   施行前の月は loadMonthlyAllowances が undefined を返すので、過去月の計算は変わらない。
  allowances?: Map<number, WorkerAllowanceMonthly>,
): {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  sites: SiteSummary[]
  totals: { workDays: number; subWorkDays: number; cost: number; subCost: number; billing: number; profit: number; otHours: number }
} {
  // 2026-09-15: 工種サイト（親現場の下の入力先）は親のカレンダーを使う。
  //   呼び出し元（月次・締め・Excel・ダッシュボード・サイドバー）がそれぞれ作るマップを、ここで一括して補う
  siteWorkDaysMap = siteWorkDaysMap ? withWorkTypeSiteCalendars(main.sites, siteWorkDaysMap) : siteWorkDaysMap
  calendarDays = calendarDays ? withWorkTypeSiteCalendars(main.sites, calendarDays) : calendarDays
  // Worker monthly map
  // ★ この月時点で出向中かどうかを ym で判定（dispatchFrom 以降のみ true）
  const workerMap = new Map<number, WorkerMonthly>()
  // 現場ごとの workSchedule マップを構築（時間ベース入力での実労働時間計算に使用）
  // ※ RawSite では一部フィールドが optional のため、SiteWorkSchedule への代入時に補完が必要
  const siteScheduleMap = new Map<string, RawSite['workSchedule']>()
  for (const s of main.sites) {
    siteScheduleMap.set(s.id, s.workSchedule)
  }

  // 月の実労働時間累積（時間ベース入力対応）。新ルールの法定上限判定に使用。
  const actualWorkHoursAccumByWid = new Map<number, number>()

  // 「原価＝実際の支給額」で集計するスタッフ（= 日本人日給月給 以外＝ベトナム人 + 日本人完全月給）の
  //   現場別出勤日数。原価は支給額を出勤実績で各現場へ配賦するため、エントリ単位の概算
  //   (日数×日額) は site.cost に積まず、ここに日数を貯めて後段で支給額を比例配賦する。
  //   ※ 日本人日給月給は totalCost = 日数×日額 = 支給額 で一致するため従来どおりエントリ加算。
  const payrollSiteDays = new Map<number, Map<string, number>>()

  for (const w of main.workers) {
    // 2026-06-XX: 退職月のスタッフ（例: 6/30 退職予定）も当月は集計対象に含める
    // （旧: `if (w.retired) continue` は退職日が入った瞬間に当月も除外する事故）
    // 該当月の月初以降に退職する場合は在籍中とみなす
    if (!isStillActiveForMonth(w.retired, ym)) continue
    // 2026-06: 入社前の月は対象外（例: 濱上 hireDate 2026-06-01 は 2026年5月に出さない）。
    // 完全月給/月給制は出勤ゼロでも表示するため、入社前ガードが無いと前月に載ってしまう。
    if (!isHiredByMonth(w.hireDate, ym)) continue
    const dispatchedThisMonth = isDispatchedAt(w, ym)
    workerMap.set(w.id, {
      id: w.id, name: w.name, org: w.org, visa: w.visa, job: w.job,
      // 2026-09-03: 年次改定を基準日より前に確定した月は、改定前の日額で計算する
      //   （旧: 確定と同時に rate が新額になり、9月分の給与まで10/1施行の日額で計算されていた）
      rate: effectiveRateForYm(w, ym),
      // 時給も適用開始日で解決（2026-09-10）: 3号移行(9/21)など月途中の変更は暦日按分、
      //   10/1 の一律改定を先に反映しても 9 月分は旧時給で計算される
      hourlyRate: effectiveHourlyRateForYm(w, ym), otMul: w.otMul,
      // 2026-09-14: 固定月給も適用開始日で解決（フォン・タンの 10/1 最賃対応を 9 月中に仕込むため）
      salary: effectiveSalaryForYm(w, ym),
      // 2026-06-XX 追加: 下流の表示層が「フン等の個別旧ルール継続者」を判別できるようにする
      useOldRules: w.useOldRules,
      payrollNo: w.payrollNo || undefined,
      sites: [],
      workDays: 0, actualWorkDays: 0, compDays: 0, workAll: 0, otHours: 0,
      plDays: 0, plUsed: 0, restDays: 0, siteOffDays: 0, examDays: 0,
      cost: 0, otCost: 0, totalCost: 0,
      absence: 0, absentCost: 0, netPay: 0,
      isDispatched: dispatchedThisMonth,
      dispatchTo: dispatchedThisMonth ? (w.dispatchTo || '') : '',
      dispatchDeduction: 0,
    })
    actualWorkHoursAccumByWid.set(w.id, 0)
  }

  // Subcon monthly map
  const subconMap = new Map<string, SubconMonthly>()
  for (const sc of main.subcons) {
    subconMap.set(sc.id, {
      id: sc.id, name: sc.name, type: sc.type, rate: sc.rate, otRate: sc.otRate,
      sites: [], workDays: 0, otCount: 0, cost: 0,
    })
  }

  // Site summary map
  const siteMap = new Map<string, SiteSummary>()
  for (const s of main.sites) {
    siteMap.set(s.id, {
      id: s.id, name: s.name, archived: s.archived,
      workDays: 0, subWorkDays: 0, otHours: 0, cost: 0, subCost: 0,
      billing: 0, profit: 0, profitRate: 0,
    })
  }

  // Process attendance data
  for (const [key, entry] of Object.entries(attD)) {
    if (!entry) continue
    const pk = parseDKey(key)
    const siteId = pk.sid
    const wid = parseInt(pk.wid)
    if (pk.ym !== ym) continue

    const wm = workerMap.get(wid)
    if (!wm) continue
    // 何らかの記録がある日（稼働日未入力の検出用・2026-09-13）
    if (!wm._entryDaySeen) wm._entryDaySeen = new Set<string>()
    wm._entryDaySeen.add(`${pk.ym}_${pk.day}`)

    // ★ 有給は人工にカウントしない → 即continue
    //   同一日複数現場は1日として数える（全日単位。actualWorkDays と同じ扱い）
    if (entry.p) {
      const dayKey = `${pk.ym}_${pk.day}`
      if (!wm._plDaySeen) wm._plDaySeen = new Set<string>()
      if (!wm._plDaySeen.has(dayKey)) {
        wm._plDaySeen.add(dayKey)
        wm.plDays += 1
        wm.plUsed += 1
      }
      if (!wm.sites.includes(siteId)) wm.sites.push(siteId)
      continue
    }
    // ★ 試験は人工にカウントしないが、給与計算では出勤と同等扱い (examDays として集計)
    //   同一日複数現場は1日として数える
    if (entry.exam) {
      const dayKey = `${pk.ym}_${pk.day}`
      if (!wm._examDaySeen) wm._examDaySeen = new Set<string>()
      if (!wm._examDaySeen.has(dayKey)) {
        wm._examDaySeen.add(dayKey)
        wm.examDays += 1
      }
      if (!wm.sites.includes(siteId)) wm.sites.push(siteId)
      continue
    }
    // ★ 帰国中は実出勤にも欠勤にもカウントしない
    if (entry.hk) continue
    if (entry.r) {
      // 「欠」は1日に1回だけ数える（2026-10-02 総合点検）。旧はエントリ（現場）ごとに数えていたので、
      //   同じ日に2現場へ「欠」が入ると、日本人月給制の欠勤控除が2日分引かれていた
      //   （有給・試験・補償日の _plDaySeen 等と同じ日単位の重複除去）
      if (!wm._restDaySeen) wm._restDaySeen = new Set<string>()
      const restKey = `${pk.ym}_${pk.day}`
      if (!wm._restDaySeen.has(restKey)) { wm._restDaySeen.add(restKey); wm.restDays += 1 }
      // 保証から引く「本人の欠勤」は、カレンダーで仕事の日に休んだ分だけ（2026-09-30 総点検で修正）。
      //   祝日・所定休日に本人が「休み」を入れても欠勤ではない（ファン 9/21・22、サン 9/6 の事例）。
      //   カレンダーが無い現場は日曜以外を仕事の日とみなす。同じ日に2現場あっても1日
      {
        const dt = calendarDays?.[siteId]?.[String(pk.day)]
        const dow = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)) - 1, parseInt(pk.day)).getDay()
        const isWorkDay = dt !== undefined ? dt === 'work' : dow !== 0
        if (isWorkDay) {
          if (!wm._absenceDaySeen) wm._absenceDaySeen = new Set<string>()
          const k = `${pk.ym}_${pk.day}`
          if (!wm._absenceDaySeen.has(k)) { wm._absenceDaySeen.add(k); wm.personalAbsenceDays = (wm.personalAbsenceDays || 0) + 1 }
        }
      }
      // 「その他」の休みでメモが会社都合（60%・現場休み）を指すもの＝本人の選び間違いの疑い（2026-09-30）
      if (isSuspectCompanyRest(entry)) (wm.suspectCompRestDays ||= []).push(Number(pk.day))
      continue
    }
    if (entry.h) { wm.siteOffDays += 1; continue }
    if (!entry.w) continue

    // ★ 休業補償(0.6)のロジック
    const isComp = (entry.w === 0.6 && wm.visa !== 'none')
    const workCount = isComp ? 0 : entry.w  // 補償は人工0

    wm.workDays += workCount
    // ── 夜勤（2026-08 追加）──
    //   夜勤は workDays に足さない。w=1.5 のような表現にすると出勤日数が1.5日になり、
    //   欠勤判定（所定日数 − workDays）が壊れる。人工は manDays 側で持つ。
    if (entry.ns && !isComp) {
      const nsHours = calcNightShiftHours(entry)
      wm.nightShiftDays = (wm.nightShiftDays || 0) + 1
      wm.nightManDays = Math.round(((wm.nightManDays || 0) + NIGHT_SHIFT_MANDAYS) * 100) / 100
      wm.nightShiftHours = Math.round(((wm.nightShiftHours || 0) + nsHours) * 10) / 10

      // 日本人（日給月給・完全月給）の 1.5人工 が法令を満たすかを夜勤日ごとに検証し、
      // 法定必要額と実支給額を積む。支給額は変えず、不足があれば月次画面で警告する。
      // 2026-08-27 修正（給与総点検）: 完全月給者(rate=0, salary>0)が rate>0 条件で
      //   素通しになり、深夜割増の未払いが無警告だった → 月給の日額換算で判定に含める
      if (wm.visa === 'none' && (wm.rate > 0 || (wm.salary ?? 0) > 0)) {
        const dayH = entry.st && entry.et
          ? calcDayShiftHours(entry, siteScheduleMap.get(siteId) as Parameters<typeof calcActualHours>[1])
          : (entry.nonly ? 0 : (entry.w || 0) * JP_PRESCRIBED_HOURS_PER_DAY + (entry.o || 0))
        let nightMin = entry.st && entry.et
          ? calcNightMinutes(timeToMinutes(entry.st), timeToMinutes(entry.et))
          : 0
        const nr = getNightRange(entry)
        if (nr) {
          nightMin += Math.min(
            calcNightMinutes(timeToMinutes(nr.start), timeToMinutes(nr.end)),
            Math.round(nsHours * 60),
          )
        }
        const dow = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)) - 1, Number(pk.day)).getDay()
        // 完全月給者は日額換算（salary/20）で法定必要額を見積もる。実支給側(nightShiftPaid)は
        // rate=0 のため0となり、夜勤があれば必ず不足警告が出る＝深夜割増の検討を促す
        const effRateForLegal = wm.rate > 0 ? wm.rate : Math.round((wm.salary ?? 0) / 20)
        wm.legalRequiredPay = (wm.legalRequiredPay || 0) + calcNightShiftLegalRequiredPay({
          dailyRate: effRateForLegal,
          prescribedHours: JP_PRESCRIBED_HOURS_PER_DAY,
          totalHours: dayH + nsHours,
          nightHours: nightMin / 60,
          isLegalHoliday: dow === 0,
          otMul: wm.otMul,
        })
        // 同じ日に実際に支払う額（人工 × 日額 ＋ 残業手当）
        const otUnit = ceilYen((wm.rate / JP_PRESCRIBED_HOURS_PER_DAY) * (wm.otMul || 1.25))
        wm.nightShiftPaid = (wm.nightShiftPaid || 0)
          + ceilYen(calcManDays(entry) * wm.rate) + ceilYen(otUnit * (entry.o || 0))
      }
    }
    // 人工数: 夜勤が無ければ workCount と一致する（既存挙動を変えない）
    wm.manDays = Math.round(((wm.manDays || 0) + (isComp ? 0 : calcManDays(entry))) * 100) / 100

    // ── 法定休日（日曜）の労働を別枠で集計 ──（2026-08-13 追加）
    //   日本人は「日額×人工 ＋ 残業h×1.25」で処理していたため、法定休日の1.35倍が
    //   未計上だった（労基法37条は国籍を問わない）。ベトナム人と同じ建て方に揃え、
    //   法定休日は所定労働日ではないので基本給・残業から外し、別枠で1.35/1.60倍を支給する。
    //   ※ ベトナム人は calculateVietnameseSalary が独自に処理するのでここでは集計しない
    //   ※ 夜勤(ns)のある日は対象外（2026-08-27 代表決定）: 日曜夜勤は「夜勤1回=1.5人工」の
    //     慣例支給を維持する（1.35×実時間に置換しない）。法定必要額との差は
    //     legalRequiredPay/legalShortfall（日曜は1.35倍で算定済み）の警告で監視する。
    // 日本人の出勤日（日曜の警告用・2026-09-30）。補償日・休みは含めない
    //   isComp はベトナム人だけが真なので、日本人の現場都合休（w=0.6）はここで除く（2026-09-30 点検）
    if (wm.visa === 'none' && !isComp && entry.w !== 0.6 && calcManDays(entry) > 0) {
      if (!wm._jpWorkedDays) wm._jpWorkedDays = new Set<number>()
      wm._jpWorkedDays.add(Number(pk.day))
    }
    // 日本人の現場都合休（0.6）の日数（Excel の「補償日」列の表示用・2026-10-02）
    if (wm.visa === 'none' && entry.w === 0.6) {
      wm._jpCompDaySeen ||= new Set<string>()
      const ck = `${pk.ym}_${pk.day}`
      if (!wm._jpCompDaySeen.has(ck)) { wm._jpCompDaySeen.add(ck); wm.jpCompDays = (wm.jpCompDays || 0) + 1 }
    }
    // 給与チェックの注意点のための日別の記録（2026-10-02 総合点検。支給額には使わない）
    if (!isComp && calcManDays(entry) > 0) {
      const dayN = Number(pk.day)
      if (new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, dayN).getDay() === 0) {
        (wm._sundayWorkDays ||= new Set<number>()).add(dayN)
      }
      if (wm.visa === 'none' && entry.w !== 0.6) {
        // 日勤の所定分だけ（残業 o は 1.25倍で払っているので週の判定には足さない）
        const dayH = (entry.nonly ? 0 : (entry.w || 0)) * JP_PRESCRIBED_HOURS_PER_DAY
        wm._jpDayHours ||= new Map<number, number>()
        wm._jpDayHours.set(dayN, (wm._jpDayHours.get(dayN) || 0) + dayH)
      }
    }
    if (wm.visa === 'none' && !isComp && !entry.ns && jpSundayPremiumApplies(ym)) {
      const dow0 = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, Number(pk.day)).getDay()
      if (dow0 === 0) {
        wm.legalHolidayManDays = Math.round(((wm.legalHolidayManDays || 0) + calcManDays(entry)) * 100) / 100
        wm.legalHolidayOtHours = (wm.legalHolidayOtHours || 0) + (entry.o || 0)
        // 実労働時間は日単位で積む（8h超の1.60倍判定が日ごとのため）
        const lhKey = `${pk.ym}_${pk.day}`
        if (!wm._lhDayHours) wm._lhDayHours = new Map<string, number>()
        const lhHours = (entry.nonly ? 0 : (entry.w || 0) * JP_PRESCRIBED_HOURS_PER_DAY + (entry.o || 0))
          + calcNightShiftHours(entry)
        wm._lhDayHours.set(lhKey, (wm._lhDayHours.get(lhKey) || 0) + lhHours)
      }
    }

    // ── 「22時以降の労働は必ず夜勤として登録する」運用ルールのガード（2026-08）──
    //   日本人はレガシー入力（出勤値＋残業h）で始業終業を持たないため、深夜時間を
    //   時刻から判定できない。原則として22時以降は夜勤シフトになる運用だが、
    //   残業欄だけに長時間が入っていると深夜割増も1.5人工も付かない状態になる。
    //   現場の終業時刻＋残業hから終業を逆算し、22時を超える日を検出して警告する。
    if (wm.visa === 'none' && !isComp && !entry.ns && !entry.st && (entry.o || 0) > 0) {
      const jws = siteScheduleMap.get(siteId) as { endTime?: string } | undefined
      const schedEndMin = jws?.endTime ? timeToMinutes(jws.endTime) : 17 * 60
      if (schedEndMin + (entry.o || 0) * 60 > 22 * 60) {
        wm.lateNightRiskDays = (wm.lateNightRiskDays || 0) + 1
        console.warn(
          `[compute] 22時超の労働が夜勤未登録: ${wm.name} (${ym}-${pk.day}) 残業${entry.o}h。` +
          `現場の終業 ${jws?.endTime || '17:00'} から逆算すると22時を超えています。` +
          `夜勤として登録すべきか確認してください（深夜割増も1.5人工も付いていません）。`
        )
      }
    }
    // 2026-06-XX 修正 (C8): 同一日複数現場の actualWorkDays 二重カウント解消
    //   旧: エントリ単位で += 1 → 1日に2現場勤務(各 w=0.5)で actualWorkDays += 2 となり
    //       「1日なのに2日出勤」扱い、欠勤判定が過少に
    //   新: ワーカーごとに日単位でユニーク化（Set<ym_day>）
    if (!isComp) {
      const dayKey = `${pk.ym}_${pk.day}`
      if (!wm._actualDaySeen) wm._actualDaySeen = new Set<string>()
      if (!wm._actualDaySeen.has(dayKey)) {
        wm._actualDaySeen.add(dayKey)
        wm.actualWorkDays += 1
      }
    }
    if (isComp) {
      // 休業補償(0.6)も全日単位 → 同一日複数現場は1日として数える
      const compDayKey = `${pk.ym}_${pk.day}`
      if (!wm._compDaySeen) wm._compDaySeen = new Set<string>()
      if (!wm._compDaySeen.has(compDayKey)) {
        wm._compDaySeen.add(compDayKey)
        wm.compDays += 1
      }
    }
    if (entry.o && entry.o > 0 && !isComp) wm.otHours += entry.o
    if (!wm.sites.includes(siteId)) wm.sites.push(siteId)

    // ⏱️ 実労働時間を正確に集計（新ルール=5月以降の法定上限判定に使用）
    //   - 時間ベース入力（st/et あり）: calcActualHours で実時間（休憩控除済み・残業含む）を取得
    //   - レガシー（st/et なし）: w * 7h + entry.o（5月以降の例外的レガシー入力にも対応）
    //   - 補償日 (isComp) は実労働時間に含めない（新ルールの法定上限から除外）
    if (!isComp) {
      let dayHours = 0
      if (entry.st && entry.et) {
        // 時間ベース: 現場の workSchedule に従って実労働を計算
        // ※ RawSite の workSchedule は optional だが、calcActualHours は内部で `?.` でアクセスするので安全
        dayHours = calcActualHours(entry, siteScheduleMap.get(siteId) as Parameters<typeof calcActualHours>[1])
      } else {
        // レガシー: 1日所定（=7h）+ 残業 ＋ 夜勤ブロック
        //   日本人は日給月給で st/et を持たないため、夜勤の実労働はここで加算される
        dayHours = (entry.nonly ? 0 : (entry.w || 0) * 7 + (entry.o || 0))
          + calcNightShiftHours(entry)
      }
      const accum = actualWorkHoursAccumByWid.get(wid) || 0
      actualWorkHoursAccumByWid.set(wid, accum + dayHours)
    }

    // ★ サイト別コストは直接エントリごとに加算
    // 2026-06-XX 修正 (C1): 月給制日本人 (rate=0) のサイト原価ゼロ問題
    //   getWorkerDailyRate で月給制も日額換算（salary/20）
    const otDiv = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    const entryDailyRate = getWorkerDailyRate({ visa: wm.visa, rate: wm.rate, salary: wm.salary, hourlyRate: wm.hourlyRate })
    const otCost = (isComp ? 0 : (entry.o || 0)) * (entryDailyRate / otDiv) * wm.otMul
    // 2026-08: 人工ベース。夜勤日は 1.5人工（日勤＋夜勤なら 2.5人工）で原価計上する。
    //   夜勤が無ければ calcManDays(entry) === entry.w なので従来と同額。
    const entryCost = (isComp ? entry.w : calcManDays(entry)) * entryDailyRate + otCost
    // 原価=実支給額で集計する。エントリ単位の概算(日数×日額)を site.cost に積まず、
    // 出勤日数だけ記録して後段で支給額を比例配賦する。
    //   2026-09-02 修正（有給総点検・第4回）: 日本人日給月給も対象に統一。旧は「日数×日額＝支給額」の
    //   前提で従来加算していたが、有給手当・法定休日手当がある月は totalCost(=支給額) と
    //   現場原価の合計が食い違い、現場別利益が過大になっていた。
    const usePayrollCost = true
    const site = siteMap.get(siteId)
    if (site) {
      site.workDays += workCount
      site.otHours += (isComp ? 0 : (entry.o || 0))
      if (usePayrollCost) {
        if (workCount > 0) {
          let m = payrollSiteDays.get(wid)
          if (!m) { m = new Map<string, number>(); payrollSiteDays.set(wid, m) }
          m.set(siteId, (m.get(siteId) || 0) + workCount)
        }
      } else {
        site.cost += entryCost
        // 出向者の人件費はサイトの出向控除額に積む（後段で売上・人件費から差引）
        if (wm.isDispatched) {
          site.dispatchDeduction = (site.dispatchDeduction || 0) + entryCost
        }
      }
    }
  }

  // Process subcon data
  for (const [key, entry] of Object.entries(attSD)) {
    if (!entry) continue
    const pk = parseSdKey(key, main.subcons.map(x => x.id))   // 外注IDの「_」に対応（2026-10-02）
    const siteId = pk.sid
    const scid = pk.wid
    if (pk.ym !== ym) continue

    const sc = subconMap.get(scid)
    if (!sc) continue

    // 2026-08-27 修正（給与総点検）: 残業のみの日（n=0, on>0。入力UIが正当に保存する形）が
    //   n>0 ガードで丸ごと脱落し、残業原価が未計上=利益過大になっていた
    if (entry.n > 0 || (entry.on || 0) > 0) {
      sc.workDays += entry.n
      sc.otCount += entry.on || 0
      if (!sc.sites.includes(siteId)) sc.sites.push(siteId)

      // ★ 現場別単価を使用（月別overrides も考慮）
      const scR = getSubconRate(main, scid, siteId, ym)
      const scCost = entry.n * scR.rate + (entry.on || 0) * scR.otRate
      // 2026-06-12 修正 (監査): SubconMonthly.cost も現場別単価で積み上げ。
      //   旧: 後段で workDays×基本単価 の一括計算 → 現場別オーバーライドがある外注先で
      //   site.subCost（現場別単価）と外注先別合計（基本単価）が食い違っていた
      sc.cost += scCost
      const site = siteMap.get(siteId)
      if (site) {
        site.subWorkDays += entry.n
        site.subCost += scCost
      }
    }
  }

  // ── 休憩短縮に伴う定例の所定外労働（2026-09 施行・フン 104 の個別契約）──
  //   出勤した日にだけ加算する（有給・休み・補償日・帰国中は対象外＝actualWorkDays が
  //   ちょうどその条件＝lib/attendance-confirm.ts isBreakShortenEntry）。金額は下の給与ブランチで
  //   「残業単価（時給×1.25・切上）× 時間」で計算する（2026-09-15 代表決定）。
  //   ⚠️ 給与計算ループより前に確定させること（後ろに置くと各ブランチが読めない）
  for (const wm of workerMap.values()) {
    const src = main.workers.find(w => w.id === wm.id)
    const min = src?.breakShortenMin ?? 0
    const from = src?.breakShortenFrom
    if (min > 0 && from && ym >= from && wm.actualWorkDays > 0) {
      // 金額は丸めない正確な時間から算出する（3桁で丸めると1円ズレる）。表示側で丸める
      wm.breakShortenHours = wm.actualWorkDays * min / 60
      wm.breakShortenDays = wm.actualWorkDays
      wm.breakShortenMinPerDay = min
    }
  }

  // 会社都合休と自分都合の休みの取り違えの疑い（lib/rest-mismatch.ts・2026-09-30）。表示だけで金額は変えない
  {
    const parentOf = new Map(main.sites.map(st => [st.id, (st as { parentId?: string }).parentId || st.id]))
    const yN = parseInt(ym.slice(0, 4)), mN = parseInt(ym.slice(4, 6))
    const mism = detectRestMismatches(attD, ym, sid => parentOf.get(sid) || sid, (fam, day) => {
      const cal = calendarDays?.[fam]
      return cal ? cal[String(day)] === 'work' : new Date(yN, mN - 1, day).getDay() !== 0
    })
    for (const mm of mism) {
      const wm = workerMap.get(mm.workerId)
      if (wm) (wm.restMismatchDays ||= []).push(mm.day)
    }
  }

  // 日本人: 割増を付けない月（2026-10〜）に、前の6日すべて出勤した日曜（＝その週に休みが無い）を警告する。
  //   月をまたぐ週は前月の出勤が分からないので判定しない（誤警報を出さない）
  if (!jpSundayPremiumApplies(ym)) {
    const yN = parseInt(ym.slice(0, 4)), mN = parseInt(ym.slice(4, 6))
    for (const wm of workerMap.values()) {
      if (wm.visa !== 'none' || !wm._jpWorkedDays || wm.job === 'yakuin') continue
      const worked = wm._jpWorkedDays
      const hits: number[] = []
      for (const d of worked) {
        if (d < 7 || new Date(yN, mN - 1, d).getDay() !== 0) continue
        let all = true
        for (let k = d - 6; k < d; k++) if (!worked.has(k)) { all = false; break }
        if (all) hits.push(d)
      }
      if (hits.length > 0) wm.sundayNoRestDays = hits.sort((a, b) => a - b)
    }
  }

  // Calculate worker costs
  for (const wm of workerMap.values()) {
    wm.workAll = wm.workDays + wm.compDays * 0.6  // 出勤日数（0.6含む）
    // 月給制の日本人は rate が 0 でも salary から日額換算で原価計算（現場別配賦のため）
    // 月給/月所定日数（20日固定で簡便。実所定日数は後段で計算するが、原価配賦は概算で十分）
    const effectiveDailyRate = (wm.visa === 'none' && wm.salary && wm.salary > 0)
      ? wm.salary / 20
      : wm.rate
    // 2026-08: 人工ベース（夜勤の 1.5人工 を原価に反映）。夜勤が無い月は manDays === workDays
    wm.cost = (wm.manDays ?? wm.workDays) * effectiveDailyRate + (wm.compDays * 0.6 * effectiveDailyRate)  // 補償分も原価に含む
    const otDiv2 = wm.visa === 'none' ? 8 : 7 // 日本人8h, 外国人7h
    wm.otCost = wm.otHours * (effectiveDailyRate / otDiv2) * wm.otMul
    wm.totalCost = wm.cost + wm.otCost
    // 出向者: 控除額 = totalCost（人件費から差引）
    if (wm.isDispatched) {
      wm.dispatchDeduction = wm.totalCost
    }

    // スタッフごとの所定日数:
    //   - 新ルール（変形労働制 ym>=202605）: 現場の就業カレンダー(siteWorkDaysMap)を使用
    //     → 現場が土曜も休む等で月20日設定なら、その値で給与計算
    //   - 旧ルール (useOldRules=true や 4月以前): 全社所定 prescribedDays を使用
    //     → 「日曜のみ休み(+祝日) = 月23日」が原則。現場 calendar とは独立。
    //
    // 2026-06-XX 修正: 旧ルール継続者(フン 104 等)に対して誤って site calendar の値が
    //   採用されていたバグを修正。例: フンが IH 現場(土曜休み20日設定)のみ配置の場合、
    //   旧ルールでは 23日所定のはずが 20日扱いで欠勤控除が発生しない問題があった。
    const workerWmEarly = main.workers.find(x => x.id === wm.id)
    const isOldRulesWorker = ym < '202605' || workerWmEarly?.useOldRules === true
    let workerPrescribedDays = prescribedDays
    if (!isOldRulesWorker && siteWorkDaysMap && wm.sites.length > 0) {
      // 新ルールのみ: スタッフが配置されている現場の所定日数の最大値を採用
      const siteDays = wm.sites.map(sid => siteWorkDaysMap[sid] || 0).filter(d => d > 0)
      if (siteDays.length > 0) {
        workerPrescribedDays = Math.max(...siteDays)
      }
    }

    // 2026-06-XX 追加 (I-7): 中途入退社月の baseDays / 所定日数 を在籍期間で按分
    //   旧: baseDays/prescribedDays が常に20固定で、中途入退社月では実労働<20で
    //       過大な欠勤控除が発生していた
    //   新: 在籍日数の割合で baseDays/prescribedDays を縮小
    //       例: 6/15入社 → 在籍 16/30 = 53% → baseDays = round(20 × 0.53) = 11日
    const rawWorker = main.workers.find(x => x.id === wm.id)
    let proratedBaseDays = baseDays
    let proratedPrescribedDays = workerPrescribedDays
    // 2026-06-12 追加 (監査C5): 固定月給者（フン・完全月給）の月途中入退社の日割り用比率。
    //   在籍日数 ÷ 暦日数。固定月給の基本給に乗じる（労基法の日割り原則）。
    let prorationRatio = 1
    if (rawWorker) {
      const ymY = parseInt(ym.slice(0, 4))
      const ymM = parseInt(ym.slice(4, 6))
      const monthStartIso = `${ymY}-${String(ymM).padStart(2, '0')}-01`
      const monthEndIso = `${ymY}-${String(ymM).padStart(2, '0')}-${String(new Date(ymY, ymM, 0).getDate()).padStart(2, '0')}`
      const totalDaysInMonth = new Date(ymY, ymM, 0).getDate()

      const hireDate = rawWorker.hireDate || ''
      const retiredDate = rawWorker.retired || ''

      // 在籍期間の開始日 = max(月初, 入社日)
      const startIso = hireDate && hireDate > monthStartIso ? hireDate : monthStartIso
      // 在籍期間の終了日 = min(月末, 退職日)
      const endIso = retiredDate && retiredDate < monthEndIso ? retiredDate : monthEndIso

      if (startIso <= endIso) {
        // 在籍日数を計算
        const startD = parseInt(startIso.slice(8, 10))
        const endD = parseInt(endIso.slice(8, 10))
        let activeDays = endD - startD + 1
        // 2026-07-18 追加: 帰国中（一時帰国・復帰未定を含む）の暦日を在籍日数から除外。
        //   これにより基本給・所定日数がその日ぶん縮小し、「無給かつ欠勤に計上されない」を実現する
        //   （欠勤控除は所定日数を基準に残差算出するため、所定から外れた帰国中日は欠勤にならない）。
        //   按分は既存の中途入退社ロジックと同じ暦日比方式（近似）で一貫させる。
        // 出勤打刻のある日（ISO）。申請期間内でもこの日は帰国から除外する（早期復帰対応）。
        //   _actualDaySeen は entry ループで作った「実際に出勤した日」の集合（同日複数現場は1日）。
        const workedIso = new Set<string>()
        for (const k of wm._actualDaySeen || []) {
          const [kym, kday] = k.split('_')
          if (!kym || !kday) continue
          workedIso.add(`${kym.slice(0, 4)}-${kym.slice(4, 6)}-${kday.padStart(2, '0')}`)
        }
        // 有給を充てた日（_plDaySeen は 'YYYYMM_D' 形式）。帰国日から除外するため ISO へ直す
        const plIso = new Set<string>()
        for (const k of wm._plDaySeen || []) {
          const [kym, kday] = k.split('_')
          if (!kym || !kday) continue
          plIso.add(`${kym.slice(0, 4)}-${kym.slice(4, 6)}-${kday.padStart(2, '0')}`)
        }
        const hk = countHomeLeaveDaysInRange(homeLeaves, wm.id, startIso, endIso, workedIso, plIso)
        if (hk.earlyReturnDates.length > 0) {
          // 申請より早く復帰した日。給与は実データで正しく計算されるが、
          // 申請の終了日を直すべきなので月次画面に出して管理者に気づかせる。
          wm.hkEarlyReturnDays = hk.earlyReturnDates.length
          wm.hkEarlyReturnFirstDate = hk.earlyReturnDates[0]
        }
        if (hk.days > 0) {
          wm.hkDays = hk.days
          activeDays = Math.max(0, activeDays - hk.days)
        }
        if (activeDays < totalDaysInMonth) {
          // 按分が必要なケース（中途入社 / 中途退職 / 帰国中）
          const ratio = activeDays / totalDaysInMonth
          proratedBaseDays = Math.round(baseDays * ratio)
          proratedPrescribedDays = Math.round(workerPrescribedDays * ratio)
          prorationRatio = ratio
        }
      }
    }
    // 後段の計算で proratedBaseDays / proratedPrescribedDays を使う
    // 一旦 workerPrescribedDays を上書き
    // 2026-06-12 追加 (監査C5): 按分前の所定日数も保持（固定月給の時給換算単価は
    //   按分前のフル月ベースで出す。按分後で割ると単価が月途中入退社月だけ跳ね上がるため）
    const unproratedPrescribedDays = workerPrescribedDays
    workerPrescribedDays = proratedPrescribedDays

    // 2026-06-XX 追加: UI 表示用に workerPrescribedDays を保存
    //   PayrollAuditModal で「所定日数(配置現場)」として表示。
    //   baseDays (=20, 基本給ベース) と区別して見せるための情報。
    wm.workerPrescribedDays = workerPrescribedDays

    // ベトナム人スタッフの給与計算は2026年5月を境に旧ルール／新ルールが切り替わる
    // - 4月以前: 月の所定時間ベース（旧ロジック）
    //            基本給=時給×所定時間, 残業=実労働>所定時間, 欠勤=所定日数下回り分
    // - 5月以降: 3層構造 + 法定上限ベース（新ロジック）
    //            基本給固定=時給×20日×7h, 追加所定=20日超分, 残業=実労働>法定上限
    //
    // 2026-05-12 追加: ワーカー個別に useOldRules=true が立っている場合、5月以降も旧ルールを継続。
    //   本人が新ルール移行を拒否したケース（例: フン 104, 2027/02 で現雇用契約終了）に対応。
    //   退職後は retired により自動的に給与計算対象外になる。
    const workerWm = main.workers.find(x => x.id === wm.id)
    const useNewRules = ym >= '202605' && !workerWm?.useOldRules
    const addNote = (code: PayNote['code'], message: string, amount?: number) => {
      if (ym < PAY_NOTES_FROM_YM) return
      ;(wm.payNotes ||= []).push(amount !== undefined ? { code, message, amount } : { code, message })
    }
    /**
     * 新ルールのベトナム人の注意点（支給額は変えない・2026-10-02 総合点検）
     *   ① ほかの現場のカレンダーが週の所定を押し上げていないか（本人の現場だけで計算し直して比べる）
     *   ② 月途中の時給改定で、改定後の残業が平均時給で安く計算されていないか
     *   ③ 稼働日の空欄が「欠」より多く払われていないか（空欄を欠として計算し直して比べる）
     */
    const vnNotes = (v: VietnameseSalaryResult, hourly: number, personalAbsence: number | undefined) => {
      if (ym < PAY_NOTES_FROM_YM) return
      // ① 本人の現場のカレンダーだけで判定し直す
      if (calendarDays) {
        const allKeys = Object.keys(calendarDays)
        const own: Record<string, Record<string, string>> = {}
        for (const sid of wm.sites) if (calendarDays[sid]) own[sid] = calendarDays[sid]
        if (Object.keys(own).length > 0 && allKeys.length > Object.keys(own).length) {
          const v2 = calculateVietnameseSalary(wm.id, ym, hourly, proratedBaseDays, attD, main.sites,
            wm.plUsed, wm.compDays, wm.examDays, own, workerPrescribedDays > 0 ? workerPrescribedDays : undefined, personalAbsence)
          const dh = Math.round((v2.statutoryOT - v.statutoryOT) * 10) / 10
          if (dh > 0) {
            addNote('crossSiteCalendar',
              `ほかの現場のカレンダーが週の所定時間を押し上げ、法定外残業が ${dh}h 少なく出ています（本人の現場のカレンダーだけなら ${v2.statutoryOT}h）。割増の差 約${(v2.otAllowance - v.otAllowance).toLocaleString()}円。代表に確認してください`,
              v2.otAllowance - v.otAllowance)
          }
        }
      }
      // ② 月途中の時給改定（適用開始日がこの月の2日以降）
      const from = workerWm?.hourlyRateFrom
      const prev = workerWm?.prevHourlyRate
      const cur = workerWm?.hourlyRate
      if (from && prev != null && cur != null && cur !== prev && /^\d{4}-\d{2}-\d{2}$/.test(from)
        && from.slice(0, 4) + from.slice(5, 7) === ym && Number(from.slice(8, 10)) > 1) {
        const fromD = Number(from.slice(8, 10))
        let before = 0, after = 0
        for (const [key, e] of Object.entries(attD)) {
          const pk2 = parseDKey(key)
          if (pk2.ym !== ym || pk2.wid !== String(wm.id) || !e || !isWorkingDay(e) || !e.w || e.w === 0.6) continue
          const ot = calcOvertimeHours(e, siteScheduleMap.get(pk2.sid) as SiteWorkSchedule | undefined)
          if (Number(pk2.day) >= fromD) after += ot; else before += ot
        }
        // 目安: 所定外（1.0倍）をその日の時給で払った場合との差（割増0.25倍分は含めない）
        const diff = after * cur + before * prev - (after + before) * hourly
        if (after + before > 0 && diff > 0.5) {
          addNote('midMonthRateOt',
            `${Number(from.slice(5, 7))}/${fromD} に時給が ${prev.toLocaleString()}→${cur.toLocaleString()}円 に変わった月です。残業・深夜・休日の手当は月の平均時給 ${hourly.toLocaleString()}円 で計算しています。改定後の残業（${Math.round(after * 10) / 10}h）が多いため、その日の時給で計算するより約 ${ceilYen(diff).toLocaleString()}円 少ない計算です。代表に確認してください`,
            ceilYen(diff))
        }
      }
      // ③ 稼働日の空欄（案Aでは「欠」だけが保証日数から引かれる）
      const blank = wm.calendarBlankDays || 0
      if (blank > 0 && personalAbsence !== undefined) {
        const v3 = calculateVietnameseSalary(wm.id, ym, hourly, proratedBaseDays, attD, main.sites,
          wm.plUsed, wm.compDays, wm.examDays, calendarDays, workerPrescribedDays > 0 ? workerPrescribedDays : undefined, personalAbsence + blank)
        const diff = v.salaryNet - v3.salaryNet
        if (diff > 0) {
          addNote('blankDays',
            `稼働日なのに記録が無い日が ${blank}日 あります。空欄のまま締めると「欠」と入れた場合より ${diff.toLocaleString()}円 多い計算になります（空欄は保証日数から引かれないため）。締める前に 欠／0.6補／有給 のどれかを入れてください`,
            diff)
        }
      }
    }

    if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0 && useNewRules && !(wm.salary && wm.salary > 0)) {
      // ── 5月以降: 法令準拠（変形労働時間制） ──
      // ※ salary（固定月給）が設定されている場合は時給ブランチをスキップし、
      //   下段の salary 方式（基本給=月給固定）を採用する。salary が authoritative。
      // 計算内容（calculateVietnameseSalary が一括処理）:
      //   1. 基本給(固定)     = 時給 × baseDays × 7h
      //   2. 追加所定手当     = 時給 × (regularWorkDays − baseDays) × 7h  ※法定休日を除いた出勤日
      //   3. 法定外残業手当   = 3層判定(日/週/月) × 時給 × 1.25
      //   4. 法定休日手当     = 日曜の実労働 × 時給 × 1.35
      //   5. 深夜手当         = 22:00-5:00 の重なり × 時給 × 0.25
      //   6. 休業手当         = 補償日 × 時給 × 7h × 0.6
      //   7. 欠勤控除         = 欠勤日 × 時給 × 7h
      // 所定休日(土・カレンダーoff)労働は別枠1.25倍を支払わず、週40h超過分のみ
      // 法定外残業として1.25倍が自動適用される（法令最低・最適コスト）。
      // 2026-06-XX 修正 (I-7): 中途入退社時は proratedBaseDays を使用
      // 2026-09-13: 配置現場カレンダーの稼働日に出面が無い日を数える（入力漏れ→100%控除の事故検出）
      //   複数現場に記録がある人は「その月に最も多く記録がある現場」（主現場）のカレンダーで判定する。
      //   全現場の和集合にすると、別現場の稼働日まで未入力扱いになって過剰に警告が出るため。
      if (calendarDays && wm.sites.length > 0) {
        const hire = workerWm?.hireDate || ''
        const ret = workerWm?.retired || ''
        const ymY2 = parseInt(ym.slice(0, 4)); const ymM2 = parseInt(ym.slice(4, 6))
        const dim = new Date(ymY2, ymM2, 0).getDate()
        const perSite = new Map<string, number>()
        for (const key of Object.keys(attD)) {
          const pk2 = parseDKey(key)
          if (pk2.ym !== ym || pk2.wid !== String(wm.id)) continue
          perSite.set(pk2.sid, (perSite.get(pk2.sid) || 0) + 1)
        }
        const mainSite = [...perSite.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || wm.sites[0]
        // 数えるのは昨日まで（2026-10-09 代表指摘: 10/9 に10月の月次を開くと、まだ来ていない稼働日まで
        //   「記録が無い日 15日」と出ていた）。今日はまだ入力の途中なので数えない。締めた過去の月には影響しない
        const todayIso = todayJstIso()
        let blank = 0
        for (let d = 1; d <= dim; d++) {
          const iso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
          if (iso >= todayIso) break
          if (hire && iso < hire) continue
          if (ret && iso > ret) continue
          if (calendarDays[mainSite]?.[String(d)] !== 'work') continue
          if (wm._entryDaySeen?.has(`${ym}_${d}`)) continue
          blank++
        }
        if (blank > 0) wm.calendarBlankDays = blank
      }
      // 2026-09-30（案A・9月分〜）: 本人の欠勤（出面の「欠」）を保証日数から引く
      const personalAbsence1 = ym >= PAYROLL_RULES.personalAbsenceReducesGuaranteeFromYm ? (wm.personalAbsenceDays || 0) : undefined
      const v = calculateVietnameseSalary(
        wm.id, ym, wm.hourlyRate, proratedBaseDays, attD, main.sites,
        wm.plUsed, wm.compDays, wm.examDays, calendarDays,
        // 2026-09-13: 保証枠 = min(20, 配置現場カレンダーの所定日数)。閑散期の月給保証
        workerPrescribedDays > 0 ? workerPrescribedDays : undefined,
        personalAbsence1,
      )
      wm.guaranteeDays = v.guaranteeDays
      vnNotes(v, wm.hourlyRate, personalAbsence1)

      wm.fixedBasePay = v.fixedBasePay
      wm.additionalAllowance = v.additionalAllowance
      wm.paidLeaveDays = v.paidLeaveDays
      wm.paidLeaveAllowance = v.paidLeaveAllowance
      wm.nonStatutoryOTHours = v.nonStatutoryOTHours
      wm.nonStatutoryOTAllowance = v.nonStatutoryOTAllowance
      wm.otAllowance = v.otAllowance
      wm.legalHolidayHours = v.legalHolidayHours
      wm.legalHolidayDays = v.legalHolidayDays
      wm.legalHolidayAllowance = v.legalHolidayAllowance
      wm.nightHours = v.nightHours
      wm.nightAllowance = v.nightAllowance
      wm.compAllowance = v.compAllowance
      wm.compInGuaranteeDays = v.compInGuaranteeDays || undefined
      wm.absentDeduction = v.absentDeduction
      wm.salaryNetPay = v.salaryNet
      wm.regularWorkDays = v.regularWorkDays
      wm.dailyStatutoryOT = v.dailyStatutoryOT
      wm.weeklyStatutoryOT = v.weeklyStatutoryOT
      wm.monthlyStatutoryOT = v.monthlyStatutoryOT
      wm.legalLimit = v.legalLimit
      wm.prescribedHours = baseDays * 7
      wm.actualWorkHours = v.actualWorkHours
      wm.legalOtHours = v.statutoryOT
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = v.fixedBasePay  // legacy: UI互換のため
      wm.absence = v.absentDays
      wm.absentCost = v.absentDeduction
      wm.netPay = v.salaryNet
      // 2026-06-XX 修正 (I-10): 出向控除を実支給額ベースに置換
      //   旧: totalCost (rate×days の粗い原価) → 実支給額と乖離 → 出向先請求と不整合
      if (wm.isDispatched) wm.dispatchDeduction = v.salaryNet
    } else if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0 && workerPrescribedDays > 0 && !(wm.salary && wm.salary > 0)) {
      // ── 4月以前 / 旧ルール継続: 時給ベース ──
      // ※ salary（固定月給）が設定されている場合はこのブランチをスキップし、
      //   下段の旧ルール salary 方式（基本給=月給固定）を採用する（フン等の固定月給者）。
      // 設計（2026-05-08 ユーザー確定）:
      //   1日所定 = 6時間40分（= 20/3h）。週6日×6h40m = 40h で法定上限内。
      //   基本給   = 時給 × 月の所定時間（=月所定日数 × 6h40min、固定）
      //   休業補償 = 補償日数 × 時給 × 6h40min × 0.6 （別項目で加算）
      //   残業手当 = 月の残業時間合計（= 各日の o の合計） × 時給 × 1.25
      //              ※ 旧ルールは1日単位での残業判定。月単位の所定超過判定はしない。
      //   欠勤控除 = 真の欠勤日数 × 時給 × 6h40min
      //              ※ 0.6補償・有給・試験は出勤扱いで欠勤に含めない。
      //   支給額  = 基本給 + 休業補償 + 残業手当 − 欠勤控除
      const dailyHoursOld = 20 / 3  // = 6.667h
      const prescribedH = workerPrescribedDays * dailyHoursOld

      // 基本給
      const basePay = ceilYen(wm.hourlyRate * prescribedH)  // 支給: 1円未満切り上げ

      // 休業補償（補償日 = 0.6保証）
      const compAllowance = ceilYen(wm.hourlyRate * dailyHoursOld * 0.6 * wm.compDays)  // 支給: 切り上げ

      // 残業手当（日単位の積み上げ）— 1円未満は切り上げ
      const otAllowance = ceilYen(wm.hourlyRate * 1.25 * wm.otHours)

      // 真の欠勤日数（有給・試験・補償日は欠勤に含めない）
      // 2026-06-15 修正: 補償日(0.6補)を欠勤日数から除外。欠勤日数は「無給の欠勤」だけを表す。
      //   補償日の通常分(満額)は別途 compBaseDeduction で控除し、60%を休業補償で還元する。
      //   （正味は日給の40%控除＝60%支給。支給総額は従来と不変。）
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed - wm.examDays - wm.compDays)
      const absentDeduction = floorYen(wm.hourlyRate * dailyHoursOld * absentDays)  // 控除: 切り捨て（過少支払い防止）
      // 補償日 通常分控除（固定所定の基本給は満額前提のため、補償日も一旦満額を控除）
      const compBaseDeduction = floorYen(wm.hourlyRate * dailyHoursOld * wm.compDays)

      // 表示用: 実労働時間（補償も0.6相当でカウント）
      const actualWorkH = wm.actualWorkDays * dailyHoursOld + wm.compDays * 0.6 * dailyHoursOld + wm.otHours

      const salaryNet = basePay + compAllowance + otAllowance - absentDeduction - compBaseDeduction
      wm._oldRuleDayRate = wm.hourlyRate * dailyHoursOld

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(wm.otHours * 10) / 10  // 旧ルールは月の残業時間合計と同じ
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      // additionalAllowance を「休業補償」として流用（UI/Excel 側で旧ルール用ラベル "休業補償" に切替）
      wm.additionalAllowance = compAllowance
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.compBaseDeduction = compBaseDeduction
      wm.salaryNetPay = salaryNet

      wm.absence = absentDays
      wm.absentCost = absentDeduction + compBaseDeduction
      wm.netPay = salaryNet
    } else if (wm.visa !== 'none' && wm.salary && wm.salary > 0 && useNewRules) {
      // ── 5月以降: 法令準拠（salary方式: 月給から時給を逆算） ──
      // hourlyRate版と同じ計算式を使用。基本給だけは月給固定値で上書き。
      // 2026-06-XX 修正 (I-7/I-9): 中途入退社時は基本給を proratedBaseDays で按分
      //   月給制でも在籍期間に応じて basePay を縮小（労基法の日割り原則）
      const proratedSalary = baseDays > 0 ? ceilYen(wm.salary * (proratedBaseDays / baseDays)) : wm.salary  // 支給: 切り上げ
      const derivedHourlyRate = wm.salary / (Math.max(1, baseDays) * 7)  // 単価は固定（按分前の月給ベース。baseDays=0 設定でも NaN にしない）
      const v = calculateVietnameseSalary(
        wm.id, ym, derivedHourlyRate, proratedBaseDays, attD, main.sites,
        wm.plUsed, wm.compDays, wm.examDays, calendarDays,
        // 2026-09-13: 保証枠 = min(20, 配置現場カレンダーの所定日数)（時給ブランチと同じ）
        workerPrescribedDays > 0 ? workerPrescribedDays : undefined,
        // 2026-09-30（案A）: 月給ブランチも同じく本人の「欠」を保証から引く
        ym >= PAYROLL_RULES.personalAbsenceReducesGuaranteeFromYm ? (wm.personalAbsenceDays || 0) : undefined,
      )
      wm.guaranteeDays = v.guaranteeDays
      vnNotes(v, derivedHourlyRate, ym >= PAYROLL_RULES.personalAbsenceReducesGuaranteeFromYm ? (wm.personalAbsenceDays || 0) : undefined)
      // 基本給は月給値を採用（時給からの再計算による丸め誤差を避ける）
      // 2026-06-XX 修正 (I-7): 中途入退社時は按分した値を採用
      const fixedBase = proratedSalary
      // 2026-09-13: 休憩短縮手当（20分/日）。旧ルール固定月給ブランチと同じく所定超25%（2026-09-15）
      //   単価はこのブランチの時給（契約時給。未登録なら月給÷140h）× 1.25（円未満切上）
      const bsHours = wm.breakShortenHours || 0
      const bsUnitRate = ceilYen(derivedHourlyRate * 1.25)
      const breakShortenAllowance = bsHours > 0 ? ceilYen(bsUnitRate * bsHours) : 0
      if (breakShortenAllowance > 0) {
        wm.breakShortenAllowance = breakShortenAllowance
        wm.breakShortenUnitRate = bsUnitRate
        wm.breakShortenUnitNote = `時給 ¥${derivedHourlyRate.toLocaleString('ja-JP', { maximumFractionDigits: 2 })} × 1.25・切上`
      }
      // 2026-06-XX 修正: 所定外労働手当 (nonStatutoryOTAllowance) も加算
      // 2026-06-12 修正 (監査C1): 有給日給 (paidLeaveAllowance) の加算漏れを是正。
      //   時給ブランチは v.salaryNet（有給日給込み）を使うが、本ブランチは合算を
      //   手組みしているため b38d658 の有給日給追加から取り残されていた。
      const salaryNet = fixedBase + v.additionalAllowance + v.paidLeaveAllowance
                      + v.nonStatutoryOTAllowance + v.otAllowance
                      + v.legalHolidayAllowance + v.nightAllowance + v.compAllowance
                      + breakShortenAllowance
                      - v.absentDeduction

      wm.fixedBasePay = fixedBase
      wm.paidLeaveDays = v.paidLeaveDays
      wm.paidLeaveAllowance = v.paidLeaveAllowance
      wm.additionalAllowance = v.additionalAllowance
      wm.nonStatutoryOTHours = v.nonStatutoryOTHours
      wm.nonStatutoryOTAllowance = v.nonStatutoryOTAllowance
      wm.otAllowance = v.otAllowance
      wm.legalHolidayHours = v.legalHolidayHours
      wm.legalHolidayDays = v.legalHolidayDays
      wm.legalHolidayAllowance = v.legalHolidayAllowance
      wm.nightHours = v.nightHours
      wm.nightAllowance = v.nightAllowance
      wm.compAllowance = v.compAllowance
      wm.compInGuaranteeDays = v.compInGuaranteeDays || undefined
      wm.absentDeduction = v.absentDeduction
      wm.salaryNetPay = salaryNet
      wm.regularWorkDays = v.regularWorkDays
      wm.dailyStatutoryOT = v.dailyStatutoryOT
      wm.weeklyStatutoryOT = v.weeklyStatutoryOT
      wm.monthlyStatutoryOT = v.monthlyStatutoryOT
      wm.legalLimit = v.legalLimit
      wm.prescribedHours = baseDays * 7
      wm.actualWorkHours = Math.round((v.actualWorkHours + bsHours) * 10) / 10
      wm.legalOtHours = v.statutoryOT
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = fixedBase
      // 2026-06-XX 修正 (I-10): 出向控除を実支給額ベースに置換
      if (wm.isDispatched) wm.dispatchDeduction = salaryNet
      wm.absence = v.absentDays
      wm.absentCost = v.absentDeduction
      wm.netPay = salaryNet
    } else if (wm.visa !== 'none' && wm.salary && wm.salary > 0 && workerPrescribedDays > 0) {
      // ── 旧ルール継続・固定月給（フン 104）──
      //   基本給 = 固定月給(salary)。出勤・所定日数に関わらず毎月固定。
      //   残業・欠勤は「日給(rate)ベース」で計算する。月給から逆算すると所定日数で
      //   単価が月ごとに変動してしまうため（フンの残業単価は固定2,943円が正）。
      //     時給     = 日給(rate) ÷ 1日所定(6h40m=20/3)
      //     残業単価 = 切上(時給 × otMul)  ← 固定（例: 15,693÷6.667×1.25 = 2,943）
      //     残業手当 = 切上(残業単価 × 残業時間)
      //     欠勤控除 = 日給 × 欠勤日数（= 時給 × 6h40m × 欠勤日数、切捨）
      //   ※ 日給(rate)が無い場合のみ月給から逆算（後方互換）。
      // 2026-09-14 代表決定: 7時間契約の固定月給者（フォン 207・タン 208）は**契約時給**を単価にする。
      //   判定: 日給(rate) = 契約時給(hourlyRate) × 7 のとき（= 1日7hの契約）。
      //   旧来の「日給 ÷ 6h40m」だと 8,890 ÷ 6.667 = 1,333.5円となり、残業単価（1,667円）・休憩短縮手当が
      //   契約時給 1,270円（残業 1,588円）より高く出ていた。日給・欠勤控除・休業補償は 1,270×7 = 8,890 で不変。
      //   フン 104（日給15,693 ≠ 2,403×7）は該当せず、残業単価 2,943円 のまま。
      //   当初は締め済みの 2026-08 を動かさないよう 2026-09 分からとしたが、2026-09-15 代表決定で
      //   8月分から適用（HFU の8月分は最低20日保証の変更で締め直すため、あわせて契約時給にそろえる）。
      const isSevenHourContract = ym >= '202608'
        && !!wm.hourlyRate && wm.hourlyRate > 0 && !!wm.rate && wm.rate === wm.hourlyRate * 7
      const dailyHoursOld = isSevenHourContract ? 7 : 20 / 3
      const prescribedH = workerPrescribedDays * dailyHoursOld
      // 後方互換フォールバックの時給換算は按分前のフル月所定で算出（単価は月で変えない）
      const fullPrescribedH = (unproratedPrescribedDays > 0 ? unproratedPrescribedDays : workerPrescribedDays) * dailyHoursOld
      const hourlyRate = isSevenHourContract
        ? wm.hourlyRate!
        : (wm.rate && wm.rate > 0) ? (wm.rate / dailyHoursOld) : (wm.salary / fullPrescribedH)
      const otMul = wm.otMul && wm.otMul > 0 ? wm.otMul : 1.25

      // 2026-06-12 修正 (監査C5): 月途中入退社は固定月給を在籍日数で日割り（暦日比・切上）
      const basePay = ceilYen(wm.salary * prorationRatio)
      const compAllowance = ceilYen(hourlyRate * dailyHoursOld * 0.6 * wm.compDays)  // 休業補償 = 日給×0.6×補償日（切上）
      const otUnitRate = ceilYen(hourlyRate * otMul)        // 残業単価を1円単位に切り上げ（固定）
      const otAllowance = ceilYen(otUnitRate * wm.otHours)  // 残業手当も1円未満切り上げ
      // 2026-06-15 修正: 補償日(0.6補)を欠勤日数から除外。欠勤日数は「無給の欠勤」だけを表す。
      //   固定月給は全所定日を満額前提とするため、補償日の通常分(満額)を compBaseDeduction で控除し、
      //   別途60%を休業補償(compAllowance)で還元する（正味は日給の40%控除＝60%支給）。支給総額は不変。
      const absentDays = Math.max(0, workerPrescribedDays - wm.actualWorkDays - wm.plUsed - wm.examDays - wm.compDays)
      const compBaseDeduction = floorYen(hourlyRate * dailyHoursOld * wm.compDays)  // 補償日 通常分控除（満額・切捨）
      // 2026-10-02 総合点検: 控除は基本給（日割り後）を超えない。
      //   全社所定日数が「月給 ÷ 日給」（24日前後）より多い月は、欠勤1日あたりの控除（日給）が
      //   基本給の1日分を超えるため、欠勤が多いと支給額がマイナスになっていた
      //   （例: 月給240,000・日給10,000・所定27日・出勤2日 → 240,000 − 25日×10,000 = −10,000）。
      //   日本人月給制の欠勤控除（Math.min(basePay, …)）と同じく、基本給を下限0にする。
      //   日給×出勤日数を下回る問題（日給割れ）は賃金の決まりなので変えず、給与チェックの警告にする（payNotes）。
      const absentDeduction = Math.min(
        Math.max(0, basePay - compBaseDeduction),
        floorYen(hourlyRate * dailyHoursOld * absentDays),  // = 日給 × 欠勤日数（切捨: 過少払い防止）
      )
      // 休憩短縮分（20分/日など）は所定外労働。法定内だが、雇用契約書の割増率「所定超 25%」に合わせて
      //   **残業と同じ単価（時給×1.25・円未満切上）** で支払う（2026-09-15 代表決定・旧ルール3名の暫定措置）
      const bsHours = wm.breakShortenHours || 0
      const breakShortenAllowance = bsHours > 0 ? ceilYen(otUnitRate * bsHours) : 0
      if (breakShortenAllowance > 0) {
        wm.breakShortenAllowance = breakShortenAllowance
        wm.breakShortenUnitRate = otUnitRate
        wm.breakShortenUnitNote = isSevenHourContract
          ? `契約時給 ¥${hourlyRate.toLocaleString()} × ${otMul}・切上`
          : (wm.rate && wm.rate > 0)
            ? `日給 ¥${wm.rate.toLocaleString()} ÷ 6時間40分 × ${otMul}・切上`
            : `月給 ÷ 所定 ${Math.round(fullPrescribedH * 10) / 10}h × ${otMul}・切上`
      }
      const actualWorkH = wm.actualWorkDays * dailyHoursOld + wm.compDays * 0.6 * dailyHoursOld + wm.otHours + bsHours
      const salaryNet = basePay + compAllowance + otAllowance + breakShortenAllowance - absentDeduction - compBaseDeduction
      wm._oldRuleDayRate = hourlyRate * dailyHoursOld

      wm.prescribedHours = prescribedH
      wm.actualWorkHours = Math.round(actualWorkH * 10) / 10
      wm.legalOtHours = Math.round(wm.otHours * 10) / 10
      wm.dailyOtHours = Math.round(wm.otHours * 10) / 10
      wm.basePay = basePay
      wm.additionalAllowance = compAllowance  // 「休業補償」として使用（UI/Excel側でラベル切替）
      wm.otAllowance = otAllowance
      wm.absentDeduction = absentDeduction
      wm.compBaseDeduction = compBaseDeduction
      wm.salaryNetPay = salaryNet

      wm.absence = absentDays
      wm.absentCost = absentDeduction + compBaseDeduction
      wm.netPay = salaryNet
    } else if (wm.visa === 'none' && wm.salary && wm.salary > 0) {
      // ── 月給制の日本人: 月給固定 + 残業時給換算 ──
      // 基本給 = 月給(固定)。月途中入退社のみ在籍日数で日割り（暦日比・切上）
      // 時給換算 = 月給 ÷ 月平均所定労働時間 145h（固定・2026-07-09 代表確定）
      //   施行規則19条: 月ごとに所定労働時間が異なる場合は「年平均の月所定時間」で除する。
      //   日比建設は年間休日が現場依存で事前確定できないため、新卒等の想定レンジ
      //   （完全週休2日・祝日出勤・GW/夏季/年末年始 → 年間休日115〜125日 × 7h/日
      //    → 月平均 140〜145.8h）の内側の 145h に固定する。
      //   分母を実際の所定より小さめに固定するぶんには単価が法定最低を上回り常に適法。
      //   旧: 当月所定日数×8h → 単価が毎月変動し、契約実態(7h/日)とも不一致で法定割れの疑い。
      // 残業手当 = 時給換算 × otMul × 残業時間
      // 支給額 = 基本給 + 残業手当
      // ※ 出勤日数に関わらず基本給は固定（労基法上の月給制）
      // 2026-06-12 修正 (監査C5): 中途入退社の日割りを追加。時給換算単価は按分前ベース
      const hourlyEquivalent = wm.salary / JP_SALARY_AVG_MONTHLY_HOURS
      const basePay = ceilYen(wm.salary * prorationRatio)
      // 2026-08-13 追加: 法定休日（日曜）労働は月給がカバーする所定労働日ではないため、
      //   別枠で 1.35/1.60 倍を支給する。月給は固定なので基本給からの除外は不要だが、
      //   残業hからは除外する（同じ時間に1.25倍と1.35倍が二重にかかるのを防ぐ）。
      const lhOtHoursM = wm.legalHolidayOtHours || 0
      const lhDayHoursM = Array.from(wm._lhDayHours?.values() || [])
      const otHoursExLhM = Math.max(0, wm.otHours - lhOtHoursM)
      // 残業単価を1円単位に切り上げ → 残業代も1円未満切り上げ
      const otUnitRate = ceilYen(hourlyEquivalent * wm.otMul)
      const otPay = ceilYen(otUnitRate * otHoursExLhM)
      const legalHolidayAllowanceM = calcLegalHolidayAllowance(hourlyEquivalent, lhDayHoursM)

      // ── 欠勤控除（2026年8月分から・代表決定 2026-08-31。JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM）──
      //   従来は「出勤日数に関わらず月給は固定」で、欠勤しても引かれなかった。
      //   過去の支給額を動かさないよう、適用開始月をゲートで区切る。
      //
      //   ── 欠勤日数は「出面に記録された欠勤」だけを数える（代表決定 2026-08-31）──
      //   現場カレンダーの稼働日から引き算する方式にしない。理由:
      //     笹塚は土曜もお盆初日も稼働日だが、濱上さん（年少者・週休2日）は出ない。
      //     カレンダー基準で計算すると、休むはずの土曜まで欠勤になり
      //     欠勤7.5日=83,928円 と過大に引いてしまう（実際は2.5日=36,718円）。
      //   そこで **欠勤日数は出面の記録から数える**:
      //     欠勤日数 = 出面の「欠(r)」の日数 ＋ 出勤日の不足分（1 − 人工）
      //   ブランクの日は「そもそも所定労働日ではない」とみなすので控除されない。
      //   入力漏れがそのまま減給になる事故を防ぐ意味もある。
      //
      //   1日あたりの控除額は **月給 ÷ 月平均所定労働日数(20.83日)** で固定する
      //   （2026-08-31 代表決定）。月ごとの所定日数で割ると、同じ1日の欠勤でも
      //   7月10,681円 / 8月14,687円 と変わり、稼働日の少ない月に休むほど損をする。
      //   分母の根拠は lib/constants.ts の JP_ANNUAL_WORK_DAYS を参照。
      //
      //   ⚠️ 役員（yakuin）は対象外。役員報酬は労働の対価ではなく、出面の日数で
      //   増減させるものではない。同じ「月給制ブランチ」に政仁さん（役員・月給118万）が
      //   入るため、除外しないと現場に出なかった日数ぶんが控除されてしまう
      //   （2026-08-31 にゴールデンマスターが検知。IHIの原価が84万円ずれた）。
      let absentDaysM = 0
      let absentDeductionM = 0
      if (wm.job !== 'yakuin' && ym >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM) {
        // 出勤したが1日に満たない分（例: 午後から出勤 w=0.5 → 0.5日の欠勤）
        const partialShortfall = Math.max(0, wm.actualWorkDays - wm.workDays)
        absentDaysM = Math.round((wm.restDays + partialShortfall) * 100) / 100
        if (absentDaysM > 0) {
          // 控除は基本給を超えない（マイナス支給にしない）
          absentDeductionM = Math.min(
            basePay,
            floorYen((basePay / JP_AVG_MONTHLY_WORK_DAYS) * absentDaysM),
          )
        }
      }

      wm.basePay = basePay
      wm.prescribedHours = JP_SALARY_AVG_MONTHLY_HOURS  // 割増算定基礎の月平均所定時間
      wm.dailyOtHours = Math.round(otHoursExLhM * 10) / 10
      wm.otAllowance = otPay
      wm.legalHolidayDays = wm._lhDayHours?.size || 0
      wm.legalHolidayHours = Math.round(lhDayHoursM.reduce((a, b) => a + b, 0) * 10) / 10
      wm.legalHolidayAllowance = legalHolidayAllowanceM
      wm.absence = absentDaysM
      wm.absentCost = absentDeductionM
      // 給与Excel（lib/export.ts）と検算は absentDeduction を読む。absentCost だけだと
      // Excel の控除列が0のまま支給額だけ減り、内訳合計と一致しなくなる（2026-08-31 総ざらいで検出）
      wm.absentDeduction = absentDeductionM
      wm.salaryNetPay = basePay + otPay + legalHolidayAllowanceM - absentDeductionM
      // netPay: 給与支給額（=月給+残業+法定休日手当）。
      //   原価(totalCost) と現場別配賦は後段の「原価＝実支給額」統一パスで処理する。
      wm.netPay = wm.salaryNetPay
    } else if (wm.visa === 'none') {
      // 日給月給制の日本人: daily-rate based
      // 基本給 = 日額(rate) × 実出勤日数
      // 有給手当 = 日額(rate) × 有給日数（2026-06 追加: 日給月給は有給日も日給を加算して支給）
      // 残業手当 = 残業単価(日額 ÷ 8h × otMul, 1円単位に切り上げ) × 残業時間
      // 支給額 = 基本給 + 有給手当 + 残業手当
      // 2026-08 追加: 人工ベースに変更。夜勤日は 1.5人工（日勤＋夜勤なら 2.5人工）で支給する
      //   慣例に対応する。夜勤が無い月は manDays === workDays なので従来と同額。
      // 2026-08-13 追加: 法定休日（日曜）は所定労働日ではないので日額・残業から除外し、
      //   別枠で 1.35/1.60 倍を支給する（労基法37条。ベトナム人と同じ建て方）。
      //   日曜出勤が無い月は除外額ゼロなので従来と同額。
      const lhManDays = wm.legalHolidayManDays || 0
      const lhOtHours = wm.legalHolidayOtHours || 0
      const lhDayHours = Array.from(wm._lhDayHours?.values() || [])
      const payManDays = Math.max(0, (wm.manDays ?? wm.workDays) - lhManDays)
      const otHoursExLh = Math.max(0, wm.otHours - lhOtHours)
      const basePay = ceilYen(payManDays * wm.rate + (wm.compDays * 0.6 * wm.rate))  // 支給: 切り上げ
      const paidLeaveAllowance = ceilYen(wm.plUsed * wm.rate)  // 有給手当 = 有給日数 × 日額（支給: 切り上げ）
      const otUnitRate = ceilYen((wm.rate / 8) * wm.otMul)  // 残業単価を1円単位に切り上げ
      const otPay = ceilYen(otUnitRate * otHoursExLh)         // 残業代も1円未満切り上げ
      const legalHolidayAllowance = calcLegalHolidayAllowance(wm.rate / JP_PRESCRIBED_HOURS_PER_DAY, lhDayHours)
      wm.basePay = basePay
      wm.paidLeaveDays = wm.plUsed
      wm.paidLeaveAllowance = paidLeaveAllowance
      wm.dailyOtHours = Math.round(otHoursExLh * 10) / 10
      wm.otAllowance = otPay
      wm.legalHolidayDays = wm._lhDayHours?.size || 0
      wm.legalHolidayHours = Math.round(lhDayHours.reduce((a, b) => a + b, 0) * 10) / 10
      wm.legalHolidayAllowance = legalHolidayAllowance
      wm.salaryNetPay = basePay + paidLeaveAllowance + otPay + legalHolidayAllowance
      // 2026-06-12 修正 (監査C4): 原価(totalCost)・netPay を支給額(salaryNetPay)に統一。
      //   旧: totalCost = 概算(cost + 丸め前float残業) + 有給手当 → salaryNetPay と数円ズレ、
      //       労務費合計と支給額合計が一致しなかった。原価=実支給額の原則に揃える。
      wm.totalCost = wm.salaryNetPay
      wm.netPay = wm.salaryNetPay
      if (wm.isDispatched) wm.dispatchDeduction = wm.salaryNetPay
      // 夜勤日の 1.5人工 が法定割増を満たしているか判定（不足分は月次画面で警告）。
      //   支給額は変えない。日曜の夜勤・長時間の通し勤務で不足が出る。
      if (wm.nightShiftDays) {
        const shortfall = (wm.legalRequiredPay || 0) - (wm.nightShiftPaid || 0)
        wm.legalShortfall = shortfall > 0 ? Math.ceil(shortfall) : 0
        if (wm.legalShortfall > 0) {
          console.warn(
            `[compute] 法定割増の不足: ${wm.name} (${ym}) 夜勤${wm.nightShiftDays}回。` +
            `法定必要額 ¥${Math.ceil(wm.legalRequiredPay || 0)} > 支給額 ¥${wm.nightShiftPaid || 0}` +
            `（不足 ¥${wm.legalShortfall}）。日曜の夜勤か長時間の通し勤務の可能性があります。`
          )
        }
      }
    } else if (wm.visa !== 'none' && wm.hourlyRate && wm.hourlyRate > 0) {
      // ⚠️ 2026-05-09: 防御的フォールバック
      //   外国人 (hourlyRate あり) なのに workerPrescribedDays が0の場合は、
      //   月所定日数が未設定で給与計算ができない状態。
      //   4月以前なら main.workDays['YYYYMM'] を 26日（日曜以外）等で設定する必要あり。
      //   サイレント失敗を防ぐため、console.error と最低限の情報を残す。
      //   2026-07-18: ただし当月まるごと帰国中(hkDays>0で所定0)なら正常な0円支給なので警告しない。
      if (!wm.hkDays) {
        console.error(`[compute] 警告: ${wm.name} (${ym}) の月所定日数が未設定です。main.workDays['${ym}'] を確認してください。`)
      }
      wm.basePay = 0
      wm.salaryNetPay = 0
      wm.netPay = 0
    } else if (workerPrescribedDays > 0) {
      wm.absence = Math.max(0, workerPrescribedDays - wm.workDays - wm.compDays - wm.plUsed - wm.examDays)  // 0.6は1日出勤扱い、試験も給与計算上は出勤扱い
      wm.absentCost = floorYen(wm.absence * wm.rate)  // 控除: 切り捨て（過少支払い防止）
      wm.netPay = wm.totalCost - wm.absentCost
    } else {
      wm.netPay = wm.totalCost
    }
  }

  // ── 遠方現場日当・運転手当（2026-10-01 施行）──
  //   ここ（実支給への原価統一ブロックの前）で netPay / salaryNetPay に加算しておくと、
  //   「原価＝実支給額」のスタッフ（ベトナム人・日本人完全月給）は後続ブロックが
  //   手当込みの支給額をそのまま原価・現場配賦に反映する。
  //   日本人日給月給（原価＝エントリ積み上げ）だけは、ここで原価と現場別原価にも直接積む。
  if (allowances) {
    for (const [wid, al] of allowances) {
      const wm = workerMap.get(wid)
      if (!wm) continue
      const total = al.siteAllowanceYen + al.driveAllowanceYen
      if (total <= 0) continue
      wm.siteAllowance = al.siteAllowanceYen
      wm.allowanceDays = al.allowanceDays
      wm.driveAllowance = al.driveAllowanceYen
      wm.driveLegs = al.driveLegs
      wm.netPay += total
      if (wm.salaryNetPay !== undefined) wm.salaryNetPay += total
      // 原価への反映は後段の「原価=実支給」ブロックが手当込みの支給額を現場へ配賦する
      // （2026-09-02: 日本人日給月給も実支給配賦に統一したため、ここでの直接加算は廃止。
      //   残すと手当が二重に原価計上される）
    }
  }

  // ── 有給精算手当（日本人の日給月給・2026年10月分〜・lib/leave-settle.ts）──
  //   有給の残りを日数で給料に回す（休みの多い月の補い）。承認済みの分は plData の buyoutHistory に
  //   reason='monthly-settle'・ym 付きで記録されている。出面には何も書かないので、年5日・管理簿の「取得」には入らない。
  //   原価への反映は後段の「原価=実支給」ブロックが支給額ごと現場へ配賦する（運転手当と同じ）。
  if (ym >= LEAVE_SETTLE_FROM_YM) {
    for (const wm of workerMap.values()) {
      const days = settledDaysForYm(main.plData?.[String(wm.id)] as unknown as Parameters<typeof settledDaysForYm>[0], ym)
      if (days <= 0) continue
      const raw = main.workers.find(x => x.id === wm.id)
      wm.leaveSettleDays = days
      if (!isLeaveSettleEligible(raw) || !(wm.rate > 0)) {
        // 承認のあとに月給・役員へ変わった人など。勝手に払わず、事務に気づかせる
        ;(wm.payNotes ||= []).push({
          code: 'leaveSettleNotDaily',
          message: `${LEAVE_SETTLE_LABEL}が ${days}日 承認されていますが、日給月給ではないため支給に入れていません。休暇管理で承認を取り消すか、代表に確認してください`,
        })
        continue
      }
      const amount = ceilYen(days * wm.rate)
      wm.leaveSettleAllowance = amount
      wm.netPay += amount
      if (wm.salaryNetPay !== undefined) wm.salaryNetPay += amount
      // 申請・承認の時は月の途中なので、締めの時点で月24日を超えていないかを見直す（支給額は変えない）
      const paidDays = wm.actualWorkDays + wm.plUsed + wm.compDays + wm.examDays
      if (paidDays + days > LEAVE_SETTLE_MONTH_CAP_DAYS) {
        ;(wm.payNotes ||= []).push({
          code: 'leaveSettleOverCap',
          message: `出勤${wm.actualWorkDays}＋有給${wm.plUsed}＋0.6補${wm.compDays}＋試験${wm.examDays}＋有給精算${days} = ${paidDays + days}日 で、月${LEAVE_SETTLE_MONTH_CAP_DAYS}日を超えています。休暇管理で精算の承認を取り消して申請し直してもらうか、このまま払うかを決めてください`,
          amount,
        })
      }
    }
  }

  // ── 給与チェックの注意点（支給額は変えない・2026-10-02 総合点検・2026年9月分〜）──
  //   ベトナム人新ルールの注意点は各ブランチの vnNotes。ここは全区分に共通のもの
  if (ym >= PAY_NOTES_FROM_YM) {
    const yN = parseInt(ym.slice(0, 4)), mN = parseInt(ym.slice(4, 6))
    const dimN = new Date(yN, mN, 0).getDate()
    const note = (wm: WorkerMonthly, code: PayNote['code'], message: string, amount?: number) =>
      (wm.payNotes ||= []).push(amount !== undefined ? { code, message, amount } : { code, message })
    for (const wm of workerMap.values()) {
      const raw = main.workers.find(x => x.id === wm.id)
      const isOldRule = wm.visa !== 'none' && (ym < '202605' || raw?.useOldRules === true)
      const isJpMonthly = wm.visa === 'none' && (wm.salary ?? 0) > 0 && wm.job !== 'yakuin'
      const isJpDaily = wm.visa === 'none' && !((wm.salary ?? 0) > 0) && wm.rate > 0
      const workedLabel = `出勤${wm.actualWorkDays}＋有給${wm.plUsed}＋試験${wm.examDays}`
      const workedDays = wm.actualWorkDays + wm.plUsed + wm.examDays

      // ① 支給額（残業・手当を除く）が「日給×働いた日数」を下回る（旧ルールの暦日按分・欠勤控除、日本人月給制の日割り）
      //    旧ルールの分は 2026-10-05 代表決定で出さない（OLD_RULE_BELOW_WORKED_DAYS_NOTE_FROM_YM = null。最低保証の決まりが無い）
      if (isOldRule) {
        const noteOn = !!OLD_RULE_BELOW_WORKED_DAYS_NOTE_FROM_YM && ym >= OLD_RULE_BELOW_WORKED_DAYS_NOTE_FROM_YM
        if (noteOn && wm._oldRuleDayRate && wm.salaryNetPay !== undefined) {
          const floor = ceilYen(wm._oldRuleDayRate * workedDays) + (wm.additionalAllowance || 0)  // 旧ルールの additionalAllowance は休業補償
          const core = wm.salaryNetPay - (wm.otAllowance || 0) - (wm.breakShortenAllowance || 0)
            - (wm.siteAllowance || 0) - (wm.driveAllowance || 0)
          if (core < floor - 1) {
            note(wm, 'belowWorkedDays',
              `支給額（残業・手当を除く ${core.toLocaleString()}円）が「日給 ${Math.round(wm._oldRuleDayRate).toLocaleString()}円 × 働いた日数（${workedLabel}）＋休業補償 ＝ ${floor.toLocaleString()}円」を ${(floor - core).toLocaleString()}円 下回っています（月途中の入社・退職・帰国の暦日按分、または欠勤控除が大きいため）。代表に確認してください`,
              floor - core)
          }
        }
      } else if (isJpMonthly && wm.salaryNetPay !== undefined && wm.basePay !== undefined && (wm.salary ?? 0) > 0 && wm.basePay < (wm.salary ?? 0)) {
        // 月途中の入社・退職（基本給が月給より少ない月）だけ。1日あたりは欠勤控除と同じ 月給÷20.83日
        const dayRate = (wm.salary ?? 0) / JP_AVG_MONTHLY_WORK_DAYS
        const floor = ceilYen(dayRate * workedDays)
        const core = wm.basePay - (wm.absentDeduction || 0)
        if (core < floor - 1) {
          note(wm, 'belowWorkedDays',
            `月途中の入社・退職の暦日按分で、基本給 ${core.toLocaleString()}円（控除後）が「月給÷20.83日 × 働いた日数（${workedLabel}）＝ ${floor.toLocaleString()}円」を ${(floor - core).toLocaleString()}円 下回っています。代表に確認してください`,
            floor - core)
        }
      }

      // ② 日本人（役員以外）: 週40時間を超える週（月〜土の出勤×8h。残業欄は別に1.25倍で払っている）
      //    2026-10-03 代表決定で当面出さない（JP_WEEK_OVER40_NOTE_FROM_YM = null。再開は定数に開始月を入れる）
      if (JP_WEEK_OVER40_NOTE_FROM_YM && ym >= JP_WEEK_OVER40_NOTE_FROM_YM && (isJpDaily || isJpMonthly) && wm._jpDayHours && wm._jpDayHours.size > 0) {
        const firstMondayOffset = (new Date(yN, mN - 1, 1).getDay() + 6) % 7
        const weekHours = new Map<number, number>()
        for (const [d, h] of wm._jpDayHours) {
          // 8〜9月分は日曜を法定休日として別枠で払っているので週の時間に入れない
          if (jpSundayPremiumApplies(ym) && new Date(yN, mN - 1, d).getDay() === 0) continue
          const wk = Math.floor((d - 1 + firstMondayOffset) / 7)
          weekHours.set(wk, (weekHours.get(wk) || 0) + h)
        }
        let weeks = 0, excess = 0
        for (const h of weekHours.values()) if (h > 40) { weeks++; excess += h - 40 }
        if (excess > 0) {
          const hourly = isJpMonthly ? (wm.salary ?? 0) / JP_SALARY_AVG_MONTHLY_HOURS : wm.rate / JP_PRESCRIBED_HOURS_PER_DAY
          const est = ceilYen(ceilYen(hourly * 0.25) * excess)
          note(wm, 'jpWeekOver40',
            `週40時間を超える週が ${weeks}週・計 ${excess}時間 あります（月〜土の出勤×8h。月をまたぐ週は数えていません）。この分の割増 0.25倍（目安 ${est.toLocaleString()}円）は支給額に入れていません。日本人に変形労働時間制の定めが無ければ必要です（社労士に確認）`,
            est)
        }
      }

      // ③ 旧ルール: 日曜の出勤・夜勤・所定を超える出勤は支給額に入らない
      if (isOldRule) {
        const parts: string[] = []
        const sun = wm._sundayWorkDays ? [...wm._sundayWorkDays].sort((a, b) => a - b) : []
        if (sun.length > 0) parts.push(`日曜の出勤 ${sun.length}日（${sun.join('・')}日）`)
        if ((wm.nightShiftDays || 0) > 0) parts.push(`夜勤 ${wm.nightShiftDays}回`)
        const prescribed = wm.workerPrescribedDays || 0
        const over = prescribed > 0 ? Math.round((workedDays + wm.compDays - prescribed) * 10) / 10 : 0
        if (over > 0) parts.push(`所定 ${prescribed}日 を超える出勤 ${over}日`)
        if (parts.length > 0) {
          note(wm, 'oldRuleExtraWork',
            `${parts.join('・')} があります。旧契約（固定月給・所定日数）の計算では、日曜の割増（1.35倍）・深夜の割増（0.25倍）・夜勤の時間・所定を超えた日の賃金は支給額に入っていません。手計算で足すか代表に確認してください`)
        }
      }

      // ④ 日本人月給制（役員以外）: 土曜・日曜の出勤は月給に含まれる扱いで加算されない
      if (isJpMonthly && wm._jpWorkedDays) {
        const off: number[] = []
        for (const d of wm._jpWorkedDays) {
          if (d < 1 || d > dimN) continue
          const dw = new Date(yN, mN - 1, d).getDay()
          if (dw === 6 || (dw === 0 && !jpSundayPremiumApplies(ym))) off.push(d)
        }
        if (off.length > 0) {
          off.sort((a, b) => a - b)
          note(wm, 'jpMonthlyOffDayWork',
            `土曜・日曜の出勤が ${off.length}日（${off.join('・')}日）あります。月給制のため加算していません。休日出勤なら別に支払いが必要です（代表に確認）`)
        }
      }
    }
  }

  // 未対応ブランチで黙って無視されるのを防ぐ（対応は固定月給ブランチ（旧ルール=フン 104、新ルール=フォン 207・タン 208）。時給制は未対応）
  for (const wm of workerMap.values()) {
    if ((wm.breakShortenHours || 0) > 0 && wm.breakShortenAllowance === undefined) {
      console.error(
        `[compute] 休憩短縮手当が未対応の給与区分です: ${wm.name} (${ym})。` +
        `設定は固定月給（salary）のスタッフにのみ対応しています。人員マスタの設定を確認してください。`
      )
    }
  }

  // 原価＝実際の支給額に統一（ベトナム人 + 日本人完全月給）。
  //   - worker の totalCost を「実支給額(salaryNetPay)」に上書き（旧: 日数×日額+残業概算）。
  //   - site.cost へは支給額を出勤日数比で配賦（エントリループでは積んでいない）。
  //   - 出勤実績のない月（全休等）でも給与は発生するため、配置現場の先頭へ計上する。
  //   ※ 日本人日給月給は対象外（totalCost=日数×日額=支給額 で既に一致・エントリ加算済み）。
  // 出向の判定は compute・calcTobiEquiv と同じ決まり（人ごとの dispatchTo ＋ 現場ごとの dispatch 配列・2026-10-02 総合点検）。
  //   人ごとの出向（wm.isDispatched）は支給額の全部、現場ごとの出向はその現場に配賦した分だけを出向控除にする。
  //   旧: 人ごとの dispatchTo だけを見ていたので、現場の dispatch 配列にだけ入っている人の原価が引かれなかった
  const isDispatchedHere = createDispatchChecker(main)
  for (const wm of workerMap.values()) {
    // 2026-09-02: 全員を実支給ベースで配賦（上のエントリループと対）
    // 実際の支給額。salaryNetPay 優先、無ければ netPay。
    const pay = (wm.salaryNetPay ?? wm.netPay ?? 0)
    wm.cost = pay
    wm.otCost = 0
    wm.totalCost = pay
    if (wm.isDispatched) wm.dispatchDeduction = pay
    if (pay <= 0) continue
    const dayMap = payrollSiteDays.get(wm.id)
    const totalDays = dayMap ? Array.from(dayMap.values()).reduce((a, b) => a + b, 0) : 0
    let siteDeduction = 0
    if (dayMap && totalDays > 0) {
      const rows = Array.from(dayMap.entries())
      let allocated = 0
      rows.forEach(([sid, days], i) => {
        const site = siteMap.get(sid)
        if (!site) return
        // 端数は最後の現場で吸収して合計＝支給額に一致させる
        const share = i === rows.length - 1 ? (pay - allocated) : Math.round(pay * days / totalDays)
        site.cost += share
        allocated += share
        if (wm.isDispatched || isDispatchedHere(wm.id, sid, ym)) {
          site.dispatchDeduction = (site.dispatchDeduction || 0) + share
          siteDeduction += share
        }
      })
    } else if (wm.sites.length > 0) {
      const site = siteMap.get(wm.sites[0])
      if (site) {
        site.cost += pay
        if (wm.isDispatched || isDispatchedHere(wm.id, wm.sites[0], ym)) {
          site.dispatchDeduction = (site.dispatchDeduction || 0) + pay
          siteDeduction += pay
        }
      }
    }
    // 現場ごとの出向だけの人: 控除はその現場に配賦した分（人ごとの出向は上で支給額の全部にしてある）
    if (!wm.isDispatched && siteDeduction > 0) wm.dispatchDeduction = siteDeduction
  }

  // Subcon costs はエントリループで現場別単価(getSubconRate)により積み上げ済み
  // （2026-06-12 監査修正: 旧 workDays×基本単価の一括計算を廃止 — オーバーライド非対応だった）

  // Billing & profit
  // 出向者の人件費のみ差引（売上は既に控除済みの値が入力されているためそのまま）
  for (const site of siteMap.values()) {
    const billingKey = `${site.id}_${ym}`
    const billings = main.billing[billingKey] || []
    site.billing = billings.reduce((sum, v) => sum + (v || 0), 0)
    const dd = site.dispatchDeduction || 0
    // 人件費のみ出向控除（売上はそのまま → 粗利は増える方向）
    site.cost = Math.max(0, site.cost - dd)
    site.profit = site.billing - site.cost - site.subCost
    site.profitRate = site.billing > 0 ? (site.profit / site.billing) * 100 : 0
  }

  // Round
  const r1 = (v: number) => Math.round(v * 10) / 10
  const r0 = (v: number) => Math.round(v)

  // 2026-06-XX 修正: 月給制日本人・月給制外国人はゼロ出勤月でも表示する
  //   理由: 月給制は基本給が固定で支払われるため、出勤ゼロでも給与明細に出さないと
  //         労基法24条（賃金全額払い）違反になる。
  //   従来: w.workDays > 0 || w.plDays > 0 || w.compDays > 0 のいずれかが必要だった
  //   → これだと月給制スタッフが「丸ごと有給の月」「丸ごと欠勤の月」に画面から消えていた
  //   2026-07-18: 当月まるごと帰国中(hkDays>0)のスタッフも表示する（給与は0だが
  //     「帰国中」を明示して奥寺さんが欠勤と誤認しないようにする）。
  const workers = Array.from(workerMap.values()).filter(w =>
    w.workDays > 0 || w.plDays > 0 || w.compDays > 0 ||
    w.examDays > 0 ||  // 試験のみの月も表示（欠勤控除対象外＝基本給が出るのに一覧から消えていた 2026-08-27）
    (w.hkDays !== undefined && w.hkDays > 0) ||
    (w.salary !== undefined && w.salary > 0)
  )
  workers.forEach(w => {
    w.workDays = r1(w.workDays); w.workAll = r1(w.workAll); w.otHours = r1(w.otHours)
    w.cost = r0(w.cost); w.otCost = r0(w.otCost); w.totalCost = r0(w.totalCost)
    w.absentCost = r0(w.absentCost); w.netPay = r0(w.netPay)
    if (w.dispatchDeduction !== undefined) w.dispatchDeduction = r0(w.dispatchDeduction)
  })

  const subcons = Array.from(subconMap.values()).filter(sc => sc.workDays > 0)
  subcons.forEach(sc => { sc.workDays = r1(sc.workDays); sc.cost = r0(sc.cost) })

  const sites = Array.from(siteMap.values())
  sites.forEach(s => {
    s.workDays = r1(s.workDays); s.subWorkDays = r1(s.subWorkDays); s.otHours = r1(s.otHours)
    s.cost = r0(s.cost); s.subCost = r0(s.subCost); s.profit = r0(s.profit); s.profitRate = r1(s.profitRate)
    if (s.dispatchDeduction !== undefined) s.dispatchDeduction = r0(s.dispatchDeduction)
  })

  // 合計人件費は出向控除を引いた値（KPI整合のため）
  const totalDispatchDeduction = workers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
  const rawTotalCost = workers.reduce((s, w) => s + w.totalCost, 0)
  const totals = {
    workDays: r1(workers.reduce((s, w) => s + w.workDays, 0)),
    subWorkDays: r1(subcons.reduce((s, sc) => s + sc.workDays, 0)),
    cost: r0(rawTotalCost - totalDispatchDeduction),  // 出向控除済み
    subCost: r0(subcons.reduce((s, sc) => s + sc.cost, 0)),
    billing: r0(sites.reduce((s, st) => s + st.billing, 0)),  // sites.billing は既に控除済み
    profit: r0(sites.reduce((s, st) => s + st.profit, 0)),
    otHours: r1(workers.reduce((s, w) => s + w.otHours, 0)),
  }

  return { workers, subcons, sites, totals }
}

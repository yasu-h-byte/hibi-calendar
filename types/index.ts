export interface Worker {
  id: number
  name: string
  nameVi?: string
  company: string // '日比' | 'HFU'
  visaType: string
  token: string
  jobType?: string // '役員' | '職長' | 'とび' | '土工'
  rate?: number
  hourlyRate?: number
  otMul?: number
  hireDate?: string
  retired?: string
  salary?: number
  visaExpiry?: string // 在留期限 YYYY-MM-DD
  dispatchTo?: string // 出向先名（空なら通常勤務、値あり=出向中）
  dispatchFrom?: string // 出向開始月 YYYY-MM（空なら全期間出向扱い）
  /**
   * 旧ルール（変形労働時間制導入前）の給与計算を継続使用するフラグ。
   * 2026-05 から全員新ルール（3層構造給与）に移行したが、本人が移行を拒否したケース等で
   * 個別に旧ルールを継続するために使う。退職時に retired を設定すれば自動的に対象外になる。
   * 既定: 未設定（false 相当）= 5月以降は新ルール
   */
  useOldRules?: boolean
  /**
   * 日本人社員の号俸制（docs/wage-system.md）の現在位置。
   * jpGrade: '1G'〜'6G' または 'doko'（土工）。jpStep: 号数(1〜60)。
   * 年1回の改定でシステムが更新する。外国人スタッフ（visaType≠'none'）は対象外。
   * 詳細ロジックは lib/jp-wage.ts。
   */
  jpGrade?: string
  jpStep?: number
}

/** 現場の勤務時間設定（始業・終業・休憩構成） */
export interface SiteBreak {
  enabled: boolean      // この休憩を運用する現場か（false=スマホ画面で非表示）
  minutes: number       // 休憩時間（分）
  mandatory: boolean    // true=必ず取得（スタッフ画面で変更不可）/ false=任意
}

export interface SiteWorkSchedule {
  startTime: string             // 始業時刻 'HH:MM' (例: '08:00', '07:30')
  endTime: string               // 終業時刻 'HH:MM' (例: '17:00', '17:30')
  morningBreak: SiteBreak       // 午前休憩
  lunchBreak: SiteBreak         // 昼休憩
  afternoonBreak: SiteBreak     // 午後休憩
}

/** 既存現場用のデフォルト勤務時間（workSchedule未設定の場合に補完される値） */
export const DEFAULT_WORK_SCHEDULE: SiteWorkSchedule = {
  startTime: '08:00',
  endTime: '17:00',
  morningBreak:   { enabled: true, minutes: 30, mandatory: false },
  lunchBreak:     { enabled: true, minutes: 60, mandatory: true },
  afternoonBreak: { enabled: true, minutes: 30, mandatory: false },
}

export interface Site {
  id: string
  name: string
  start: string
  end: string
  foreman: number
  archived: boolean
  workSchedule?: SiteWorkSchedule  // 未設定なら DEFAULT_WORK_SCHEDULE が適用される
  /**
   * シフト種別（明示指定）。未設定の場合は workSchedule.startTime / 名前 / ID から自動判定。
   * detectMultiSiteConflict で同日同種シフトの重複を防ぐために使用。
   */
  shiftType?: 'day' | 'night'
}

export interface SiteAssign {
  workers: number[]
  subcons: string[]
}

export type DayType = 'work' | 'off' | 'holiday'

export type CalendarStatus = 'draft' | 'submitted' | 'approved' | 'rejected'

export interface SiteCalendar {
  siteId: string
  ym: string
  days: Record<string, DayType>
  status: CalendarStatus
  submittedAt: string | null
  submittedBy: number | null
  approvedAt: string | null
  approvedBy: number | null
  rejectedReason: string | null
  updatedAt: string
  updatedBy: number
}

export interface CalendarSign {
  workerId: number
  ym: string
  siteId: string
  signedAt: string
  method: 'tap'
  ipHash: string
}

export interface CalendarDay {
  date: Date
  day: number
  dayType: DayType
  label: string
  labelVi: string
  holidayName?: string
  holidayNameVi?: string
}

export type UserRole = 'admin' | 'approver' | 'foreman' | 'jimu'

export interface AuthUser {
  workerId: number
  name: string
  role: UserRole
  foremanSites: string[] // site IDs where this user is foreman
  token?: string
}

// 出面データ
export interface AttendanceEntry {
  w: number       // 1=出勤, 0=不在 (レガシー: 202604以前)
  o?: number      // 残業時間 (0.5〜8) (レガシー: 202604以前)
  r?: number      // 1=欠勤（出勤日に休む場合）
  hk?: number     // 1=帰国中
  rReason?: string // 欠勤理由（'sick' | 'hospital' | 'personal' | 'family' | 'homeCountry' | 'other'）
  rNote?: string   // 補足（「その他」の場合のみ）
  p?: number      // 1=有給
  h?: number      // 1=現場休み
  exam?: number   // 1=試験（実習生の年次試験など。現場出勤にはカウントしないが、給与計算では出勤と同等扱い）
  s?: string      // 'staff' | 'foreman' | 'admin'
  // ── 時間ベース入力（202605〜）──
  st?: string     // 始業時間 "HH:MM" (例: "08:00")
  et?: string     // 終業時間 "HH:MM" (例: "17:00", "19:30")
  b1?: number     // 午前休憩（10:00-10:30）: 1=取得, 0=未取得
  b2?: number     // 昼休み（12:00-13:00）: 1=取得, 0=未取得
  b3?: number     // 午後休憩（15:00-15:30）: 1=取得, 0=未取得
  // ── 夜勤ブロック（202608〜）──
  // 台風待機など、日勤とは別枠で発生する夜勤を1エントリ内に持つ。
  // 「日勤で働いてそのまま夜間現場待機」というケースがあるため、st/et（日勤）とは
  // 独立した時刻フィールドを持たせている。年に数回のレアケース。
  //
  // ⚠️ w（出勤日数）は夜勤があっても 1 のまま。w を 1.5 にすると workDays が
  //    1.5日になり、欠勤判定（所定日数 − 出勤日数）が壊れる。
  //    人工（日本人の 1.5人工 慣例）は ns から導出する。
  ns?: number     // 1 = この日に夜勤あり
  nonly?: number  // 1 = その日は夜勤のみ（日勤なし）。日勤＋夜勤なら未設定
  nst?: string    // 夜勤の始業 "20:00"（夜勤のみの日でも必ずここに入れる。st/et は空にする）
  net?: string    // 夜勤の終業 "29:00" ← 24時超え表記（=翌5:00）
  nb?: number     // 夜勤中の休憩（分）。既定 NIGHT_DEFAULT_BREAK_MIN
  nnote?: string  // 夜勤の理由「台風待機」等
}

/** 夜勤の既定休憩時間（分） */
export const NIGHT_DEFAULT_BREAK_MIN = 60

/** 日本人の夜勤1回あたりの人工（慣例: 1.5人工。元請け請求も同率） */
export const NIGHT_SHIFT_MANDAYS = 1.5

// ────────────────────────────────────────
//  出面入力の時刻選択肢（PC グリッド / スマホ で共用）
// ────────────────────────────────────────

/** "H:MM" の連番を 30 分刻みで生成（fromMin/toMin は 0:00 起点の分。24時超えも可） */
function buildTimeOptions(fromMin: number, toMin: number): string[] {
  const opts: string[] = []
  for (let m = fromMin; m <= toMin; m += 30) {
    opts.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return opts
}

/** 日勤の始業 5:00〜13:00 */
export const DAY_START_OPTIONS = buildTimeOptions(5 * 60, 13 * 60)
/** 日勤の終業 15:00〜23:00 */
export const DAY_END_OPTIONS = buildTimeOptions(15 * 60, 23 * 60)
/** 夜勤の始業 15:00〜23:30（日勤の続きで入る待機にも対応するため夕方から） */
export const NIGHT_START_OPTIONS = buildTimeOptions(15 * 60, 23 * 60 + 30)
/**
 * 夜勤の終業 20:00〜翌9:00。
 * 24時以降は "24:00"〜"33:00" の24時超え表記で保存する（表示は formatTimeLabel で「翌5:00」）。
 * こうすると timeToMinutes が単調増加になり、calcDayShiftHours / calcNightMinutes が
 * 日付またぎ補正なしで正しく動く。
 */
export const NIGHT_END_OPTIONS = buildTimeOptions(20 * 60, 33 * 60)

/** 時間ベース入力かどうかを判定（202605以降のデータ） */
export function isTimeBasedEntry(entry: AttendanceEntry): boolean {
  return !!(entry.st && entry.et)
}

/**
 * 時間文字列 "HH:MM" を分に変換。
 * 夜勤の日付またぎは "29:00"（=翌5:00）のような24時超え表記で保存するため、
 * h が 24 以上でもそのまま分換算する（"29:00" → 1740）。
 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** 24時超え表記を画面用ラベルに変換。"29:00" → "翌5:00" / "17:00" → "17:00" */
export function formatTimeLabel(time: string): string {
  const min = timeToMinutes(time)
  if (min < 24 * 60) return time
  const h = Math.floor(min / 60) - 24
  return `翌${h}:${String(min % 60).padStart(2, '0')}`
}

/** 夜勤として登録された日か（1.5人工の対象判定。深夜割増の判定とは別物） */
export function isNightShift(entry: AttendanceEntry | null | undefined): boolean {
  return !!(entry && entry.ns)
}

/**
 * 夜勤ブロックの時刻レンジを返す。夜勤が無ければ null。
 *
 * ⚠️ 夜勤の時刻は「夜勤のみの日」でも必ず nst/net に入れる。st/et へのフォールバックは
 *    設けない — st/et を夜勤にも流用すると日勤ブロックと二重計上になる。
 *    夜勤のみの日は st/et を空にし、nst/net だけを持つ。
 */
export function getNightRange(entry: AttendanceEntry): { start: string; end: string } | null {
  if (!entry.ns || !entry.nst || !entry.net) return null
  return { start: entry.nst, end: entry.net }
}

/** 夜勤ブロックの実労働時間（h）。休憩を差し引く */
export function calcNightShiftHours(entry: AttendanceEntry): number {
  const range = getNightRange(entry)
  if (!range) return 0
  const start = timeToMinutes(range.start)
  let end = timeToMinutes(range.end)
  if (end <= start) end += 24 * 60  // 24時超え表記でない旧/手入力データへの防御
  const breakMin = entry.nb ?? NIGHT_DEFAULT_BREAK_MIN
  return Math.max(0, Math.round((end - start - breakMin) / 60 * 10) / 10)
}

/**
 * その日の人工数（にんく）。日本人の支給と元請け請求の基礎になる。
 *   日勤のみ   : w のまま（1 / 0.5 / 0.6補償）
 *   夜勤のみ   : 1.5
 *   日勤＋夜勤 : 1 + 1.5 = 2.5
 * 有給・欠勤・現場休・帰国中・試験は 0（出面としての人工は発生しない）。
 */
export function calcManDays(entry: AttendanceEntry | null | undefined): number {
  if (!entry) return 0
  if (entry.p || entry.r || entry.h || entry.hk || entry.exam) return 0
  // ⚠️ 日勤の有無は nonly フラグで判定する。st/et の有無では判定できない —
  //    日本人は日給月給で st/et を記録しないため、「日勤＋夜勤」でも時刻が空になる。
  const dayPart = entry.nonly ? 0 : (entry.w || 0)
  const nightPart = entry.ns ? NIGHT_SHIFT_MANDAYS : 0
  return Math.round((dayPart + nightPart) * 100) / 100
}

/**
 * 時間ベースエントリの実労働時間（h）を計算。日勤＋夜勤の合計を返す。
 * @param entry 出面エントリ
 * @param workSchedule 現場の勤務時間設定（未指定なら 30/60/30 分のデフォルト休憩）
 */
export function calcActualHours(entry: AttendanceEntry, workSchedule?: SiteWorkSchedule): number {
  const total = calcDayShiftHours(entry, workSchedule) + calcNightShiftHours(entry)
  return Math.round(total * 10) / 10
}

/**
 * 日勤ブロック（st/et）の実労働時間（h）。夜勤ブロックは含まない。
 * 夜勤のみの日（nonly）は 0 を返す — 実労働は夜勤ブロック側で数える。
 */
export function calcDayShiftHours(entry: AttendanceEntry, workSchedule?: SiteWorkSchedule): number {
  if (entry.nonly) return 0
  if (!entry.st || !entry.et) return entry.w === 0.6 ? 4.2 : (entry.w || 0) * 7
  const start = timeToMinutes(entry.st)
  let end = timeToMinutes(entry.et)
  // 日付またぎ防御: 終業は "29:00"（=翌5:00）形式で保存するのが正だが、
  // 手入力や旧データで "05:00" のように24時未満で入っている場合も翌日として扱う。
  // この補正が無いと end - start が負になり実労働 0h に落ち、
  // 「実労働0h・深夜7h」という矛盾した給与計算になる（calcNightMinutes 側は
  // 日付またぎ対応済みのため深夜手当だけが出てしまう）。
  if (end <= start) end += 24 * 60
  let totalMinutes = end - start
  // 休憩を引く（取得した分のみ）— 現場の workSchedule に従う
  const ws = workSchedule
  const morningMin   = ws?.morningBreak?.enabled === false   ? 0 : (ws?.morningBreak?.minutes   ?? 30)
  const lunchMin     = ws?.lunchBreak?.enabled === false     ? 0 : (ws?.lunchBreak?.minutes     ?? 60)
  const afternoonMin = ws?.afternoonBreak?.enabled === false ? 0 : (ws?.afternoonBreak?.minutes ?? 30)
  if (entry.b1) totalMinutes -= morningMin
  if (entry.b2) totalMinutes -= lunchMin
  if (entry.b3) totalMinutes -= afternoonMin
  return Math.max(0, Math.round(totalMinutes / 60 * 10) / 10)
}

/**
 * 時間ベースエントリの残業時間（所定7hを超えた分）を計算
 * @param entry 出面エントリ
 * @param workSchedule 現場の勤務時間設定
 */
export function calcOvertimeHours(entry: AttendanceEntry, workSchedule?: SiteWorkSchedule): number {
  if (!entry.st || !entry.et) return entry.o || 0
  const actual = calcActualHours(entry, workSchedule)
  return Math.max(0, Math.round((actual - 7) * 10) / 10)
}

/** PC出面入力が時間ベースかどうか（5月以降） */
export function isTimeBasedMonth(ym: string): boolean {
  return ym >= '202605'
}

/** スマホ入力が時間ベースかどうか（説明会確認のため即時有効） */
export function isTimeBasedMobile(ym: string): boolean {
  return ym >= '202604'
}

export type AttendanceStatus = 'work' | 'overtime' | 'rest' | 'leave' | 'site_off' | 'home_leave' | 'exam' | 'none'

/**
 * 出面の2段階承認データ
 * - foreman: 職長による1次承認（現場レベルの確認）
 * - final:   最終承認（事業責任者・管理者による日次確定）
 *
 * 運用ルール: 最終承認は「職長承認後のみ」可能。職長承認を解除すると
 * 最終承認も自動的に意味を失う（解除する側で final も同時に外すこと）。
 */
export interface AttendanceApproval {
  foreman?: { by: number; at: string }
  final?: { by: number; at: string }
}

// ── HR Evaluation ──

export type ABCGrade = 'A' | 'B' | 'C'
export type EvaluationStatus = 'draft' | 'submitted' | 'approved'
export type EvaluationSessionStatus = 'collecting' | 'reviewing' | 'approved'
export type EvaluationRank = 'S' | 'A' | 'B' | 'C' | 'D'

export interface EvaluationScores {
  japanese: { understanding: ABCGrade; reporting: ABCGrade; safety: ABCGrade }
  attitude: { punctuality: ABCGrade; safetyAwareness: ABCGrade; teamwork: ABCGrade; compliance: ABCGrade }
  skill: { level: ABCGrade; speed: ABCGrade; planning: ABCGrade }
  living: { neighborCare: ABCGrade; ruleCompliance: ABCGrade; cleanliness: ABCGrade }
}

export interface EvaluationMetrics {
  attendanceRate: number      // 出勤率 0〜100（上限100%キャップ）
  overtimeAvg: number         // 残業平均 (h/月)
  plUsage: number             // 有給日数（後方互換のため残存）
  attendanceBonus: number     // 0〜3

  // ── 詳細内訳（2026-05-09 追加、optional は旧データ互換のため） ──
  rawRate?: number            // キャップ前の生比率（参考）
  workedDays?: number         // 実出勤日（補償除く、partial honor）
  presentDays?: number        // 出勤扱い合計 = workedDays + plDays + examDays
  plDays?: number             // 有給日数（plUsage と同値、命名統一）
  examDays?: number           // 試験日数
  restDays?: number           // 欠勤日数
  homeLeaveDays?: number      // 帰国扱い日数（出面に hk フラグが立つ日）
  siteOffDays?: number        // 現場休日数
  compensationDays?: number   // 補償日（土曜 w=0.6）数
  totalOvertime?: number      // 残業合計時間
  prescribedTotal?: number    // 月所定日数の合計（フォールバック含む）
  applicablePrescribed?: number  // 期待出勤日数（除外後）
  excludedDays?: {
    beforeHire: number        // 雇用前で除外した日
    afterRetire: number       // 退職後で除外した日
    homeLeave: number         // 一時帰国期間で除外した日
    longAbsence: number       // 14日以上連続無出勤で除外した日
  }
  computedAt?: string         // 計算日時（ISO）
}

/** 個別評価者のレビュー */
export interface EvaluationReview {
  evaluatorId: number
  evaluatorName: string
  scores: EvaluationScores
  comment: string
  submittedAt: string
}

/**
 * 評価者ウェイト（共働実績に基づく多数決重み付け）
 *
 * セッション作成時に対象スタッフの過去出勤データから算出。
 * 直近で実際に一緒に現場に居た職長の意見ほど多数決プリフィルで強く反映される。
 * admin/approver は事業責任者として常時 1.0。
 */
export interface EvaluatorWeightInfo {
  evaluatorId: number
  recentDays: number    // 直近90日の共働日数
  yearDays: number      // 過去365日の共働日数
  recentPct: number     // 0〜100 (recentDays/60の比率を整数化)
  yearPct: number       // 0〜100 (yearDays/dynamicCapの比率を整数化)
  weight: number        // 0.3〜1.0
  isApprover: boolean   // 事業責任者として 1.0 固定か
  /**
   * 動的キャップ情報（2026-05-12 追加）
   * 旧システム稼働前の att データ欠落に対応するため、データのある月数に
   * 応じて 200日キャップを按分する。
   */
  monthsWithData?: number  // 過去365日のうち att データのある月数（0〜12）
  dynamicCap?: number      // yearDays に適用するキャップ（max(20, 200×monthsWithData/12)）
}

/** 評価セッション（1スタッフ×1評価期間、複数評価者対応） */
export interface Evaluation {
  id: string                    // workerId_evaluationDate
  workerId: number
  workerName: string
  evaluationDate: string        // YYYY-MM-DD (入社日基準の評価日)
  status: EvaluationSessionStatus  // collecting → reviewing → approved

  // 複数評価者の個別レビュー
  reviews: EvaluationReview[]
  // 評価予定者リスト（全員提出するまで collecting）
  evaluatorIds: number[]

  // 政仁さんの最終評価（承認時に確定）
  finalScores?: EvaluationScores
  finalComment?: string

  // 自動集計
  metrics: EvaluationMetrics

  // 評価者ウェイト（共働実績に基づく多数決重み付け）
  // セッション作成時に算出。recalculateWeights API で後から更新可能。
  // 古いセッションには存在しないので、UI 側は { weight: 1.0 } をフォールバックとして扱う。
  evaluatorWeights?: Record<number, EvaluatorWeightInfo>

  // 最終スコア計算結果（承認後に確定）
  manualScore?: number           // 重み付き（最大33.3）
  totalScore?: number            // manualScore + attendanceBonus（最大36.3）
  rank?: EvaluationRank

  // 承認
  approvedBy?: number
  approvedAt?: string
  yearsFromHire: number
  raiseAmount?: number          // 昇給額（円/h）

  createdAt: string
  updatedAt: string
}

/** 後方互換: 旧形式の単一評価者Evaluation */
export interface EvaluationLegacy {
  id: string
  workerId: number
  workerName: string
  evaluationDate: string
  evaluatorId: number
  evaluatorName: string
  status: EvaluationStatus
  scores: EvaluationScores
  comment: string
  metrics: EvaluationMetrics
  manualScore: number
  totalScore: number
  rank: EvaluationRank
  approvedBy?: number
  approvedAt?: string
  yearsFromHire: number
  raiseAmount?: number
  createdAt: string
  updatedAt: string
}

export interface EvaluationWeights {
  japanese: number    // default 1.0
  attitude: number    // default 1.5
  skill: number       // default 1.2
}

export interface RaiseTableRow {
  year: number        // 1〜6（6=6年目以降）
  S: number
  A: number
  B: number
  C: number
}

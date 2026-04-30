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
}

/** 時間ベース入力かどうかを判定（202605以降のデータ） */
export function isTimeBasedEntry(entry: AttendanceEntry): boolean {
  return !!(entry.st && entry.et)
}

/** 時間文字列 "HH:MM" を分に変換 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** 時間ベースエントリの実労働時間（h）を計算 */
export function calcActualHours(entry: AttendanceEntry): number {
  if (!entry.st || !entry.et) return entry.w === 0.6 ? 4.2 : (entry.w || 0) * 7
  const start = timeToMinutes(entry.st)
  const end = timeToMinutes(entry.et)
  let totalMinutes = end - start
  // 休憩を引く（取得した分のみ）
  if (entry.b1) totalMinutes -= 30  // 10:00-10:30
  if (entry.b2) totalMinutes -= 60  // 12:00-13:00
  if (entry.b3) totalMinutes -= 30  // 15:00-15:30
  return Math.max(0, Math.round(totalMinutes / 60 * 10) / 10)
}

/** 時間ベースエントリの残業時間（所定7hを超えた分）を計算 */
export function calcOvertimeHours(entry: AttendanceEntry): number {
  if (!entry.st || !entry.et) return entry.o || 0
  const actual = calcActualHours(entry)
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

export type AttendanceStatus = 'work' | 'overtime' | 'rest' | 'leave' | 'site_off' | 'none'

export interface AttendanceApproval {
  foreman?: { by: number; at: string }
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
  attendanceRate: number
  overtimeAvg: number
  plUsage: number
  attendanceBonus: number  // 0-3
}

/** 個別評価者のレビュー */
export interface EvaluationReview {
  evaluatorId: number
  evaluatorName: string
  scores: EvaluationScores
  comment: string
  submittedAt: string
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

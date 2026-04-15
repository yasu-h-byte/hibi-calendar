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

export interface Site {
  id: string
  name: string
  start: string
  end: string
  foreman: number
  archived: boolean
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
  w: number       // 1=出勤, 0=不在
  o?: number      // 残業時間 (0.5〜8)
  r?: number      // 1=休み
  p?: number      // 1=有給
  h?: number      // 1=現場休み
  s?: string      // 'staff' | 'foreman' | 'admin'
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
  attitude: { punctuality: ABCGrade; safetyAwareness: ABCGrade; teamwork: ABCGrade }
  skill: { level: ABCGrade; speed: ABCGrade; planning: ABCGrade }
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

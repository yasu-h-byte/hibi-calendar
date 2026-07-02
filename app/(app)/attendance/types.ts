// 出面入力画面で共有する型定義

export interface SiteOption {
  id: string
  name: string
  foreman?: number
  foremanName?: string
  foremanNote?: string
}

export interface Worker {
  id: number
  name: string
  org: string
  visa: string
  job: string
  retired?: string  // YYYY-MM-DD 退職日（バッジ表示用）
  useOldRules?: boolean  // 旧契約継続者（フン等）。出面UIをレガシー（日数+残業+0.6補）にする
}

// 退職予定リスト用（3ヶ月以内）
export interface UpcomingRetirement {
  id: number
  name: string
  org: string
  visa: string
  retired: string  // YYYY-MM-DD
}

export interface Subcon {
  id: string
  name: string
  type: string
}

export interface AttEntry {
  w: number
  o?: number
  r?: number
  p?: number
  h?: number
  hk?: number   // 1=帰国中
  exam?: number // 1=試験（現場出勤にカウントしないが給与計算では出勤扱い）
  s?: string
  // 時間ベース入力（202605〜）
  st?: string   // 始業 "HH:MM"
  et?: string   // 終業 "HH:MM"
  b1?: number   // 午前休憩 1/0
  b2?: number   // 昼休み 1/0
  b3?: number   // 午後休憩 1/0
}

export interface SubconDayEntry {
  n: number
  on: number
}

export type DayType = 'work' | 'off' | 'holiday'

export interface HomeLeaveInfo {
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
}

export interface GridData {
  site: SiteOption
  year: number
  month: number
  daysInMonth: number
  ym: string
  workers: Worker[]
  subcons: Subcon[]
  workerEntries: Record<string, Record<number, AttEntry>>
  subconEntries: Record<string, Record<number, SubconDayEntry>>
  locked: boolean
  approvals: Record<number, boolean>  // 後方互換: foreman 承認の有無 bool マップ
  foremanApprovals?: Record<number, { by: number; at: string }>
  finalApprovals?: Record<number, { by: number; at: string }>
  sites: SiteOption[]
  workDays: number | null
  siteWorkDays: number | null
  allWorkers: Worker[]
  allSubcons?: { id: string; name: string; type: string }[]
  foremanOverride: { name: string; note: string } | null
  calendarDays: Record<string, DayType> | null
  homeLeaves?: HomeLeaveInfo[]
  upcomingRetirements?: UpcomingRetirement[]
}

export interface PendingSave {
  type: 'worker' | 'subcon'
  id: string
  day: number
  entry: AttEntry | null
  subconEntry?: SubconDayEntry | null
}

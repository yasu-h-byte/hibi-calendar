export interface Worker {
  id: number
  name: string
  nameVi?: string
  company: string // '日比' | 'HFU'
  visaType: string
  token: string
  jobType?: string // '役員' | '職長' | 'とび' | '土工'
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

export type UserRole = 'admin' | 'approver' | 'foreman'

export interface AuthUser {
  workerId: number
  name: string
  role: UserRole
  foremanSites: string[] // site IDs where this user is foreman
}

export interface Worker {
  id: number
  name: string
  nameVi?: string
  company: string // '日比' | 'HFU'
  visaType: string
  token: string
}

export interface CalendarPattern {
  id: string // 'A' | 'B' | 'C'
  name: string
  nameVi: string
  saturdayWork: boolean
  saturdayAlt: boolean
  holidayOff: boolean
}

export interface WorkerCalendar {
  workerId: number
  ym: string // 'YYYY-MM'
  patternId: string
  assignedAt: string
  assignedBy: string
}

export interface CalendarSign {
  workerId: number
  ym: string // 'YYYY-MM'
  signedAt: string
  method: 'tap'
  ipHash: string
}

export type DayType = 'work' | 'off' | 'holiday'

export interface CalendarDay {
  date: Date
  dayType: DayType
  label: string
  labelVi: string
  holidayName?: string
  holidayNameVi?: string
}

import { CalendarDay, DayType } from '@/types'

// 2026年日本の祝日
const HOLIDAYS_2026: Record<string, { name: string; nameVi: string }> = {
  '2026-01-01': { name: '元日', nameVi: 'Tết Dương lịch' },
  '2026-01-12': { name: '成人の日', nameVi: 'Ngày Thành nhân' },
  '2026-02-11': { name: '建国記念の日', nameVi: 'Ngày Quốc khánh' },
  '2026-02-23': { name: '天皇誕生日', nameVi: 'Sinh nhật Nhật Hoàng' },
  '2026-03-20': { name: '春分の日', nameVi: 'Ngày Xuân phân' },
  '2026-04-29': { name: '昭和の日', nameVi: 'Ngày Chiêu Hòa' },
  '2026-05-03': { name: '憲法記念日', nameVi: 'Ngày Hiến pháp' },
  '2026-05-04': { name: 'みどりの日', nameVi: 'Ngày Xanh' },
  '2026-05-05': { name: 'こどもの日', nameVi: 'Ngày Thiếu nhi' },
  '2026-05-06': { name: '振替休日', nameVi: 'Ngày nghỉ bù' },
  '2026-07-20': { name: '海の日', nameVi: 'Ngày Biển' },
  '2026-08-11': { name: '山の日', nameVi: 'Ngày Núi' },
  '2026-09-21': { name: '敬老の日', nameVi: 'Ngày Kính lão' },
  '2026-09-22': { name: '国民の休日', nameVi: 'Ngày nghỉ Quốc dân' },
  '2026-09-23': { name: '秋分の日', nameVi: 'Ngày Thu phân' },
  '2026-10-12': { name: 'スポーツの日', nameVi: 'Ngày Thể thao' },
  '2026-11-03': { name: '文化の日', nameVi: 'Ngày Văn hóa' },
  '2026-11-23': { name: '勤労感謝の日', nameVi: 'Ngày Cảm ơn Lao động' },
}

function formatDateKey(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${year}-${m}-${d}`
}

export function getHoliday(year: number, month: number, day: number): { name: string; nameVi: string } | null {
  return HOLIDAYS_2026[formatDateKey(year, month, day)] || null
}

/**
 * Generate default days for a month:
 * - Weekdays = work
 * - Sundays = off
 * - Holidays = holiday
 */
export function generateDefaultDays(year: number, month: number): Record<string, DayType> {
  const days: Record<string, DayType> = {}
  const daysInMonth = new Date(year, month, 0).getDate()

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d)
    const dow = date.getDay()
    const holiday = getHoliday(year, month, d)

    if (holiday) {
      days[String(d)] = 'holiday'
    } else if (dow === 0) {
      days[String(d)] = 'off'
    } else {
      days[String(d)] = 'work'
    }
  }

  return days
}

/**
 * Build CalendarDay array from stored days record
 */
export function buildCalendarDays(year: number, month: number, days: Record<string, DayType>): CalendarDay[] {
  const result: CalendarDay[] = []
  const daysInMonth = new Date(year, month, 0).getDate()

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d)
    const dayType = days[String(d)] || 'work'
    const holiday = getHoliday(year, month, d)

    let label = '出勤'
    let labelVi = 'Đi làm'
    if (dayType === 'off') {
      label = '休み'
      labelVi = 'Nghỉ'
    } else if (dayType === 'holiday') {
      label = holiday?.name || '祝日'
      labelVi = holiday?.nameVi || 'Nghỉ lễ'
    }

    result.push({
      date,
      day: d,
      dayType,
      label,
      labelVi,
      holidayName: holiday?.name,
      holidayNameVi: holiday?.nameVi,
    })
  }

  return result
}

export function getNextMonth(): { year: number; month: number; ym: string } {
  const now = new Date()
  let year = now.getFullYear()
  let month = now.getMonth() + 2
  if (month > 12) {
    month = 1
    year++
  }
  return { year, month, ym: `${year}-${String(month).padStart(2, '0')}` }
}

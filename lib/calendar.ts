import { CalendarDay, CalendarPattern, DayType } from '@/types'

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

export const CALENDAR_PATTERNS: CalendarPattern[] = [
  {
    id: 'A',
    name: 'パターンA（土曜出勤）',
    nameVi: 'Mẫu A (Làm thứ 7)',
    saturdayWork: true,
    saturdayAlt: false,
    holidayOff: true,
  },
  {
    id: 'B',
    name: 'パターンB（隔週土曜）',
    nameVi: 'Mẫu B (Thứ 7 cách tuần)',
    saturdayWork: false,
    saturdayAlt: true,
    holidayOff: true,
  },
  {
    id: 'C',
    name: 'パターンC（土日休み）',
    nameVi: 'Mẫu C (Nghỉ thứ 7, CN)',
    saturdayWork: false,
    saturdayAlt: false,
    holidayOff: true,
  },
]

function formatDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isHoliday(date: Date): { name: string; nameVi: string } | null {
  const key = formatDateKey(date)
  return HOLIDAYS_2026[key] || null
}

export function generateCalendar(year: number, month: number, pattern: CalendarPattern): CalendarDay[] {
  const days: CalendarDay[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  let saturdayCount = 0

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d)
    const dow = date.getDay() // 0=Sun, 6=Sat
    const holiday = isHoliday(date)

    let dayType: DayType = 'work'
    let label = '出勤'
    let labelVi = 'Đi làm'

    if (holiday && pattern.holidayOff) {
      dayType = 'holiday'
      label = holiday.name
      labelVi = holiday.nameVi
    } else if (dow === 0) {
      dayType = 'off'
      label = '休み'
      labelVi = 'Nghỉ'
    } else if (dow === 6) {
      saturdayCount++
      if (pattern.saturdayWork) {
        dayType = 'work'
        label = '出勤'
        labelVi = 'Đi làm'
      } else if (pattern.saturdayAlt) {
        // 隔週：奇数回目は出勤、偶数回目は休み
        if (saturdayCount % 2 === 1) {
          dayType = 'work'
          label = '出勤'
          labelVi = 'Đi làm'
        } else {
          dayType = 'off'
          label = '休み'
          labelVi = 'Nghỉ'
        }
      } else {
        dayType = 'off'
        label = '休み'
        labelVi = 'Nghỉ'
      }
    }

    days.push({
      date,
      dayType,
      label,
      labelVi,
      holidayName: holiday?.name,
      holidayNameVi: holiday?.nameVi,
    })
  }

  return days
}

export function getNextMonth(): { year: number; month: number; ym: string } {
  const now = new Date()
  let year = now.getFullYear()
  let month = now.getMonth() + 2 // getMonth is 0-based, +2 for next month
  if (month > 12) {
    month = 1
    year++
  }
  return { year, month, ym: `${year}-${String(month).padStart(2, '0')}` }
}

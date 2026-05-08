import { CalendarDay, DayType } from '@/types'

// 日本の祝日マスタ（2026〜2029年分。次は cabinet office の発表に合わせて拡張）
// データソース: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
const HOLIDAYS: Record<string, { name: string; nameVi: string }> = {
  // 2026年
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

  // 2027年
  '2027-01-01': { name: '元日', nameVi: 'Tết Dương lịch' },
  '2027-01-11': { name: '成人の日', nameVi: 'Ngày Thành nhân' },
  '2027-02-11': { name: '建国記念の日', nameVi: 'Ngày Quốc khánh' },
  '2027-02-23': { name: '天皇誕生日', nameVi: 'Sinh nhật Nhật Hoàng' },
  '2027-03-21': { name: '春分の日', nameVi: 'Ngày Xuân phân' },
  '2027-03-22': { name: '振替休日', nameVi: 'Ngày nghỉ bù' },
  '2027-04-29': { name: '昭和の日', nameVi: 'Ngày Chiêu Hòa' },
  '2027-05-03': { name: '憲法記念日', nameVi: 'Ngày Hiến pháp' },
  '2027-05-04': { name: 'みどりの日', nameVi: 'Ngày Xanh' },
  '2027-05-05': { name: 'こどもの日', nameVi: 'Ngày Thiếu nhi' },
  '2027-07-19': { name: '海の日', nameVi: 'Ngày Biển' },
  '2027-08-11': { name: '山の日', nameVi: 'Ngày Núi' },
  '2027-09-20': { name: '敬老の日', nameVi: 'Ngày Kính lão' },
  '2027-09-23': { name: '秋分の日', nameVi: 'Ngày Thu phân' },
  '2027-10-11': { name: 'スポーツの日', nameVi: 'Ngày Thể thao' },
  '2027-11-03': { name: '文化の日', nameVi: 'Ngày Văn hóa' },
  '2027-11-23': { name: '勤労感謝の日', nameVi: 'Ngày Cảm ơn Lao động' },

  // 2028年
  '2028-01-01': { name: '元日', nameVi: 'Tết Dương lịch' },
  '2028-01-10': { name: '成人の日', nameVi: 'Ngày Thành nhân' },
  '2028-02-11': { name: '建国記念の日', nameVi: 'Ngày Quốc khánh' },
  '2028-02-23': { name: '天皇誕生日', nameVi: 'Sinh nhật Nhật Hoàng' },
  '2028-03-20': { name: '春分の日', nameVi: 'Ngày Xuân phân' },
  '2028-04-29': { name: '昭和の日', nameVi: 'Ngày Chiêu Hòa' },
  '2028-05-03': { name: '憲法記念日', nameVi: 'Ngày Hiến pháp' },
  '2028-05-04': { name: 'みどりの日', nameVi: 'Ngày Xanh' },
  '2028-05-05': { name: 'こどもの日', nameVi: 'Ngày Thiếu nhi' },
  '2028-07-17': { name: '海の日', nameVi: 'Ngày Biển' },
  '2028-08-11': { name: '山の日', nameVi: 'Ngày Núi' },
  '2028-09-18': { name: '敬老の日', nameVi: 'Ngày Kính lão' },
  '2028-09-22': { name: '秋分の日', nameVi: 'Ngày Thu phân' },
  '2028-10-09': { name: 'スポーツの日', nameVi: 'Ngày Thể thao' },
  '2028-11-03': { name: '文化の日', nameVi: 'Ngày Văn hóa' },
  '2028-11-23': { name: '勤労感謝の日', nameVi: 'Ngày Cảm ơn Lao động' },

  // 2029年
  '2029-01-01': { name: '元日', nameVi: 'Tết Dương lịch' },
  '2029-01-08': { name: '成人の日', nameVi: 'Ngày Thành nhân' },
  '2029-02-11': { name: '建国記念の日', nameVi: 'Ngày Quốc khánh' },
  '2029-02-12': { name: '振替休日', nameVi: 'Ngày nghỉ bù' },
  '2029-02-23': { name: '天皇誕生日', nameVi: 'Sinh nhật Nhật Hoàng' },
  '2029-03-20': { name: '春分の日', nameVi: 'Ngày Xuân phân' },
  '2029-04-29': { name: '昭和の日', nameVi: 'Ngày Chiêu Hòa' },
  '2029-04-30': { name: '振替休日', nameVi: 'Ngày nghỉ bù' },
  '2029-05-03': { name: '憲法記念日', nameVi: 'Ngày Hiến pháp' },
  '2029-05-04': { name: 'みどりの日', nameVi: 'Ngày Xanh' },
  '2029-05-05': { name: 'こどもの日', nameVi: 'Ngày Thiếu nhi' },
  '2029-07-16': { name: '海の日', nameVi: 'Ngày Biển' },
  '2029-08-11': { name: '山の日', nameVi: 'Ngày Núi' },
  '2029-09-17': { name: '敬老の日', nameVi: 'Ngày Kính lão' },
  '2029-09-23': { name: '秋分の日', nameVi: 'Ngày Thu phân' },
  '2029-09-24': { name: '振替休日', nameVi: 'Ngày nghỉ bù' },
  '2029-10-08': { name: 'スポーツの日', nameVi: 'Ngày Thể thao' },
  '2029-11-03': { name: '文化の日', nameVi: 'Ngày Văn hóa' },
  '2029-11-23': { name: '勤労感謝の日', nameVi: 'Ngày Cảm ơn Lao động' },
}

// 後方互換のため旧名でも export
const HOLIDAYS_2026 = HOLIDAYS

function formatDateKey(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${year}-${m}-${d}`
}

export function getHoliday(year: number, month: number, day: number): { name: string; nameVi: string } | null {
  return HOLIDAYS[formatDateKey(year, month, day)] || null
}

// 後方互換: 古い名前で参照されるかもしれないので残しておく
export { HOLIDAYS_2026 }

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

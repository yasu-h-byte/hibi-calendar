// ────────────────────────────────────────
//  有給管理の純粋計算ヘルパー
//  （app/(app)/leave/page.tsx から抽出。UIに依存しない計算のみ）
// ────────────────────────────────────────

/** hireDate + 6ヶ月 → 発生月を計算 */
export function calcGrantMonthFromHire(hireDate: string): number | null {
  if (!hireDate) return null
  const d = new Date(hireDate)
  if (isNaN(d.getTime())) return null
  const grantDate = new Date(d.getFullYear(), d.getMonth() + 6, 1)
  return grantDate.getMonth() + 1 // 1-12
}

/** 法定有給付与日数を計算（フロントエンド版） */
export function calcLegalPL(hireDate: string, grantDate: string): { days: number; years: number; months: number; label: string } {
  if (!hireDate || !grantDate) return { days: 0, years: 0, months: 0, label: '' }
  const hire = new Date(hireDate)
  const grant = new Date(grantDate)
  if (isNaN(hire.getTime()) || isNaN(grant.getTime())) return { days: 0, years: 0, months: 0, label: '' }

  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grant.getFullYear() - hire.getFullYear()) * 12
    + (grant.getMonth() - hire.getMonth())
    + (grant.getDate() >= hire.getDate() ? 0 : -1)
  const years = Math.floor(diffMonths / 12)
  const months = diffMonths % 12

  let days = 0
  if (diffMonths < 6) days = 0
  else if (diffMonths < 18) days = 10
  else if (diffMonths < 30) days = 11
  else if (diffMonths < 42) days = 12
  else if (diffMonths < 54) days = 14
  else if (diffMonths < 66) days = 16
  else if (diffMonths < 78) days = 18
  else days = 20

  const label = `入社日 ${hireDate} → ${years}年${months}ヶ月 → 法定${days}日`
  return { days, years, months, label }
}

/** 消化率のバー色を決定 */
export function rateBarColor(rate: number): string {
  if (rate <= 50) return 'from-green-400 to-green-500'
  if (rate <= 80) return 'from-yellow-400 to-yellow-500'
  return 'from-red-400 to-red-500'
}

/** 日本の祝日（簡易版 - 固定日のみ） */
export function getJPHolidays(year: number): Set<string> {
  const holidays = new Set<string>()
  const add = (m: number, d: number) => {
    holidays.add(`${year}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`)
  }
  add(1, 1)   // 元日
  add(2, 11)  // 建国記念の日
  add(2, 23)  // 天皇誕生日
  add(4, 29)  // 昭和の日
  add(5, 3)   // 憲法記念日
  add(5, 4)   // みどりの日
  add(5, 5)   // こどもの日
  add(8, 11)  // 山の日
  add(11, 3)  // 文化の日
  add(11, 23) // 勤労感謝の日
  // 成人の日（1月第2月曜）
  for (let d = 8; d <= 14; d++) { if (new Date(year, 0, d).getDay() === 1) { add(1, d); break } }
  // 春分の日（概算）
  add(3, year % 4 === 0 ? 20 : 21)
  // 海の日（7月第3月曜）
  let count = 0
  for (let d = 1; d <= 31; d++) { if (new Date(year, 6, d).getDay() === 1) { count++; if (count === 3) { add(7, d); break } } }
  // 敬老の日（9月第3月曜）
  count = 0
  for (let d = 1; d <= 30; d++) { if (new Date(year, 8, d).getDay() === 1) { count++; if (count === 3) { add(9, d); break } } }
  // 秋分の日（概算）
  add(9, year % 4 === 0 ? 22 : 23)
  // スポーツの日（10月第2月曜）
  count = 0
  for (let d = 1; d <= 31; d++) { if (new Date(year, 9, d).getDay() === 1) { count++; if (count === 2) { add(10, d); break } } }
  return holidays
}

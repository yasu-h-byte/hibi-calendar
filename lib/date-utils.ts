/**
 * 日付関連のユーティリティ関数
 * ページ間で重複していた日付処理を集約
 */

// ────────────────────────────────────────
//  Day of week
// ────────────────────────────────────────

const DOW_JA_SHORT = ['日', '月', '火', '水', '木', '金', '土']
const DOW_VI_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

/** 日本語の曜日（1文字） */
export function dowJapanese(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return DOW_JA_SHORT[d.getDay()]
}

/** ベトナム語の曜日（2文字） */
export function dowVietnamese(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return DOW_VI_SHORT[d.getDay()]
}

/** 日曜日かどうか */
export function isSunday(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.getDay() === 0
}

/** 土曜日かどうか */
export function isSaturday(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.getDay() === 6
}

// ────────────────────────────────────────
//  Format
// ────────────────────────────────────────

/** "2026年4月15日(火)" */
export function formatDateLong(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${dowJapanese(d)})`
}

/** "4/15" */
export function formatDateShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** "4/15 14:30" */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`
}

/** "2026-04-15" (ISO日付部分のみ) */
export function formatIsoDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ────────────────────────────────────────
//  Relative time
// ────────────────────────────────────────

/**
 * 相対時間表示 "たった今" / "3分前" / "2時間前" / "昨日" / "3日前" / "4/15"
 * dashboard の AnnouncementsCard などで使用
 */
export function formatRelativeTime(isoOrDate: string | Date): string {
  const then = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate
  const now = new Date()
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}時間前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return '昨日'
  if (diffDay < 7) return `${diffDay}日前`
  return `${then.getMonth() + 1}/${then.getDate()}`
}

// ────────────────────────────────────────
//  Calculations
// ────────────────────────────────────────

/** a から b までの日数（a < b なら正、a > b なら負） */
export function daysBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === 'string' ? new Date(a + 'T00:00:00') : a
  const db = typeof b === 'string' ? new Date(b + 'T00:00:00') : b
  return Math.ceil((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24))
}

/** 入社日からの経過年数（整数、切り捨て） */
export function yearsFromDate(isoDate: string, asOf?: Date): number {
  if (!isoDate) return 0
  const hire = new Date(isoDate)
  if (isNaN(hire.getTime())) return 0
  const now = asOf || new Date()
  return Math.floor((now.getTime() - hire.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
}

/** 今日のISO日付 "YYYY-MM-DD" */
export function todayIso(): string {
  return formatIsoDate(new Date())
}

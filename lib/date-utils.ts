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

/**
 * JST 固定で「今日の日付」を取得（2026-06-XX 追加）
 *
 * - ホスト TZ に依存せず、Asia/Tokyo (UTC+9) として日付を返す
 * - Vercel (UTC) / ローカル (JST) で挙動が変わらない
 *
 * @returns YYYY-MM-DD
 */
export function todayJstIso(): string {
  const now = new Date()
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000
  return new Date(jstMs).toISOString().slice(0, 10)
}

/**
 * 安全な月加算（2026-06-XX 追加・行政解釈準拠）
 *
 * JavaScript の `Date.setMonth(+n)` は「翌n月後の同日が存在しない場合、
 * 次月に繰り越す」仕様。これが労基法上の「応当日」判定で問題になる。
 *
 * 例: 入社 2025-08-31 → setMonth(+6) → 2026-03-03 (JS バグ)
 *     行政解釈: 月末入社の応当日は前月末日 → 2026-02-28 (正)
 *
 * - 加算後の月に応当日が存在する場合: そのまま
 * - 存在しない場合（月末入社など）: 加算後月の末日に丸める
 *
 * @param dateIso YYYY-MM-DD 形式の日付
 * @param months  加算する月数（負も可）
 * @returns YYYY-MM-DD 形式の日付
 *
 * 例:
 *   addMonthsSafe('2025-08-31', 6) → '2026-02-28' (2月末日)
 *   addMonthsSafe('2024-02-29', 12) → '2025-02-28' (うるう年→平年)
 *   addMonthsSafe('2025-08-15', 6) → '2026-02-15' (通常)
 */
export function addMonthsSafe(dateIso: string, months: number): string {
  if (!dateIso) return ''
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ''

  const totalMonths = (m - 1) + months  // 0-indexed
  const targetY = y + Math.floor(totalMonths / 12)
  const targetM = ((totalMonths % 12) + 12) % 12  // 0-indexed (負の月対応)

  // 加算後月の末日（targetM+1 月の 0日目 = 当月末日）
  const lastDayOfTargetMonth = new Date(targetY, targetM + 1, 0).getDate()
  const safeDay = Math.min(d, lastDayOfTargetMonth)

  const mm = String(targetM + 1).padStart(2, '0')
  const dd = String(safeDay).padStart(2, '0')
  return `${targetY}-${mm}-${dd}`
}

/**
 * ISO 日付に日数を加減する。
 *
 * `Date.UTC` 基準で計算するのでタイムゾーンに依存しない。
 * `new Date('2026-01-13')`（UTC 深夜）と `new Date('2026-01-13T00:00:00')`（ローカル深夜）が
 * 混在すると JST 環境で `toISOString()` が前日を返すため、日付演算は必ず本関数を通すこと。
 *
 * @param dateIso YYYY-MM-DD
 * @param days    加減する日数（負も可）
 * @returns YYYY-MM-DD
 */
export function addDaysIso(dateIso: string, days: number): string {
  if (!dateIso) return ''
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ''
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000)
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${mm}-${dd}`
}

/**
 * 有給休暇の「時効発生日」= 付与日 + 2年（うるう年も正確に）。
 *
 * ⚠️ これは**時効が到来する日そのもの**であって、最後に使える日ではない。
 * 画面・帳票に「有効期限 / 〜YYYY/MM/DD」として出す日付は
 * {@link calcLastUsableDayIso} を使うこと（1日ズレる）。
 * 期限切れ判定も {@link isLeaveExpiredAsOf} を使うこと。
 *
 * @param grantDateIso YYYY-MM-DD
 * @returns YYYY-MM-DD（時効発生日 = grantDate + 2年）
 */
export function calcExpiryIso(grantDateIso: string): string {
  return addMonthsSafe(grantDateIso, 24)
}

/**
 * 有給休暇の「最終利用可能日」= その日まで有給を消化できる最後の日。
 *
 * 労基法115条の2年時効を民法143条2項に従って算定する:
 *   - 原則: 2年後の応当日の**前日**に満了（2026-01-13 付与 → 2028-01-12）
 *   - 例外: 応当日が存在しない月は**その月の末日**に満了
 *           （2024-02-29 付与 → 2026年2月に29日は無いので 2026-02-28。
 *            ここで更に -1日 して 2026-02-27 とするのは誤り）
 *
 * 画面・Excel の「有効期限」「〜YYYY/MM/DD」表示はすべて本関数に統一する。
 *
 * @param grantDateIso YYYY-MM-DD
 * @returns YYYY-MM-DD（最終利用可能日）
 */
export function calcLastUsableDayIso(grantDateIso: string): string {
  if (!grantDateIso) return ''
  const day = Number(grantDateIso.slice(8, 10))
  const anniversary = calcExpiryIso(grantDateIso)
  if (!anniversary || !day) return ''
  // 応当日がそのまま取れた場合のみ前日にする。
  // クランプされた（= 応当日が無かった）場合、その末日自体が満了日。
  if (Number(anniversary.slice(8, 10)) === day) return addDaysIso(anniversary, -1)
  return anniversary
}

/**
 * 指定日時点で、その付与分の有給が時効消滅しているか。
 *
 * 最終利用可能日を1日でも過ぎていれば消滅。境界日（最終利用可能日当日）は
 * まだ消化できるので false。
 *
 * @param grantDateIso YYYY-MM-DD
 * @param asOfIso      判定基準日 YYYY-MM-DD（省略時は JST の今日）
 */
export function isLeaveExpiredAsOf(grantDateIso: string, asOfIso?: string): boolean {
  const lastUsable = calcLastUsableDayIso(grantDateIso)
  if (!lastUsable) return false
  const asOf = (asOfIso || todayJstIso()).slice(0, 10)
  return asOf > lastUsable
}

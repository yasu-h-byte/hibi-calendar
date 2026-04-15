/**
 * 年月（YM）フォーマットの統一ユーティリティ
 *
 * 本プロジェクトでは2つの形式が混在していたため、以下のルールで統一する:
 *   - ym6: YYYYMM 形式（例: "202605"）— 出面データ、月次集計、Firestore att_YYYYMM 等
 *   - ym7: YYYY-MM 形式（例: "2026-05"）— siteCalendar の ym フィールド、URLパラメータ等
 *
 * どちらの形式を要求するAPIかを明示し、必要に応じて toYm6()/toYm7() で変換する。
 */

export type Ym6 = string // "YYYYMM"
export type Ym7 = string // "YYYY-MM"

// ────────────────────────────────────────
//  Build
// ────────────────────────────────────────

/** 年月から YYYYMM 形式を生成 */
export function toYm6(year: number, month: number): Ym6 {
  return `${year}${String(month).padStart(2, '0')}`
}

/** 年月から YYYY-MM 形式を生成 */
export function toYm7(year: number, month: number): Ym7 {
  return `${year}-${String(month).padStart(2, '0')}`
}

// ────────────────────────────────────────
//  Parse
// ────────────────────────────────────────

/** どちらの形式でも年月に分解 */
export function parseYm(ym: Ym6 | Ym7): { year: number; month: number } {
  if (/^\d{4}-\d{2}$/.test(ym)) {
    return { year: parseInt(ym.slice(0, 4)), month: parseInt(ym.slice(5, 7)) }
  }
  if (/^\d{6}$/.test(ym)) {
    return { year: parseInt(ym.slice(0, 4)), month: parseInt(ym.slice(4, 6)) }
  }
  throw new Error(`Invalid ym format: ${ym}`)
}

// ────────────────────────────────────────
//  Convert
// ────────────────────────────────────────

/** どの形式からでも YYYYMM に変換 */
export function ym6(ym: Ym6 | Ym7): Ym6 {
  const { year, month } = parseYm(ym)
  return toYm6(year, month)
}

/** どの形式からでも YYYY-MM に変換 */
export function ym7(ym: Ym6 | Ym7): Ym7 {
  const { year, month } = parseYm(ym)
  return toYm7(year, month)
}

// ────────────────────────────────────────
//  Current / Next / Prev
// ────────────────────────────────────────

/** 現在の年月を YYYYMM で取得 */
export function currentYm6(): Ym6 {
  const now = new Date()
  return toYm6(now.getFullYear(), now.getMonth() + 1)
}

/** 現在の年月を YYYY-MM で取得 */
export function currentYm7(): Ym7 {
  const now = new Date()
  return toYm7(now.getFullYear(), now.getMonth() + 1)
}

/** 翌月を YYYYMM で取得 */
export function nextYm6(): Ym6 {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return toYm6(next.getFullYear(), next.getMonth() + 1)
}

/** 翌月を YYYY-MM で取得（就業カレンダー等で使用） */
export function nextYm7(): Ym7 {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return toYm7(next.getFullYear(), next.getMonth() + 1)
}

/** 前月を YYYYMM で取得 */
export function prevYm6(): Ym6 {
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return toYm6(prev.getFullYear(), prev.getMonth() + 1)
}

// ────────────────────────────────────────
//  Format for display
// ────────────────────────────────────────

/** "2026年5月" */
export function formatYmLabel(ym: Ym6 | Ym7): string {
  const { year, month } = parseYm(ym)
  return `${year}年${month}月`
}

/** "5月" */
export function formatYmShort(ym: Ym6 | Ym7): string {
  const { month } = parseYm(ym)
  return `${month}月`
}

// ────────────────────────────────────────
//  Utilities
// ────────────────────────────────────────

/** 月の暦日数を返す */
export function daysInMonth(ym: Ym6 | Ym7): number {
  const { year, month } = parseYm(ym)
  return new Date(year, month, 0).getDate()
}

/** 暦日数 × 40 ÷ 7 = 変形労働時間制の法定上限時間 */
export function legalLimitHours(ym: Ym6 | Ym7): number {
  return (daysInMonth(ym) * 40) / 7
}

/** 過去 N 月分の YYYYMM リストを降順で返す（現在月を含む） */
export function getPastMonthsYm6(count: number): Ym6[] {
  const result: Ym6[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    result.push(toYm6(d.getFullYear(), d.getMonth() + 1))
  }
  return result
}

/** 年月セレクタ用のオプション配列 */
export function getYmSelectOptions(
  count: number = 6,
  format: 6 | 7 = 6,
): Array<{ ym: string; label: string }> {
  const result: Array<{ ym: string; label: string }> = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const ym = format === 6 ? toYm6(d.getFullYear(), d.getMonth() + 1) : toYm7(d.getFullYear(), d.getMonth() + 1)
    result.push({ ym, label: `${d.getFullYear()}年${d.getMonth() + 1}月` })
  }
  return result
}

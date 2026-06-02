/**
 * アプリ全体の定数（2026-06-XX 新設）
 *
 * UI と API でポリシー値が食い違うバグを防ぐため、ここに集約。
 */

/**
 * 有給申請の最短先付日数
 *
 * - スタッフは「今日 + N日」以降の日付しか申請できない（事前申請のルール）
 * - モーダル UI と API の両方でこの定数を使用
 *
 * 2026-06-XX 修正 (IM-9): モーダル「今日+5日」、API「過去日のみNG」で食い違い → 統一
 */
export const LEAVE_REQUEST_MIN_DAYS_AHEAD = 5

/**
 * 年5日義務（労基法39条7項）警告タイミング
 *
 * - 付与から N ヶ月経過しても未達なら警告
 * - judgeFiveDayObligation 内で使用
 */
export const FIVE_DAY_WARNING_AFTER_MONTHS = 9

/**
 * 36協定 限度時間（労基法36条）
 *
 * - 通常: 月45h / 年360h
 * - 特別条項: 月100h未満 / 年720h / 発動6回/年まで
 * - ⚠️ 会社の実際の協定値は docs/labor-agreements.md を参照（システム値はデフォルト）
 */
export const OVERTIME_LIMIT_MONTHLY = 45
export const OVERTIME_LIMIT_YEARLY = 360
export const SPECIAL_OVERTIME_LIMIT_MONTHLY = 99  // 100h未満
export const SPECIAL_OVERTIME_LIMIT_YEARLY = 720
export const SPECIAL_OVERTIME_MAX_TIMES = 6

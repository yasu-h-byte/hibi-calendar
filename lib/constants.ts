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

/**
 * 日本人・月給制の割増賃金算定基礎に使う「月平均所定労働時間」(h)。
 *
 * 施行規則19条（月ごとに所定が異なる場合は年平均で除する）に基づく固定値。
 * 年間休日が現場依存で確定できないため、想定レンジ(月140〜145.8h)内の145hに固定
 * （2026-07-09 代表確定）。分母を実際の所定より小さめに固定するぶんには単価が
 * 法定最低を上回り常に適法。
 *
 * ⚠️ 給与計算エンジン(lib/compute.ts)と人員マスタ画面の残業単価「参考」表示の
 *    両方がこの定数を参照する。変更時は docs/salary-calculation.md と賃金規程も更新すること。
 */
export const JP_SALARY_AVG_MONTHLY_HOURS = 145

/**
 * 繰り返し使われる Tailwind クラスの定数化
 *
 * コードベース全体で以下のようなパターンが72+箇所で重複していた:
 *   <div className="bg-white dark:bg-gray-800 rounded-xl shadow">
 *
 * これらを定数として集約し、テーマ変更時の一括修正を容易にする。
 * 使用例:
 *   import { cardCls } from '@/lib/styles'
 *   <div className={cardCls()}>...</div>
 *   <div className={cardCls('p-4')}>...</div>
 */

// ────────────────────────────────────────
//  Card
// ────────────────────────────────────────

/** 標準カード（白地 + 細枠線 + 角丸。影は付けない＝案1 UDホワイト 2026-09-30） */
export function cardCls(extra = ''): string {
  return `bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 ${extra}`.trim()
}

/** 境界線ありカード */
export function cardBorderedCls(extra = ''): string {
  return `bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 ${extra}`.trim()
}

// ────────────────────────────────────────
//  Input / Form
// ────────────────────────────────────────

/** テキスト入力 */
export const inputCls =
  'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none'

/** セレクトボックス */
export const selectCls =
  'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none bg-white'

// ────────────────────────────────────────
//  Badge
// ────────────────────────────────────────

/** バッジの色バリエーション */
export const badgeCls = {
  red: 'px-2 py-0.5 rounded-full text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
  yellow:
    'px-2 py-0.5 rounded-full text-xs bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300',
  green:
    'px-2 py-0.5 rounded-full text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
  blue:
    'px-2 py-0.5 rounded-full text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
  gray:
    'px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  orange:
    'px-2 py-0.5 rounded-full text-xs bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
  indigo:
    'px-2 py-0.5 rounded-full text-xs bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300',
  purple:
    'px-2 py-0.5 rounded-full text-xs bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
} as const

export type BadgeColor = keyof typeof badgeCls

/** タブボタン（共通部分） */
export function tabButtonCls(active: boolean, extra = ''): string {
  const base = 'flex-1 py-2 px-4 rounded-md text-sm font-medium transition'
  const state = active
    ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm'
    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
  return `${base} ${state} ${extra}`.trim()
}

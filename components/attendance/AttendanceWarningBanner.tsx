/**
 * 出面入力ページの警告バナー（汎用）
 *
 * 日曜出勤・休日出勤・その他の警告を統一スタイルで表示。
 * 同じ三角アイコン + タイトル + 件数 + 詳細リストの構造を持つ
 * バナーが複数あったため共通化。
 */
'use client'

interface Props {
  title: string
  items: { workerName: string; day: number; suffix?: string }[]
  tone?: 'warning' | 'orange'  // warning=黄色（日曜）/ orange=橙（休日）
}

const TONE_CLASSES = {
  warning: {
    container: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700',
    header: 'text-yellow-800 dark:text-yellow-300',
    body: 'text-yellow-700 dark:text-yellow-400',
  },
  orange: {
    container: 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700',
    header: 'text-orange-800 dark:text-orange-300',
    body: 'text-orange-700 dark:text-orange-400',
  },
} as const

export default function AttendanceWarningBanner({ title, items, tone = 'warning' }: Props) {
  if (items.length === 0) return null
  const cls = TONE_CLASSES[tone]
  // 旧コードに合わせて、休日(orange) は ", " 区切り、日曜(warning) は "、 " 区切り
  const separator = tone === 'orange' ? ', ' : '、 '

  return (
    <div className={`${cls.container} border rounded-xl px-4 py-3 text-sm`}>
      <div className={`flex items-center gap-2 font-bold ${cls.header} mb-1`}>
        <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        {title} ({items.length}件)
      </div>
      <div className={`${cls.body} text-xs leading-relaxed`}>
        {items.map((w, i) => (
          <span key={i}>
            {i > 0 && separator}
            {w.workerName} ({w.day}日{w.suffix ? `/${w.suffix}` : ''})
          </span>
        ))}
      </div>
    </div>
  )
}

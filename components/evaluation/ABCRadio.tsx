'use client'
/** ABC 評価のラジオ（各ランクの目安を常時表示し、選択中を強調）。2026-10-21 に評価画面から分離（中身は変えていない） */
import { ABCGrade } from '@/types'

export function ABCRadio({
  value,
  onChange,
  label,
  disabled,
  descA,
  descB,
  descC,
}: {
  value: ABCGrade
  onChange: (v: ABCGrade) => void
  label: string
  disabled?: boolean
  descA?: string
  descB?: string
  descC?: string
}) {
  const grades: ABCGrade[] = ['A', 'B', 'C']
  const descs: Record<ABCGrade, string | undefined> = { A: descA, B: descB, C: descC }

  // 各ランクのスタイル定義
  const gradeStyles: Record<ABCGrade, {
    activeBtn: string
    activeRow: string
    mark: string
  }> = {
    A: {
      activeBtn: 'bg-green-500 text-white shadow-md',
      activeRow: 'bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700',
      mark: 'bg-green-500 text-white',
    },
    B: {
      activeBtn: 'bg-yellow-500 text-white shadow-md',
      activeRow: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700',
      mark: 'bg-yellow-500 text-white',
    },
    C: {
      activeBtn: 'bg-red-400 text-white shadow-md',
      activeRow: 'bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700',
      mark: 'bg-red-400 text-white',
    },
  }

  return (
    <div className="py-3">
      {/* 項目名 */}
      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">
        {label}
      </div>

      {/* 各ランクの説明＋選択ボタンを行ごとにカード化 */}
      <div className="space-y-1.5">
        {grades.map(g => {
          const active = value === g
          const styles = gradeStyles[g]
          const desc = descs[g]
          const baseRow = active
            ? `border-2 ${styles.activeRow}`
            : 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60'
          return (
            <button
              key={g}
              type="button"
              disabled={disabled}
              onClick={() => onChange(g)}
              className={`w-full flex items-start gap-3 rounded-lg p-2.5 text-left transition-all ${baseRow} ${
                disabled
                  ? 'opacity-60 cursor-not-allowed'
                  : 'hover:border-gray-400 dark:hover:border-gray-500 cursor-pointer'
              }`}
            >
              {/* ランクマーク */}
              <span
                className={`flex-shrink-0 w-9 h-9 rounded-lg font-bold text-sm flex items-center justify-center transition-all ${
                  active
                    ? styles.activeBtn
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                }`}
              >
                {g}
              </span>
              {/* 説明文 */}
              <span
                className={`flex-1 text-xs leading-relaxed pt-1 ${
                  active
                    ? 'text-gray-900 dark:text-gray-100 font-medium'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                {desc || (g === 'A' ? '良好' : g === 'B' ? '標準' : '改善必要')}
              </span>
              {/* 選択中マーク */}
              {active && (
                <span className="flex-shrink-0 text-green-600 dark:text-green-400 font-bold text-sm pt-1">
                  ✓
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Grade badge (small, for comparison table) ──
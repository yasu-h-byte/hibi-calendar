'use client'
/** A/B/C/D のバッジ。2026-10-21 に評価画面から分離（中身は変えていない） */
import { ABCGrade } from '@/types'

export function GradeBadge({ grade }: { grade: ABCGrade }) {
  let cls = 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200'
  if (grade === 'A') cls = 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
  if (grade === 'B') cls = 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
  if (grade === 'C') cls = 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
  return (
    <span className={`inline-block w-8 h-8 rounded-lg text-center leading-8 font-bold text-sm ${cls}`}>
      {grade}
    </span>
  )
}

// ── 評価者バッジ列（提出/未提出を視覚化、自分は青リング） ──
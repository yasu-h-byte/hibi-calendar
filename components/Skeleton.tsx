'use client'

interface SkeletonProps {
  className?: string
}

/** Single skeleton bar with pulse animation */
export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`bg-gray-200 dark:bg-gray-700 rounded animate-skeleton ${className}`}
    />
  )
}

/** Table skeleton: renders rows of animated bars mimicking a data table */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
      {/* Header */}
      <div className="bg-gray-50 dark:bg-gray-700 px-3 py-3 flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="px-3 py-3 flex gap-4 border-t border-gray-100 dark:border-gray-700">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 flex-1 ${c === 0 ? 'max-w-[120px]' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Card skeleton: renders a grid of animated card shapes */
export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 space-y-3">
          <Skeleton className="h-8 w-16 mx-auto" />
          <Skeleton className="h-3 w-20 mx-auto" />
        </div>
      ))}
    </div>
  )
}

/** Page-level loading skeleton with KPI cards + table */
export function PageSkeleton() {
  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>
      {/* KPI cards */}
      <CardSkeleton />
      {/* Table */}
      <TableSkeleton />
    </div>
  )
}

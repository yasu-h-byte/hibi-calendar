import { ReactNode } from 'react'
import { emptyStateCls, loadingStateCls } from '@/lib/styles'

interface EmptyStateProps {
  children?: ReactNode
  className?: string
}

/**
 * 「データがありません」表示
 */
export function EmptyState({ children = 'データがありません', className = '' }: EmptyStateProps) {
  return <div className={`${emptyStateCls} ${className}`.trim()}>{children}</div>
}

/**
 * ローディング表示
 */
export function LoadingState({
  children = '読み込み中...',
  className = '',
}: EmptyStateProps) {
  return <div className={`${loadingStateCls} ${className}`.trim()}>{children}</div>
}

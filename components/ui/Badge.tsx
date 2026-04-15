import { ReactNode } from 'react'
import { badgeCls, type BadgeColor } from '@/lib/styles'

interface BadgeProps {
  color: BadgeColor
  children: ReactNode
  className?: string
}

/**
 * 共通バッジコンポーネント
 *
 * ステータス表示、ランク表示、カテゴリ表示等で使用。
 *
 * 使用例:
 *   <Badge color="green">A</Badge>
 *   <Badge color="red">未署名</Badge>
 *   <Badge color="orange">帰国中</Badge>
 */
export function Badge({ color, children, className = '' }: BadgeProps) {
  return <span className={`${badgeCls[color]} ${className}`.trim()}>{children}</span>
}

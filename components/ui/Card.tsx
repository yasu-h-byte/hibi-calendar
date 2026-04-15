import { ReactNode } from 'react'
import { cardCls, cardBorderedCls } from '@/lib/styles'

interface CardProps {
  children: ReactNode
  className?: string
  bordered?: boolean
}

/**
 * 標準カード（bg-white + shadow + rounded）
 *
 * 72+ 箇所の `bg-white dark:bg-gray-800 rounded-xl shadow` を統一。
 *
 * 使用例:
 *   <Card>...</Card>
 *   <Card className="p-4">...</Card>
 *   <Card bordered className="p-3">...</Card>
 */
export function Card({ children, className = '', bordered = false }: CardProps) {
  const cls = bordered ? cardBorderedCls(className) : cardCls(className)
  return <div className={cls}>{children}</div>
}

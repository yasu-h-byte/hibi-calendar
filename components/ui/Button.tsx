import { ButtonHTMLAttributes, ReactNode } from 'react'
import { btnPrimaryCls, btnSecondaryCls, btnDangerCls } from '@/lib/styles'

type Variant = 'primary' | 'secondary' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

const variantCls: Record<Variant, string> = {
  primary: btnPrimaryCls,
  secondary: btnSecondaryCls,
  danger: btnDangerCls,
}

/**
 * 共通ボタンコンポーネント
 *
 * 使用例:
 *   <Button variant="primary" onClick={save}>保存</Button>
 *   <Button variant="secondary" onClick={cancel}>キャンセル</Button>
 *   <Button variant="danger" onClick={remove}>削除</Button>
 */
export function Button({ variant = 'primary', className = '', children, ...rest }: ButtonProps) {
  return (
    <button {...rest} className={`${variantCls[variant]} ${className}`.trim()}>
      {children}
    </button>
  )
}

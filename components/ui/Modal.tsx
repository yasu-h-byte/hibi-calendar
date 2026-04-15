'use client'

import { ReactNode, useEffect } from 'react'
import { modalOverlayCls, modalContentCls } from '@/lib/styles'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
  /** ESCキーで閉じない場合 false */
  closeOnEsc?: boolean
  /** 背景クリックで閉じない場合 false */
  closeOnOverlay?: boolean
}

/**
 * 共通モーダルコンポーネント
 *
 * 20+ 箇所のモーダルパターンを統一:
 *   <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
 *     <div className="bg-white rounded-xl p-6 max-w-lg ...">...</div>
 *   </div>
 *
 * 使用例:
 *   <Modal open={show} onClose={() => setShow(false)} title="編集">
 *     ...
 *   </Modal>
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className = '',
  closeOnEsc = true,
  closeOnOverlay = true,
}: ModalProps) {
  // ESC キーで閉じる
  useEffect(() => {
    if (!open || !closeOnEsc) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closeOnEsc, onClose])

  if (!open) return null

  return (
    <div
      className={modalOverlayCls}
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div className={modalContentCls(className)} onClick={e => e.stopPropagation()}>
        {title && (
          <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>
  )
}

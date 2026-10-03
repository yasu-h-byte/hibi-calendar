'use client'

import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { registerNotifyHost, type NotifyMessage } from '@/lib/notify'

/**
 * お知らせの帯（UI/UX 磨き込み 土台②・2026-10-03 代表 OK）。
 *
 * レイアウトに <ToastProvider> を1つ置くと、画面側は lib/notify.ts の notify.success() / notify.failed() を
 * 呼ぶだけで右上に帯が出る（スマホは幅いっぱい・PC は右上）。見本: https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh の2段目。
 *
 *   - うまくいった（緑）・情報（青）は 3秒で消える
 *   - 失敗（赤）は閉じるまで残る（見逃しを防ぐ・代表決定）。同じ文面の赤は重ねて出さない
 *   - 入力の不備は帯でなく欄のすぐ下に赤字（components/ui/PageParts.tsx の FieldError）
 *
 * 旧 API の useToast().showToast(type, text) も残す（既存の呼び出しをそのまま動かすため）。
 */
type ToastType = 'success' | 'error' | 'info'

interface ToastItemData extends NotifyMessage {
  id: number
}

interface ToastContextValue {
  showToast: (type: ToastType, text: string) => void
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItemData[]>([])

  const push = useCallback((m: NotifyMessage) => {
    setToasts(prev => {
      // 同じ失敗を連打で何枚も出さない（同じ見出し・同じ理由の残る帯は1枚）
      if (m.sticky && prev.some(t => t.sticky && t.title === m.title && t.detail === m.detail)) return prev
      return [...prev, { ...m, id: ++nextId }]
    })
  }, [])

  const showToast = useCallback((type: ToastType, text: string) => {
    push({ kind: type, title: text, sticky: type === 'error' })
  }, [push])

  useEffect(() => {
    registerNotifyHost(push)
    return () => registerNotifyHost(null)
  }, [push])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed top-4 right-4 left-4 sm:left-auto z-[100] flex flex-col items-stretch sm:items-end gap-2 pointer-events-none print:hidden">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const AUTO_DISMISS_MS = 3000

function ToastItem({ toast, onDismiss }: { toast: ToastItemData; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (toast.sticky) return
    const timer = setTimeout(() => setExiting(true), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.sticky])

  useEffect(() => {
    if (!exiting) return
    const timer = setTimeout(() => onDismiss(toast.id), 300)
    return () => clearTimeout(timer)
  }, [exiting, toast.id, onDismiss])

  const tone = toast.kind === 'success'
    ? 'bg-green-50 dark:bg-green-900/40 border-green-200 dark:border-green-800 text-green-900 dark:text-green-100'
    : toast.kind === 'error'
      ? 'bg-red-50 dark:bg-red-900/40 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
      : 'bg-blue-50 dark:bg-blue-900/40 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100'

  const icon = toast.kind === 'success' ? (
    <svg className="w-5 h-5 shrink-0 text-green-600 dark:text-green-300" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ) : toast.kind === 'error' ? (
    <svg className="w-5 h-5 shrink-0 text-red-600 dark:text-red-300" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8v5" /><path strokeLinecap="round" d="M12 16h.01" />
    </svg>
  ) : (
    <svg className="w-5 h-5 shrink-0 text-blue-600 dark:text-blue-300" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 11v5" /><path strokeLinecap="round" d="M12 8h.01" />
    </svg>
  )

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg ${tone}
        ${exiting ? 'animate-slideOutRight' : 'animate-slideInRight'}
        w-full sm:w-auto sm:min-w-[300px] sm:max-w-[440px]`}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold leading-snug">{toast.title}</div>
        {toast.detail && <div className="text-[0.8125rem] leading-relaxed mt-0.5 whitespace-pre-line">{toast.detail}</div>}
      </div>
      <button
        type="button"
        onClick={() => setExiting(true)}
        aria-label="閉じる"
        className="shrink-0 -mr-1 w-7 h-7 rounded-md flex items-center justify-center opacity-60 hover:opacity-100"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

'use client'

import { useState, useEffect, useCallback, createContext, useContext } from 'react'

type ToastType = 'success' | 'error' | 'info'

interface ToastMessage {
  id: number
  type: ToastType
  text: string
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
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const showToast = useCallback((type: ToastType, text: string) => {
    const id = ++nextId
    setToasts(prev => [...prev, { id, type, text }])
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true)
    }, 2700)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (exiting) {
      const timer = setTimeout(() => onDismiss(toast.id), 300)
      return () => clearTimeout(timer)
    }
  }, [exiting, toast.id, onDismiss])

  const icon = toast.type === 'success' ? (
    <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ) : toast.type === 'error' ? (
    <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ) : (
    <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )

  const bgClass = toast.type === 'success'
    ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800'
    : toast.type === 'error'
      ? 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800'
      : 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800'

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg
        ${bgClass}
        ${exiting ? 'animate-slideOutRight' : 'animate-slideInRight'}
        min-w-[280px] max-w-[400px]`}
    >
      {icon}
      <span className="text-sm text-gray-800 dark:text-gray-200 flex-1">{toast.text}</span>
      <button
        onClick={() => setExiting(true)}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

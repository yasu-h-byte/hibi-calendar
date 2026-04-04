'use client'

import { useEffect, useState, useRef, useCallback } from 'react'

interface Notification {
  id: string
  icon: string
  message: string
  type: 'warning' | 'error' | 'info'
  count?: number
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const fetchNotifications = useCallback(async () => {
    const stored = localStorage.getItem('hibi_auth')
    if (!stored) return
    try {
      const { password } = JSON.parse(stored)
      if (!password) return

      setLoading(true)
      const res = await fetch('/api/notifications', {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setNotifications(data.notifications || [])
      }
    } catch {
      // silent fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 5 * 60 * 1000) // refresh every 5 min
    return () => clearInterval(interval)
  }, [fetchNotifications])

  // Close panel when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  const visibleNotifications = notifications.filter(n => !dismissed.has(n.id))
  const unreadCount = visibleNotifications.length

  const handleDismiss = (id: string) => {
    setDismissed(prev => new Set(prev).add(id))
  }

  const handleMarkAllRead = () => {
    setDismissed(new Set(notifications.map(n => n.id)))
  }

  const typeColor = (type: string) => {
    switch (type) {
      case 'error': return 'border-l-red-500 bg-red-50 dark:bg-red-900/20'
      case 'warning': return 'border-l-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
      default: return 'border-l-blue-500 bg-blue-50 dark:bg-blue-900/20'
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-150"
        aria-label="通知"
      >
        <span className="text-xl" role="img" aria-label="bell">
          {'\uD83D\uDD14'}
        </span>

        {/* Badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[20px] h-5 flex items-center justify-center px-1 text-xs font-bold text-white bg-red-500 rounded-full shadow-sm">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute left-0 top-full mt-2 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-[100] overflow-hidden"
          style={{ animation: 'notifSlideIn 0.15s ease-out' }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-700">
            <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">通知</h3>
            {loading && (
              <span className="text-xs text-gray-400">更新中...</span>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {visibleNotifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                通知はありません
              </div>
            ) : (
              visibleNotifications.map(n => (
                <div
                  key={n.id}
                  className={`px-3 py-2.5 border-l-4 border-b border-gray-50 flex items-start gap-2 transition-colors duration-150 hover:bg-gray-50 ${typeColor(n.type)}`}
                >
                  <span className="text-sm flex-shrink-0 mt-0.5">{n.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-800 dark:text-gray-200 leading-snug">{n.message}</p>
                    {n.count !== undefined && n.count > 0 && (
                      <span className="inline-block mt-1 text-xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                        {n.count}件
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDismiss(n.id)}
                    className="flex-shrink-0 text-gray-300 hover:text-gray-500 transition-colors p-0.5"
                    aria-label="閉じる"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          {visibleNotifications.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
              <button
                onClick={handleMarkAllRead}
                className="w-full text-center text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
              >
                すべて既読
              </button>
            </div>
          )}
        </div>
      )}

      {/* Animation keyframe */}
      <style jsx>{`
        @keyframes notifSlideIn {
          from {
            opacity: 0;
            transform: translateY(-8px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  )
}

'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { getAuthPasswordSync } from '@/lib/hooks/useAuthPassword'
import { Icon } from './ui/Icon'

interface NotificationAction {
  type: string
  workerId: number
  grantDate: string
  grantDays: number
  carryOver: number
  label: string
}

interface Notification {
  id: string
  messengerText?: string
  icon: string
  message: string
  type: 'warning' | 'error' | 'info'
  count?: number
  /** 押すと開く画面 */
  href?: string
  action?: NotificationAction
}

export default function NotificationBell({ role, workerId }: { role: string; workerId?: number }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const fetchNotifications = useCallback(async () => {
    if (!getAuthPasswordSync()) return

    setLoading(true)
    try {
      const widParam = workerId ? `&workerId=${workerId}` : ''
      const res = await fetchWithAuth(`/api/notifications?role=${role}${widParam}`)
      if (res.ok) {
        const data = await res.json()
        setNotifications(data.notifications || [])
        setLoadFailed(false)
      } else {
        // 2026-10-02 総合点検: 取得に失敗したときは「取得できませんでした」と出す（旧: 緑の「問題なし」に見えた）
        setLoadFailed(true)
      }
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [role, workerId])

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchNotifications])

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

  const handleAction = async (n: Notification) => {
    if (!n.action || acting) return
    if (!getAuthPasswordSync()) return

    const a = n.action
    if (!confirm(`${a.grantDays}日を付与し、繰越${a.carryOver}日を設定します。よろしいですか？`)) return

    setActing(n.id)
    try {
      const fy = a.grantDate.slice(0, 4)
      const res = await postJson('/api/leave', {
        action: 'grant',
        workerId: a.workerId,
        fy,
        grantDays: a.grantDays,
        grantDate: a.grantDate,
        carryOver: a.carryOver,
      })
      if (res.ok) {
        // 成功 → 通知を再取得
        await fetchNotifications()
      } else {
        alert('付与に失敗しました')
      }
    } catch {
      alert('エラーが発生しました')
    } finally {
      setActing(null)
    }
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
      <button
        onClick={() => { setOpen(prev => !prev); if (!open) fetchNotifications() }}
        className="relative w-9 h-9 flex items-center justify-center rounded-[10px] border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-active dark:hover:bg-gray-700 transition-colors duration-150"
        aria-label="通知"
      >
        <Icon name="bell" size={17} />
        {notifications.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 flex items-center justify-center px-1 text-xs font-bold text-white bg-red-500 rounded-full shadow-sm">
            {notifications.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-2 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-[100] overflow-hidden"
          style={{ animation: 'notifSlideIn 0.15s ease-out' }}
        >
          <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-700">
            <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">通知</h3>
            {loading && <span className="text-xs text-hibi-sub dark:text-gray-400">更新中...</span>}
            {!loading && loadFailed && <span className="text-xs text-red-700 dark:text-red-300 font-bold">取得できませんでした</span>}
            {!loading && !loadFailed && notifications.length === 0 && <span className="text-xs text-green-700 dark:text-green-300 font-bold">問題なし</span>}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loadFailed && notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-hibi-sub dark:text-gray-400">
                通知を取得できませんでした。
                <button type="button" onClick={fetchNotifications} className="ml-2 underline font-bold text-hibi-navy dark:text-blue-300">もう一度</button>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-hibi-sub dark:text-gray-400">
                対応が必要な項目はありません
              </div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  className={`px-3 py-2.5 border-l-4 border-b border-gray-50 ${typeColor(n.type)}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-sm flex-shrink-0 mt-0.5">{n.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-800 dark:text-gray-200 leading-snug whitespace-pre-line">{n.message}</p>
                      {n.count !== undefined && n.count > 0 && (
                        <span className="inline-block mt-1 text-3xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                          {n.count}件
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    {n.href && (
                      <a href={n.href} onClick={() => setOpen(false)}
                        className="flex-1 text-center text-xs font-bold rounded-lg py-1.5 bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 transition">
                        開く →
                      </a>
                    )}
                    {n.action && (
                      <button
                        onClick={() => handleAction(n)}
                        disabled={acting === n.id}
                        className="flex-1 text-center text-xs font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg py-1.5 transition"
                      >
                        {acting === n.id ? '処理中...' : `✓ ${n.action.label}`}
                      </button>
                    )}
                    {n.messengerText && (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(n.messengerText!)
                          setCopiedId(n.id)
                          setTimeout(() => setCopiedId(null), 2000)
                        }}
                        className={`${n.action ? '' : 'flex-1'} text-center text-xs font-bold rounded-lg py-1.5 transition ${
                          copiedId === n.id
                            ? 'bg-green-100 text-green-700'
                            : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                        }`}
                      >
                        {copiedId === n.id ? '✓ コピー済み' : '📋 Messenger用コピー'}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes notifSlideIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  )
}

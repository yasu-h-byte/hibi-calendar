'use client'
// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: 行ごとの小さいボタンを RowButton にそろえた

import { useEffect, useState, useRef, useCallback } from 'react'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { getAuthPasswordSync } from '@/lib/hooks/useAuthPassword'
import { Icon, type IconName } from './ui/Icon'
import { RowButton, Chip } from './ui/PageParts'

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
    if (!(await confirmDialog({
      title: `有給 ${a.grantDays}日を付与しますか？`,
      description: `付与日 ${a.grantDate}・繰越 ${a.carryOver}日で記録します。\n付与すると本人の残日数に加わります。`,
      confirmLabel: '付与する',
    }))) return

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
        notify.failed('付与', res.error || 'サーバが受け付けませんでした')
      }
    } catch (e) {
      notify.failed('付与', e)
    } finally {
      setActing(null)
    }
  }

  // 2026-10-03: ポップアップを画面の型（白いカード・細枠・角丸・線のアイコン・札・行ボタン）に作り直した
  //   旧: 灰色の見出し帯・種類ごとの色つき帯・絵文字・灰色のボタン
  const KNOWN: IconName[] = ['alert', 'calendar', 'umbrella', 'unlock', 'clipboard', 'pen', 'clock', 'star', 'user', 'users', 'plane', 'receipt', 'bell', 'lock', 'doc', 'yen']
  const iconOf = (n: Notification): IconName =>
    (KNOWN as string[]).includes(n.icon) ? (n.icon as IconName) : n.type === 'info' ? 'bell' : 'alert'
  const toneOf = (type: Notification['type']) => type === 'error'
    ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : type === 'warning'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-200'
  const urgent = notifications.filter(n => n.type !== 'info').length

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => { setOpen(prev => !prev); if (!open) fetchNotifications() }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative w-9 h-9 flex items-center justify-center rounded-[10px] border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 transition"
        aria-label="通知"
      >
        <Icon name="bell" size={17} />
        {notifications.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 flex items-center justify-center px-1 text-xs font-bold text-white bg-red-500 rounded-full">
            {notifications.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="通知"
          className="absolute left-0 top-full mt-2 w-[360px] max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 shadow-xl z-[100] overflow-hidden animate-modalIn"
        >
          <div className="px-4 pt-3.5 pb-3 border-b border-hibi-line dark:border-gray-700 flex items-center gap-2">
            <h3 className="font-bold text-base text-gray-900 dark:text-white">通知</h3>
            {notifications.length > 0 && <Chip tone={urgent > 0 ? 'amber' : 'blue'}>{notifications.length}件</Chip>}
            <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">
              {loading ? '読み込んでいます' : loadFailed ? <span className="text-red-700 dark:text-red-300 font-bold">取得できませんでした</span> : '5分ごとに更新'}
            </span>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {loadFailed && notifications.length === 0 ? (
              <div className="px-4 py-7 text-center text-sm text-hibi-sub dark:text-gray-400 flex flex-col items-center gap-3">
                <span>通知を取得できませんでした。</span>
                <RowButton tone="ghost" onClick={fetchNotifications}>もう一度読み込む</RowButton>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-7 text-center text-sm text-hibi-sub dark:text-gray-400 flex flex-col items-center gap-2">
                <span className="w-10 h-10 rounded-full bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 flex items-center justify-center"><Icon name="check" size={20} /></span>
                <span>対応が必要なことはありません</span>
              </div>
            ) : (
              notifications.map(n => (
                <div key={n.id} className="px-4 py-3 border-b border-hibi-line dark:border-gray-700 last:border-b-0 flex gap-3">
                  <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${toneOf(n.type)}`} aria-hidden="true">
                    <Icon name={iconOf(n)} size={17} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-gray-100 leading-snug whitespace-pre-line break-words">{n.message}</p>
                    {n.count !== undefined && n.count > 0 && <div className="mt-1"><Chip tone="gray">{n.count}件</Chip></div>}
                    {(n.href || n.action || n.messengerText) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {n.href && (
                          <a href={n.href} onClick={() => setOpen(false)}
                            className="inline-flex items-center gap-1 h-8 px-3 rounded-lg text-xs font-bold bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 border border-gray-300 dark:border-gray-600 hover:bg-hibi-bg dark:hover:bg-gray-700 transition">
                            開く<Icon name="chevronRight" size={13} />
                          </a>
                        )}
                        {n.action && (
                          <RowButton tone="main" busy={acting === n.id} onClick={() => handleAction(n)}>{n.action.label}</RowButton>
                        )}
                        {n.messengerText && (
                          <RowButton tone="ghost" onClick={() => {
                            navigator.clipboard.writeText(n.messengerText!).catch(() => {})
                            setCopiedId(n.id)
                            setTimeout(() => setCopiedId(null), 2000)
                          }}>
                            <span className="inline-flex items-center gap-1">
                              <Icon name={copiedId === n.id ? 'check' : 'copy'} size={13} />{copiedId === n.id ? 'コピーしました' : 'Messenger用にコピー'}
                            </span>
                          </RowButton>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

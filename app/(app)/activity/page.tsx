'use client'

import { useEffect, useState, useCallback } from 'react'

interface ActivityEntry {
  id: string
  userId: string
  action: string
  details: string
  timestamp: string
}

const ACTION_LABELS: Record<string, string> = {
  'worker.add': '人員追加',
  'worker.update': '人員更新',
  'worker.delete': '人員削除',
  'site.add': '現場追加',
  'site.update': '現場更新',
  'site.delete': '現場削除',
  'calendar.submit': 'カレンダー提出',
  'calendar.approve': 'カレンダー承認',
  'calendar.reject': 'カレンダー差戻',
  'calendar.sign': 'カレンダー署名',
  'attendance.save': '出面保存',
  'monthly.lock': '月次締め',
  'monthly.unlock': '月次締め解除',
  'leave.grant': '有給付与',
  'leave.update': '有給更新',
  'subcon.add': '外注先追加',
  'subcon.update': '外注先更新',
  'subcon.delete': '外注先削除',
  'settings.update': '設定変更',
}

const ACTION_ICONS: Record<string, string> = {
  'worker': '\uD83D\uDC77',
  'site': '\uD83C\uDFD7',
  'calendar': '\uD83D\uDCC5',
  'attendance': '\uD83D\uDCCB',
  'monthly': '\uD83D\uDCCA',
  'leave': '\uD83C\uDF34',
  'subcon': '\uD83D\uDD27',
  'settings': '\u2699\uFE0F',
}

function getActionIcon(action: string): string {
  const prefix = action.split('.')[0]
  return ACTION_ICONS[prefix] || '\uD83D\uDCDD'
}

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] || action
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  const m = d.getMonth() + 1
  const day = d.getDate()
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${h}:${min}`
}

export default function ActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')

  // Filters
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        if (pw) setPassword(pw)
      } catch { /* ignore */ }
    }
  }, [])

  const fetchEntries = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)
      if (filterUser) params.set('userId', filterUser)
      if (filterAction) params.set('action', filterAction)

      const res = await fetch(`/api/activity?${params.toString()}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setEntries(data.entries || [])
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [password, startDate, endDate, filterUser, filterAction])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  // Unique users and actions for filter dropdowns
  const uniqueUsers = Array.from(new Set(entries.map(e => e.userId)))
  const uniqueActions = Array.from(new Set(entries.map(e => e.action)))

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-hibi-navy dark:text-white mb-4">アクティビティログ</h1>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">開始日</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">終了日</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">ユーザー</label>
            <select
              value={filterUser}
              onChange={e => setFilterUser(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white dark:bg-gray-700"
            >
              <option value="">すべて</option>
              {uniqueUsers.map(u => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">操作</label>
            <select
              value={filterAction}
              onChange={e => setFilterAction(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white dark:bg-gray-700"
            >
              <option value="">すべて</option>
              {uniqueActions.map(a => (
                <option key={a} value={a}>{getActionLabel(a)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400">読み込み中...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-400">アクティビティログはありません</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-28">日時</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-24">ユーザー</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-36">操作</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">詳細</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap font-mono text-xs">
                      {formatTimestamp(entry.timestamp)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {entry.userId}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                        <span>{getActionIcon(entry.action)}</span>
                        <span>{getActionLabel(entry.action)}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 max-w-xs truncate">
                      {entry.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        {entries.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 text-xs text-gray-400 dark:text-gray-500">
            {entries.length}件のログ（最大500件保持）
          </div>
        )}
      </div>
    </div>
  )
}

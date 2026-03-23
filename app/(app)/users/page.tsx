'use client'

import { useEffect, useState, useCallback } from 'react'

interface UserWorker {
  id: number
  name: string
  company: string
  jobType: string
  token: string
  hireDate: string
  retired: string
}

const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  yakuin: { label: '役員（admin）', cls: 'bg-red-100 text-red-700' },
  shokucho: { label: '職長（foreman）', cls: 'bg-blue-100 text-blue-700' },
}

function roleBadge(jobType: string) {
  return ROLE_BADGES[jobType] || { label: jobType || '—', cls: 'bg-gray-100 text-gray-500' }
}

export default function UsersPage() {
  const [workers, setWorkers] = useState<UserWorker[]>([])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw } = JSON.parse(stored)
      setPassword(pw)
    }
  }, [])

  const fetchWorkers = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        const all: UserWorker[] = data.workers || []
        // Only show workers who can log in (yakuin or shokucho)
        setWorkers(all.filter(w => ['yakuin', 'shokucho'].includes(w.jobType) && !w.retired))
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchWorkers() }, [fetchWorkers])

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">ユーザー管理</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">ログイン可能なユーザー一覧（役員・職長）</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-hibi-navy dark:text-white">{workers.length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">ユーザー数</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{workers.filter(w => w.jobType === 'yakuin').length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">役員</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{workers.filter(w => w.jobType === 'shokucho').length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">職長</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-4 py-3">名前</th>
              <th className="px-4 py-3">所属</th>
              <th className="px-4 py-3">ロール</th>
              <th className="px-4 py-3">トークン</th>
              <th className="px-4 py-3">ステータス</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : workers.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">対象ユーザーがいません</td></tr>
            ) : workers.map(w => {
              const badge = roleBadge(w.jobType)
              const hasToken = !!w.token
              return (
                <tr key={w.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
                  <td className="px-4 py-3 font-medium">{w.name}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${w.company === 'HFU' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {w.company}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {hasToken ? `${w.token.substring(0, 8)}...` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${hasToken ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {hasToken ? '有効' : 'トークン未発行'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

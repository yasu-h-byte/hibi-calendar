'use client'

import { useEffect, useState, useCallback } from 'react'

interface AccessRow {
  workerId: number
  workerName: string
  role: 'admin' | 'approver' | 'foreman' | 'jimu' | 'staff'
  currentRole: 'admin' | 'approver' | 'foreman' | 'jimu' | 'staff'
  jobType: string
  visa: string
  org: string
  lastAccessDate: string | null
  lastAccessAt: string | null
  accessCountLast7Days: number
}

/**
 * 人員マスタの jobType をそのまま表示するためのラベル・色定義
 * （人員マスタのバッジ表示と一致）
 */
function jobTypeBadge(row: AccessRow): { label: string; cls: string } {
  // workerId=0 の社長は「管理者」（人員マスタに無いケース）
  if (row.workerId === 0) return { label: '管理者', cls: 'bg-red-100 text-red-700' }
  switch (row.jobType) {
    case 'yakuin':   return { label: '役員', cls: 'bg-red-100 text-red-700' }
    case 'shokucho': return { label: '職長', cls: 'bg-blue-100 text-blue-700' }
    case 'tobi':     return { label: 'とび', cls: 'bg-green-100 text-green-700' }
    case 'doko':     return { label: '土工', cls: 'bg-gray-200 text-gray-600' }
    case 'jimu':     return { label: '事務', cls: 'bg-purple-100 text-purple-700' }
    default:
      // 在留資格ありなら外国人スタッフ
      if (row.visa && row.visa !== 'none') return { label: 'スタッフ', cls: 'bg-orange-100 text-orange-700' }
      return { label: '—', cls: 'bg-gray-100 text-gray-500' }
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const m = d.getMonth() + 1
  const day = d.getDate()
  const h = d.getHours()
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${h}:${mi}`
}

function daysAgo(dateStr: string | null): number | null {
  if (!dateStr) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.floor((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24))
  return diff
}

function statusBadge(dateStr: string | null) {
  const days = daysAgo(dateStr)
  if (days === null) return { label: '未アクセス', cls: 'bg-red-100 text-red-700', icon: '❌' }
  if (days === 0) return { label: '今日', cls: 'bg-green-100 text-green-700', icon: '🟢' }
  if (days === 1) return { label: '昨日', cls: 'bg-blue-100 text-blue-700', icon: '🔵' }
  if (days <= 3) return { label: `${days}日前`, cls: 'bg-gray-100 text-gray-700', icon: '⚪︎' }
  if (days <= 7) return { label: `${days}日前`, cls: 'bg-yellow-100 text-yellow-700', icon: '⚠️' }
  return { label: `${days}日前`, cls: 'bg-red-100 text-red-700', icon: '🚨' }
}

export default function AccessLogPage() {
  const [password, setPassword] = useState('')
  const [rows, setRows] = useState<AccessRow[]>([])
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(30)
  const [jobFilter, setJobFilter] = useState<'all' | 'yakuin' | 'shokucho' | 'tobi' | 'doko' | 'jimu' | 'staff' | 'admin'>('all')

  useEffect(() => {
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (auth) {
        const { password: pw } = JSON.parse(auth)
        setPassword(pw || '')
      }
    } catch { /* ignore */ }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch(`/api/access-log?days=${days}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setRows(data.rows || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [password, days])

  useEffect(() => { fetchData() }, [fetchData])

  const filtered = rows.filter(r => {
    if (jobFilter === 'all') return true
    if (jobFilter === 'admin') return r.workerId === 0
    if (jobFilter === 'staff') return r.jobType !== 'yakuin' && r.jobType !== 'shokucho' && r.jobType !== 'tobi' && r.jobType !== 'doko' && r.jobType !== 'jimu' && r.workerId !== 0 && r.visa && r.visa !== 'none'
    return r.jobType === jobFilter
  })

  // ソート: アクセスが新しい順（時刻まで含む）、未アクセスは最後
  filtered.sort((a, b) => {
    if (!a.lastAccessAt && !b.lastAccessAt) return a.workerName.localeCompare(b.workerName)
    if (!a.lastAccessAt) return 1
    if (!b.lastAccessAt) return -1
    return b.lastAccessAt.localeCompare(a.lastAccessAt)
  })

  // 統計
  const todayCount = filtered.filter(r => daysAgo(r.lastAccessDate) === 0).length
  const neverCount = filtered.filter(r => r.lastAccessDate === null).length
  const warningCount = filtered.filter(r => {
    const d = daysAgo(r.lastAccessDate)
    return d !== null && d >= 3
  }).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-bold text-hibi-navy flex items-center gap-2">
          🔐 アクセス履歴
        </h1>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value={7}>直近7日</option>
          <option value={30}>直近30日</option>
          <option value={90}>直近90日</option>
        </select>
        <select
          value={jobFilter}
          onChange={e => setJobFilter(e.target.value as typeof jobFilter)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="all">全職種</option>
          <option value="admin">管理者</option>
          <option value="yakuin">役員</option>
          <option value="shokucho">職長</option>
          <option value="tobi">とび</option>
          <option value="doko">土工</option>
          <option value="jimu">事務</option>
          <option value="staff">スタッフ（外国人）</option>
        </select>
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">対象人数</div>
          <div className="text-2xl font-bold text-hibi-navy">{filtered.length}名</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">今日アクセス</div>
          <div className="text-2xl font-bold text-green-600">{todayCount}名</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">3日以上未</div>
          <div className="text-2xl font-bold text-yellow-600">{warningCount}名</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-xs text-gray-500">未アクセス</div>
          <div className="text-2xl font-bold text-red-600">{neverCount}名</div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl shadow p-8 text-center text-gray-400">
          データがありません
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-hibi-navy text-white">
                <th className="text-left px-4 py-2">スタッフ</th>
                <th className="text-center px-2 py-2 w-24">職種</th>
                <th className="text-center px-2 py-2 w-20">会社</th>
                <th className="text-center px-2 py-2 w-32">最終アクセス</th>
                <th className="text-center px-2 py-2 w-28">状態</th>
                <th className="text-right px-3 py-2 w-28">7日アクセス</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const badge = statusBadge(r.lastAccessDate)
                const jobBadgeData = jobTypeBadge(r)
                return (
                  <tr key={r.workerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{r.workerName}</td>
                    <td className="text-center px-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${jobBadgeData.cls}`}>
                        {jobBadgeData.label}
                      </span>
                    </td>
                    <td className="text-center px-2 text-xs text-gray-500">
                      {r.org === 'hfu' ? 'HFU' : '日比'}
                    </td>
                    <td className="text-center px-2 tabular-nums text-xs">
                      {formatDateTime(r.lastAccessAt)}
                    </td>
                    <td className="text-center px-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${badge.cls}`}>
                        {badge.icon} {badge.label}
                      </span>
                    </td>
                    <td className="text-right px-3 tabular-nums text-gray-600">
                      {r.accessCountLast7Days}回
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        ※ アクセスログは過去90日分保存されます。IPはハッシュ化されて保存（個人特定不可）。
      </p>
    </div>
  )
}

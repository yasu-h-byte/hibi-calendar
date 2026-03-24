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

// All menu items that can be controlled
const ALL_MENUS = [
  { id: 'dashboard', label: 'ダッシュボード', section: 'メイン' },
  { id: 'attendance', label: '出面入力', section: 'メイン' },
  { id: 'calendar', label: '就業カレンダー', section: 'メイン' },
  { id: 'monthly', label: '月次集計', section: 'マスタ' },
  { id: 'workers', label: '人員マスタ', section: 'マスタ' },
  { id: 'sites', label: '現場マスタ', section: 'マスタ' },
  { id: 'subcons', label: '外注先マスタ', section: 'マスタ' },
  { id: 'leave', label: '有給管理', section: '管理' },
  { id: 'cost', label: '原価・収益', section: '管理' },
  { id: 'export', label: '帳票出力', section: '管理' },
  { id: 'users', label: 'ユーザー管理', section: 'システム' },
  { id: 'settings', label: '管理者設定', section: 'システム' },
  { id: 'activity', label: 'アクティビティ', section: 'システム' },
]

// Configurable roles (admin always has full access)
const CONFIGURABLE_ROLES = [
  { id: 'approver', label: '役員' },
  { id: 'foreman', label: '職長' },
  { id: 'jimu', label: '事務' },
]

// Default permissions (used when no Firestore data exists)
const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  approver: ['dashboard', 'attendance', 'calendar', 'monthly', 'leave'],
  foreman: ['attendance', 'calendar'],
  jimu: ['dashboard', 'monthly', 'workers', 'sites', 'subcons', 'leave', 'cost', 'export'],
}

const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  yakuin: { label: '役員（admin）', cls: 'bg-red-100 text-red-700' },
  shokucho: { label: '職長（foreman）', cls: 'bg-blue-100 text-blue-700' },
  jimu: { label: '事務', cls: 'bg-purple-100 text-purple-700' },
}

function roleBadge(jobType: string) {
  return ROLE_BADGES[jobType] || { label: jobType || '—', cls: 'bg-gray-100 text-gray-500' }
}

export default function UsersPage() {
  const [workers, setWorkers] = useState<UserWorker[]>([])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [permissions, setPermissions] = useState<Record<string, string[]>>(DEFAULT_PERMISSIONS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw } = JSON.parse(stored)
      setPassword(pw)
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const [workersRes, permRes] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/settings?action=getPermissions', { headers: { 'x-admin-password': password } }),
      ])
      if (workersRes.ok) {
        const data = await workersRes.json()
        const all: UserWorker[] = data.workers || []
        setWorkers(all.filter(w => ['yakuin', 'shokucho', 'jimu'].includes(w.jobType) && !w.retired))
      }
      if (permRes.ok) {
        const data = await permRes.json()
        if (data.rolePermissions && Object.keys(data.rolePermissions).length > 0) {
          setPermissions(data.rolePermissions)
        }
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  const togglePermission = (roleId: string, menuId: string) => {
    setPermissions(prev => {
      const current = prev[roleId] || []
      const next = current.includes(menuId)
        ? current.filter(m => m !== menuId)
        : [...current, menuId]
      return { ...prev, [roleId]: next }
    })
    setSaved(false)
  }

  const savePermissions = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'savePermissions', rolePermissions: permissions }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  // Group menus by section
  const sections = ALL_MENUS.reduce<Record<string, typeof ALL_MENUS>>((acc, m) => {
    if (!acc[m.section]) acc[m.section] = []
    acc[m.section].push(m)
    return acc
  }, {})

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">ユーザー管理</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">ログインユーザー・ロール別権限の管理</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-purple-600">{workers.filter(w => w.jobType === 'jimu').length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">事務</div>
        </div>
      </div>

      {/* User Table */}
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

      {/* Role Permissions */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white">ロール別権限設定</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              adminロールは常に全権限を持ちます。チェックを変更後「保存」を押してください。
            </p>
          </div>
          <button
            onClick={savePermissions}
            disabled={saving}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
              saved
                ? 'bg-green-100 text-green-700'
                : 'bg-hibi-navy text-white hover:bg-hibi-light'
            } disabled:opacity-50`}
          >
            {saving ? '保存中...' : saved ? '✓ 保存済み' : '保存'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-40" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr className="border-b-2 dark:border-gray-600">
                <th className="text-left px-3 py-3 text-gray-600 dark:text-gray-400">メニュー</th>
                <th className="text-center px-3 py-3">
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">admin</span>
                </th>
                {CONFIGURABLE_ROLES.map(r => (
                  <th key={r.id} className="text-center px-3 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      r.id === 'approver' ? 'bg-orange-100 text-orange-700' :
                      r.id === 'foreman' ? 'bg-blue-100 text-blue-700' :
                      'bg-purple-100 text-purple-700'
                    }`}>{r.label.split('（')[0]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(sections).map(([section, menus]) => (
                <>
                  <tr key={`section-${section}`}>
                    <td colSpan={2 + CONFIGURABLE_ROLES.length} className="px-3 pt-4 pb-1 text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                      {section}
                    </td>
                  </tr>
                  {menus.map(menu => (
                    <tr key={menu.id} className="border-t dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300">{menu.label}</td>
                      <td className="text-center px-3 py-2.5">
                        <input type="checkbox" checked disabled className="w-4 h-4 accent-red-600 cursor-not-allowed opacity-50" />
                      </td>
                      {CONFIGURABLE_ROLES.map(r => (
                        <td key={r.id} className="text-center px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={(permissions[r.id] || []).includes(menu.id)}
                            onChange={() => togglePermission(r.id, menu.id)}
                            className="w-4 h-4 accent-hibi-navy cursor-pointer"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

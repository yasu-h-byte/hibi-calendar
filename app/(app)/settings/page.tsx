'use client'

import { useEffect, useState, useCallback } from 'react'

interface DefaultRates {
  tobiRate: number
  dokoRate: number
  baseDays: number
}

interface BackupPreview {
  workerCount: number
  siteCount: number
  subconCount: number
  hasAttendance: boolean
  attendanceMonths: number
  hasCalendars: boolean
  raw: Record<string, unknown>
}

interface ActivityEntry {
  id: string
  userId: string
  action: string
  details: string
  timestamp: string
}

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
  { id: 'evaluation', label: '評価管理', section: '管理' },
  { id: 'cost', label: '原価・収益', section: '管理' },
  { id: 'export', label: '帳票出力', section: '管理' },
  { id: 'users', label: 'ユーザー管理', section: 'システム' },
  { id: 'settings', label: '管理者設定', section: 'システム' },
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
  'rates.default': 'デフォルト単価変更',
  'rates.site': '現場単価変更',
}

const ACTION_ICONS: Record<string, string> = {
  'worker': '👷',
  'site': '🏗',
  'calendar': '📅',
  'attendance': '📋',
  'monthly': '📊',
  'leave': '🌴',
  'subcon': '🔧',
  'settings': '⚙️',
  'rates': '💰',
}

function getActionIcon(action: string): string {
  const prefix = action.split('.')[0]
  return ACTION_ICONS[prefix] || '📝'
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

type Tab = 'settings' | 'activity' | 'users'

export default function SettingsPage() {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('settings')

  // Default rates
  const [rates, setRates] = useState<DefaultRates>({ tobiRate: 0, dokoRate: 0, baseDays: 20 })

  // User passwords
  const [userPasswords, setUserPasswords] = useState<Record<string, string>>({})
  const [pwWorkers, setPwWorkers] = useState<{ id: number; name: string; jobType: string }[]>([])
  const [savingPw, setSavingPw] = useState(false)

  // Backup/Restore
  const [exporting, setExporting] = useState(false)
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // Activity
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')

  // Users
  const [userWorkers, setUserWorkers] = useState<UserWorker[]>([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [permissions, setPermissions] = useState<Record<string, string[]> | null>(null)
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [savedPermissions, setSavedPermissions] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        if (pw) setPassword(pw)
      } catch { /* ignore */ }
    }
  }, [])

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const fetchRates = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/settings', {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) throw new Error('Unauthorized')
      const data = await res.json()
      setRates({ tobiRate: 0, dokoRate: 0, baseDays: 20, ...data.defaultRates })
    } catch {
      showMessage('error', '設定の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [password])

  const fetchUserPasswords = useCallback(async () => {
    if (!password) return
    try {
      const [pwRes, wRes] = await Promise.all([
        fetch('/api/settings?action=getUserPasswords', { headers: { 'x-admin-password': password } }),
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
      ])
      if (pwRes.ok) {
        const data = await pwRes.json()
        setUserPasswords(data.userPasswords || {})
      }
      if (wRes.ok) {
        const data = await wRes.json()
        setPwWorkers(
          (data.workers || [])
            .filter((w: { retired?: string; jobType?: string }) => !w.retired && (w.jobType === 'yakuin' || w.jobType === 'jimu'))
            .map((w: { id: number; name: string; jobType: string }) => ({ id: w.id, name: w.name, jobType: w.jobType }))
        )
      }
    } catch { /* ignore */ }
  }, [password])

  const fetchActivity = useCallback(async () => {
    if (!password) return
    setActivityLoading(true)
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
        setActivityEntries(data.entries || [])
      }
    } catch {
      // silent
    } finally {
      setActivityLoading(false)
    }
  }, [password, startDate, endDate, filterUser, filterAction])

  const fetchUsers = useCallback(async () => {
    if (!password) return
    setUsersLoading(true)
    try {
      const [workersRes, permRes] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/settings?action=getPermissions', { headers: { 'x-admin-password': password } }),
      ])
      if (workersRes.ok) {
        const data = await workersRes.json()
        const all: UserWorker[] = data.workers || []
        setUserWorkers(all.filter(w => ['yakuin', 'shokucho', 'jimu'].includes(w.jobType) && !w.retired))
      }
      if (permRes.ok) {
        const data = await permRes.json()
        if (data.rolePermissions && Object.keys(data.rolePermissions).length > 0) {
          setPermissions(data.rolePermissions)
        } else {
          setPermissions(DEFAULT_PERMISSIONS)
        }
      } else {
        setPermissions(DEFAULT_PERMISSIONS)
      }
    } finally {
      setUsersLoading(false)
    }
  }, [password])

  const togglePermission = (roleId: string, menuId: string) => {
    setPermissions(prev => {
      if (!prev) return prev
      const current = prev[roleId] || []
      const next = current.includes(menuId)
        ? current.filter(m => m !== menuId)
        : [...current, menuId]
      return { ...prev, [roleId]: next }
    })
    setSavedPermissions(false)
  }

  const savePermissions = async () => {
    setSavingPermissions(true)
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'savePermissions', rolePermissions: permissions }),
      })
      setSavedPermissions(true)
      setTimeout(() => setSavedPermissions(false), 2000)
    } finally {
      setSavingPermissions(false)
    }
  }

  useEffect(() => {
    if (password) { fetchRates(); fetchUserPasswords() }
  }, [password, fetchRates, fetchUserPasswords])

  // Fetch activity when tab is switched or filters change
  useEffect(() => {
    if (activeTab === 'activity' && password) fetchActivity()
  }, [activeTab, fetchActivity, password])

  // Fetch users when tab is switched
  useEffect(() => {
    if (activeTab === 'users' && password) fetchUsers()
  }, [activeTab, fetchUsers, password])

  const handleSaveRates = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          action: 'saveDefaultRates',
          tobiRate: rates.tobiRate,
          dokoRate: rates.dokoRate,
          baseDays: rates.baseDays,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      showMessage('success', 'デフォルト単価を保存しました')
    } catch {
      showMessage('error', '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'backup' }),
      })
      if (!res.ok) throw new Error('Export failed')
      const data = await res.json()

      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const filename = `hibi-backup-${dateStr}.json`
      const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      showMessage('success', `${filename} をダウンロードしました`)
    } catch {
      showMessage('error', 'エクスポートに失敗しました')
    } finally {
      setExporting(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const raw = JSON.parse(evt.target?.result as string) as Record<string, unknown>
        const workers = Array.isArray(raw.workers) ? raw.workers : []
        const sites = Array.isArray(raw.sites) ? raw.sites : []
        const subcons = Array.isArray(raw.subcons) ? raw.subcons : []
        const attDocs = (raw._attDocs || {}) as Record<string, unknown>
        const attMonthCount = Object.keys(attDocs).filter(k => k.startsWith('att_')).length
        setImportPreview({
          workerCount: workers.length,
          siteCount: sites.length,
          subconCount: subcons.length,
          hasAttendance: attMonthCount > 0 || !!raw.attend,
          attendanceMonths: attMonthCount,
          hasCalendars: !!raw.calendars,
          raw,
        })
      } catch {
        showMessage('error', 'JSONファイルの読み込みに失敗しました')
        setImportPreview(null)
      }
    }
    reader.readAsText(file)
  }

  const handleRestore = async () => {
    if (!importPreview) return
    setRestoring(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'restore', data: importPreview.raw }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Restore failed')
      }
      showMessage('success', 'データをリストアしました')
      setImportPreview(null)
      setShowConfirm(false)
      fetchRates()
    } catch (err) {
      showMessage('error', `リストアに失敗しました: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestoring(false)
    }
  }

  const adjustRate = (field: 'tobiRate' | 'dokoRate' | 'baseDays', delta: number) => {
    setRates(prev => {
      let val = prev[field] + delta
      if (field === 'baseDays') val = Math.min(31, Math.max(1, val))
      else val = Math.max(0, val)
      return { ...prev, [field]: val }
    })
  }

  /** 数値をカンマ区切り文字列に変換 */
  const fmt = (n: number) => n.toLocaleString('ja-JP')
  /** カンマ区切り文字列を数値に変換 */
  const parseRate = (s: string) => Number(s.replace(/,/g, '')) || 0

  if (loading && password) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">読み込み中...</div>
      </div>
    )
  }

  // Activity tab unique values for filters
  const uniqueUsers = Array.from(new Set(activityEntries.map(e => e.userId)))
  const uniqueActions = Array.from(new Set(activityEntries.map(e => e.action)))

  // Users tab: group menus by section
  const permissionSections = ALL_MENUS.reduce<Record<string, typeof ALL_MENUS>>((acc, m) => {
    if (!acc[m.section]) acc[m.section] = []
    acc[m.section].push(m)
    return acc
  }, {})

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-hibi-navy dark:text-white mb-4">管理者設定</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition ${
            activeTab === 'settings'
              ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          ⚙️ 設定
        </button>
        <button
          onClick={() => setActiveTab('activity')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition ${
            activeTab === 'activity'
              ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          📝 アクティビティ
        </button>
        <button
          onClick={() => setActiveTab('users')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition ${
            activeTab === 'users'
              ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          👤 ユーザー
        </button>
      </div>

      {/* Message toast */}
      {message && (
        <div className={`p-3 rounded-lg text-sm font-medium mb-4 ${
          message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      {/* ===== Settings Tab ===== */}
      {activeTab === 'settings' && (
        <div className="max-w-2xl space-y-6">
          {/* Default Rates Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">デフォルト単価エディタ</h2>

            <div className="space-y-4">
              {/* Tobi Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">鳶基本単価</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('tobiRate', -1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1000
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={fmt(rates.tobiRate)}
                    onChange={e => setRates(prev => ({ ...prev, tobiRate: parseRate(e.target.value) }))}
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('tobiRate', 1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1000
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
                </div>
              </div>

              {/* Doko Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">土工基本単価</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('dokoRate', -1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1000
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={fmt(rates.dokoRate)}
                    onChange={e => setRates(prev => ({ ...prev, dokoRate: parseRate(e.target.value) }))}
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('dokoRate', 1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1000
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
                </div>
              </div>

              {/* Base Days */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">基本給ベース日数（外国人・3層構造）</label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  基本給（固定）= 時給 × ベース日数 × 7h。この日数を超えた出勤分は追加所定手当として支給。
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('baseDays', -1)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rates.baseDays}
                    onChange={e => setRates(prev => ({ ...prev, baseDays: Math.min(31, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) }))}
                    className="w-20 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('baseDays', 1)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">日</span>
                </div>
              </div>
            </div>

            <button
              onClick={handleSaveRates}
              disabled={saving}
              className="mt-4 w-full bg-hibi-navy text-white py-2.5 rounded-lg font-medium hover:bg-hibi-navy/90 disabled:opacity-50 transition"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>

          {/* User Passwords Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-2">個人パスワード設定</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              役員・事務スタッフの個人ログインパスワード。設定すると名前選択なしで直接ログインできます。
            </p>
            <div className="space-y-3">
              {pwWorkers.map(w => (
                <div key={w.id} className="flex items-center gap-3">
                  <span className="text-sm font-medium w-28">{w.name}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${w.jobType === 'yakuin' ? 'bg-red-100 text-red-700' : 'bg-purple-100 text-purple-700'}`}>
                    {w.jobType === 'yakuin' ? '役員' : '事務'}
                  </span>
                  <input
                    type="text"
                    value={userPasswords[String(w.id)] || ''}
                    onChange={e => setUserPasswords(prev => ({ ...prev, [String(w.id)]: e.target.value }))}
                    placeholder="パスワード未設定"
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
              ))}
            </div>
            {pwWorkers.length > 0 && (
              <button
                onClick={async () => {
                  setSavingPw(true)
                  try {
                    const res = await fetch('/api/settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                      body: JSON.stringify({ action: 'saveUserPasswords', userPasswords }),
                    })
                    if (res.ok) showMessage('success', '個人パスワードを保存しました')
                    else showMessage('error', '保存に失敗しました')
                  } catch { showMessage('error', 'エラーが発生しました') }
                  finally { setSavingPw(false) }
                }}
                disabled={savingPw}
                className="mt-4 bg-hibi-navy text-white rounded-lg px-4 py-2 text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
              >
                {savingPw ? '保存中...' : '保存'}
              </button>
            )}
          </div>

          {/* Backup Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">バックアップ</h2>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              現在のデータベース全体をJSONファイルとしてダウンロードします。
            </p>

            <button
              onClick={handleExport}
              disabled={exporting}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {exporting ? 'エクスポート中...' : 'JSONエクスポート'}
            </button>
          </div>

          {/* Restore Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">リストア</h2>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              バックアップJSONファイルからデータを復元します。現在のデータは上書きされます。
            </p>

            <input
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-200 file:text-gray-700 hover:file:bg-gray-300"
            />

            {/* Preview */}
            {importPreview && (
              <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-700">
                <h3 className="font-medium text-gray-800 dark:text-gray-200 mb-2">インポートデータのプレビュー</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-gray-600 dark:text-gray-400">作業員数:</div>
                  <div className="font-medium">{importPreview.workerCount}名</div>
                  <div className="text-gray-600 dark:text-gray-400">現場数:</div>
                  <div className="font-medium">{importPreview.siteCount}件</div>
                  <div className="text-gray-600 dark:text-gray-400">外注先数:</div>
                  <div className="font-medium">{importPreview.subconCount}件</div>
                  <div className="text-gray-600 dark:text-gray-400">出面データ:</div>
                  <div className="font-medium">
                    {importPreview.hasAttendance ? `あり${importPreview.attendanceMonths > 0 ? `（${importPreview.attendanceMonths}ヶ月分）` : ''}` : 'なし'}
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">カレンダーデータ:</div>
                  <div className="font-medium">{importPreview.hasCalendars ? 'あり' : 'なし'}</div>
                </div>

                {!showConfirm ? (
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="mt-4 w-full bg-orange-500 text-white py-2.5 rounded-lg font-medium hover:bg-orange-600 transition"
                  >
                    リストア実行
                  </button>
                ) : (
                  <div className="mt-4 space-y-2">
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                      本当にリストアしますか？現在のデータは全て上書きされます。この操作は取り消せません。
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowConfirm(false)}
                        className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 py-2.5 rounded-lg font-medium hover:bg-gray-300 dark:hover:bg-gray-500 transition"
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={handleRestore}
                        disabled={restoring}
                        className="flex-1 bg-red-600 text-white py-2.5 rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition"
                      >
                        {restoring ? 'リストア中...' : '確定する'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Activity Tab ===== */}
      {activeTab === 'activity' && (
        <div>
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
            {activityLoading ? (
              <div className="p-8 text-center text-gray-400">読み込み中...</div>
            ) : activityEntries.length === 0 ? (
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
                    {activityEntries.map((entry) => (
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
            {activityEntries.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 text-xs text-gray-400 dark:text-gray-500">
                {activityEntries.length}件のログ（最大500件保持）
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Users Tab ===== */}
      {activeTab === 'users' && (
        <div className="space-y-6">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">ログインユーザー・ロール別権限の管理</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">※ ロールは人員マスタの職種で決まります（役員→管理者、職長→職長、事務→事務）。変更するには人員マスタで職種を変更してください。</p>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-hibi-navy dark:text-white">{userWorkers.length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">ユーザー数</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-red-600">{userWorkers.filter(w => w.jobType === 'yakuin').length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">役員</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-blue-600">{userWorkers.filter(w => w.jobType === 'shokucho').length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">職長</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-purple-600">{userWorkers.filter(w => w.jobType === 'jimu').length}</div>
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
                {usersLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">読み込み中...</td></tr>
                ) : userWorkers.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">対象ユーザーがいません</td></tr>
                ) : userWorkers.map(w => {
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
                        <a href="/workers" className="ml-2 text-[10px] text-blue-500 hover:underline">変更</a>
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
                disabled={savingPermissions || !permissions}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
                  savedPermissions
                    ? 'bg-green-100 text-green-700'
                    : 'bg-hibi-navy text-white hover:bg-hibi-light'
                } disabled:opacity-50`}
              >
                {savingPermissions ? '保存中...' : savedPermissions ? '✓ 保存済み' : '保存'}
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
                  {Object.entries(permissionSections).map(([section, menus]) => (
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
                                checked={permissions ? (permissions[r.id] || []).includes(menu.id) : false}
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
      )}
    </div>
  )
}

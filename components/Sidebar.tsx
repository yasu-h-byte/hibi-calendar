'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { AuthUser } from '@/types'
import { initTheme, toggleTheme, type Theme } from '@/lib/theme'
import NotificationBell from './NotificationBell'

interface MenuItem {
  label: string
  icon: string
  href?: string
  external?: string
  section: string
  roles: string[]
}

const DEMMEN_URL = 'https://dedura-kanri.web.app'

function buildMenuItems(user: AuthUser): MenuItem[] {
  // 職長はforeman画面へ、admin/approverはPC出面入力へ
  const attItem: MenuItem = user.role === 'foreman' && user.token
    ? { label: '出面入力', icon: '📋', href: `/attendance/foreman/${user.token}`, section: 'メイン', roles: ['foreman'] }
    : { label: '出面入力', icon: '📋', href: '/attendance', section: 'メイン', roles: ['admin', 'approver'] }

  return [
    // メイン
    { label: 'ダッシュボード', icon: '📊', href: '/dashboard', section: 'メイン', roles: ['admin', 'approver', 'jimu'] },
    attItem,
    { label: '就業カレンダー', icon: '📅', href: '/calendar', section: 'メイン', roles: ['admin', 'approver', 'foreman'] },
  // マスタ
  { label: '月次集計', icon: '📋', href: '/monthly', section: 'マスタ', roles: ['admin', 'approver', 'jimu'] },
  { label: '人員マスタ', icon: '👷', href: '/workers', section: 'マスタ', roles: ['admin', 'jimu'] },
  { label: '現場マスタ', icon: '🏗', href: '/sites', section: 'マスタ', roles: ['admin', 'jimu'] },
  { label: '外注先マスタ', icon: '🔧', href: '/subcons', section: 'マスタ', roles: ['admin', 'jimu'] },
  // 管理
  { label: '有給管理', icon: '🌴', href: '/leave', section: '管理', roles: ['admin', 'approver', 'jimu'] },
  { label: '有給申請', icon: '📝', href: '/leave-requests', section: '管理', roles: ['admin', 'approver'] },
  { label: '原価・収益', icon: '💰', href: '/cost', section: '管理', roles: ['admin', 'jimu'] },
  { label: '帳票出力', icon: '📑', href: '/export', section: '管理', roles: ['admin', 'jimu'] },
  // システム
  { label: 'ユーザー管理', icon: '👤', href: '/users', section: 'システム', roles: ['admin'] },
  { label: '管理者設定', icon: '⚙️', href: '/settings', section: 'システム', roles: ['admin'] },
  { label: 'アクティビティ', icon: '📝', href: '/activity', section: 'システム', roles: ['admin'] },
  { label: '運用ガイド', icon: '📖', href: '/guide', section: 'システム', roles: ['admin', 'approver', 'jimu', 'foreman'] },
  ]
}

/** Sun icon for light mode */
function SunIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  )
}

/** Moon icon for dark mode */
function MoonIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
  )
}

// Menu ID mapping for permission check
const MENU_ID_MAP: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/attendance': 'attendance',
  '/calendar': 'calendar',
  '/monthly': 'monthly',
  '/workers': 'workers',
  '/sites': 'sites',
  '/subcons': 'subcons',
  '/leave': 'leave',
  '/leave-requests': 'leave-requests',
  '/cost': 'cost',
  '/export': 'export',
  '/users': 'users',
  '/settings': 'settings',
  '/activity': 'activity',
  '/guide': 'guide',
}

export default function Sidebar({ user, open, onClose }: { user: AuthUser; open: boolean; onClose: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const [theme, setThemeState] = useState<Theme>('light')
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]> | null>(null)

  useEffect(() => {
    setThemeState(initTheme())
    // Load role permissions from localStorage (set during login or settings save)
    try {
      const stored = localStorage.getItem('hibi_role_permissions')
      if (stored) setRolePermissions(JSON.parse(stored))
    } catch { /* ignore */ }
    // Also fetch from API to get latest
    const auth = localStorage.getItem('hibi_auth')
    if (auth) {
      const { password } = JSON.parse(auth)
      fetch('/api/settings?action=getPermissions', { headers: { 'x-admin-password': password } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.rolePermissions && Object.keys(data.rolePermissions).length > 0) {
            setRolePermissions(data.rolePermissions)
            localStorage.setItem('hibi_role_permissions', JSON.stringify(data.rolePermissions))
          }
        })
        .catch(() => {})
    }
  }, [])

  const menuItems = buildMenuItems(user)

  // Apply permission filtering
  const filteredItems = menuItems.filter(item => {
    // admin always sees everything
    if (user.role === 'admin') return true
    // Use static role list as default, override with Firestore permissions if available
    const perms = rolePermissions?.[user.role]
    if (perms) {
      const menuId = item.href ? MENU_ID_MAP[item.href] : null
      if (menuId) return perms.includes(menuId)
      // For foreman attendance with token URL, check 'attendance'
      if (item.href?.startsWith('/attendance/foreman/')) return perms.includes('attendance')
      return false
    }
    // Fallback to hardcoded roles
    return item.roles.includes(user.role)
  })

  const sections = Array.from(new Set(filteredItems.map(i => i.section)))

  const handleClick = (item: MenuItem) => {
    if (item.href) {
      router.push(item.href)
    } else if (item.external) {
      window.open(item.external, '_blank')
    }
    onClose()
  }

  const handleLogout = () => {
    localStorage.removeItem('hibi_auth')
    router.push('/')
  }

  const handleToggleTheme = () => {
    const next = toggleTheme()
    setThemeState(next)
  }

  return (
    <>
      {/* Overlay for mobile */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`fixed top-0 left-0 h-full w-52 bg-hibi-navy dark:bg-gray-950 text-white z-50 transform transition-transform duration-200 lg:translate-x-0 flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header - Logo */}
        <div className="px-3 pt-3 pb-2 border-b border-white/10">
          <div className="bg-white rounded-lg p-1.5 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="HIBI CONSTRUCTION" className="w-full max-w-[160px]" />
          </div>
        </div>

        {/* User info */}
        <div className="px-4 py-3 border-b border-white/10 bg-white/5 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-white/50 mt-0.5">
              {user.role === 'approver' ? '事業責任者' : user.role === 'foreman' ? '職長' : '管理者'}
            </div>
          </div>
          {user.role === 'admin' && <NotificationBell />}
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-2">
          {sections.map(section => (
            <div key={section}>
              <div className="px-3 py-1.5 text-[10px] text-white/40 uppercase tracking-wider">
                {section}
              </div>
              {filteredItems
                .filter(item => item.section === section)
                .map(item => {
                  const isActive = item.href && pathname === item.href
                  const isExternal = !!item.external
                  return (
                    <button
                      key={item.label}
                      onClick={() => handleClick(item)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px] transition ${
                        isActive
                          ? 'bg-white/20 text-white font-medium'
                          : 'text-white/80 hover:bg-white/10'
                      }`}
                    >
                      <span>{item.icon}</span>
                      <span className="flex-1">{item.label}</span>
                      {isExternal && (
                        <span className="text-white/30 text-xs">↗</span>
                      )}
                    </button>
                  )
                })}
            </div>
          ))}
        </nav>

        {/* Theme toggle + Logout */}
        <div className="p-4 border-t border-white/10 space-y-3">
          {/* Dark mode toggle */}
          <button
            onClick={handleToggleTheme}
            className="w-full flex items-center justify-between px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition"
          >
            <div className="flex items-center gap-2 text-sm text-white/70">
              {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
              <span>{theme === 'dark' ? 'ダークモード' : 'ライトモード'}</span>
            </div>
            {/* Toggle switch */}
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${
                theme === 'dark' ? 'bg-blue-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  theme === 'dark' ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </div>
          </button>

          <button
            onClick={handleLogout}
            className="w-full text-left text-sm text-white/60 hover:text-white transition"
          >
            ログアウト
          </button>
          <div className="text-xs text-white/30 text-center mt-2">v2.0</div>
        </div>
      </aside>
    </>
  )
}

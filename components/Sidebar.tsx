'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { AuthUser } from '@/types'
import { initTheme, getFontSize, toggleFontSize, type FontSize } from '@/lib/theme'
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
  { label: '月次集計・帳票', icon: '📋', href: '/monthly', section: 'マスタ', roles: ['admin', 'approver', 'jimu'] },
  { label: '人員マスタ', icon: '👷', href: '/workers', section: 'マスタ', roles: ['admin', 'jimu'] },
  { label: '現場マスタ', icon: '🏗', href: '/sites', section: 'マスタ', roles: ['admin', 'jimu'] },
  { label: '外注先マスタ', icon: '🔧', href: '/subcons', section: 'マスタ', roles: ['admin', 'jimu'] },
  // 管理
  { label: '有給管理', icon: '🌴', href: '/leave', section: '管理', roles: ['admin', 'approver', 'jimu'] },
  { label: '評価管理', icon: '📋', href: '/evaluation', section: '管理', roles: ['admin', 'approver'] },
  { label: '原価・収益', icon: '💰', href: '/cost', section: '管理', roles: ['admin', 'jimu'] },
  // システム
  { label: '管理者設定', icon: '⚙️', href: '/settings', section: 'システム', roles: ['admin'] },
  { label: '資料一覧', icon: '📁', href: '/docs', section: 'システム', roles: ['admin', 'approver', 'jimu', 'foreman'] },
  ]
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
  '/evaluation': 'evaluation',
  '/cost': 'cost',
  '/settings': 'settings',
  '/guide': 'guide',
  '/docs': 'docs',
}

/** Text size icon (Aa) */
function TextSizeIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <text x="2" y="18" fontSize="16" fontWeight="bold" fontFamily="sans-serif">A</text>
      <text x="14" y="18" fontSize="11" fontWeight="bold" fontFamily="sans-serif">a</text>
    </svg>
  )
}

export default function Sidebar({ user, open, onClose }: { user: AuthUser; open: boolean; onClose: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const [fontSize, setFontSizeState] = useState<FontSize>('normal')
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]> | null>(null)

  useEffect(() => {
    initTheme()
    setFontSizeState(getFontSize())
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

  const handleToggleFontSize = () => {
    const next = toggleFontSize()
    setFontSizeState(next)
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
          <NotificationBell role={user.role} />
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

        {/* Font size + Logout */}
        <div className="p-4 border-t border-white/10 space-y-3">
          {/* Font size toggle */}
          <button
            onClick={handleToggleFontSize}
            className="w-full flex items-center justify-between px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition"
          >
            <div className="flex items-center gap-2 text-sm text-white/70">
              <TextSizeIcon />
              <span>大きい文字</span>
            </div>
            {/* Toggle switch */}
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${
                fontSize === 'large' ? 'bg-blue-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  fontSize === 'large' ? 'translate-x-5' : 'translate-x-0.5'
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

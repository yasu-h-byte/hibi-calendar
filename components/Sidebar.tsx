'use client'

import { usePathname, useRouter } from 'next/navigation'
import { AuthUser } from '@/types'

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
  // 職長はforeman画面へ、admin/approverは旧アプリへ
  const attItem: MenuItem = user.role === 'foreman' && user.token
    ? { label: '出面入力', icon: '📋', href: `/attendance/foreman/${user.token}`, section: 'メイン', roles: ['foreman'] }
    : { label: '出面入力', icon: '📋', external: `${DEMMEN_URL}?role=input`, section: 'メイン', roles: ['admin', 'approver'] }

  return [
    // メイン
    { label: 'ダッシュボード', icon: '📊', href: '/dashboard', section: 'メイン', roles: ['admin', 'approver'] },
    attItem,
    { label: '就業カレンダー', icon: '📅', href: '/calendar', section: 'メイン', roles: ['admin', 'approver', 'foreman'] },
  // マスタ
  { label: '月次集計', icon: '📋', href: '/monthly', section: 'マスタ', roles: ['admin', 'approver'] },
  { label: '人員マスタ', icon: '👷', href: '/workers', section: 'マスタ', roles: ['admin'] },
  { label: '現場マスタ', icon: '🏗', href: '/sites', section: 'マスタ', roles: ['admin'] },
  // 管理
  { label: '有給管理', icon: '🌴', href: '/leave', section: '管理', roles: ['admin', 'approver'] },
  { label: '原価・収益', icon: '💰', href: '/cost', section: '管理', roles: ['admin'] },
  ]
}

export default function Sidebar({ user, open, onClose }: { user: AuthUser; open: boolean; onClose: () => void }) {
  const pathname = usePathname()
  const router = useRouter()

  const menuItems = buildMenuItems(user)
  const filteredItems = menuItems.filter(item => item.roles.includes(user.role))

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

  return (
    <>
      {/* Overlay for mobile */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-hibi-navy text-white z-50 transform transition-transform duration-200 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <h1 className="font-bold text-lg">HIBI CONSTRUCTION</h1>
          <p className="text-xs text-white/60 mt-1">鳶事業部</p>
        </div>

        {/* User info */}
        <div className="px-4 py-3 border-b border-white/10 bg-white/5">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="text-xs text-white/50 mt-0.5">
            {user.role === 'approver' ? '事業責任者' : user.role === 'foreman' ? '職長' : '管理者'}
          </div>
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-2">
          {sections.map(section => (
            <div key={section}>
              <div className="px-4 py-2 text-xs text-white/40 uppercase tracking-wider">
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
                      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm transition ${
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

        {/* Logout */}
        <div className="p-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="w-full text-left text-sm text-white/60 hover:text-white transition"
          >
            ログアウト
          </button>
        </div>
      </aside>
    </>
  )
}

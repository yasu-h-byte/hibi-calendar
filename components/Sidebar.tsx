'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { AuthUser } from '@/types'
import { initTheme, getFontSize, toggleFontSize, type FontSize } from '@/lib/theme'
import NotificationBell from './NotificationBell'
import { DeduraWordmark, DEDURA_BYLINE } from './Brand'
import { MENU_ITEMS, MENU_SECTIONS, SEARCH_ENTRIES, searchMenu, type MenuItem, type SearchEntry } from '@/lib/menu'
import { can, permRoleOf, PERM_ROLE_LABEL } from '@/lib/permissions'

// メニューの中身と並び・メニュー検索の近道は lib/menu.ts、誰に見せるかは lib/permissions.ts（2026-09-26）。
//   旧: ここに役割を直書き＋MENU_ID_MAP＋設定画面の権限（Firestore rolePermissions）の3か所で食い違っていた

/** メニュー項目が今の画面か（/monthly と /monthly?tab=export のように同じ画面の別タブも区別する） */
function isItemActive(item: MenuItem, pathname: string, search: string): boolean {
  if (!item.href) return false
  const [path, query] = item.href.split('?')
  if (query) return pathname === path && search.includes(query)
  if (pathname === path) {
    // 同じ画面に ?tab= 付きの別項目があるときは、そちらのタブを開いている間は選択しない
    return !MENU_ITEMS.some(o => o !== item && o.href?.startsWith(`${path}?`) && search.includes(o.href.split('?')[1]))
  }
  return (item.activePrefixes || []).some(p => pathname === p || pathname.startsWith(`${p}/`))
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
  // 2026-06-XX 追加 (UI #2): メニュー項目の未対応件数バッジ
  const [badges, setBadges] = useState<{ monthly: number; calendar: number; leave: number } | null>(null)
  // メニュー検索（2026-09-26）
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch(window.location.search) }, [pathname])

  useEffect(() => {
    initTheme()
    setFontSizeState(getFontSize())
    // 旧: 設定画面の権限（rolePermissions）を読んでいた。権限は lib/permissions.ts に一本化したので不要
    try { localStorage.removeItem('hibi_role_permissions') } catch { /* ignore */ }
    const auth = localStorage.getItem('hibi_auth')
    if (auth) {
      const { password } = JSON.parse(auth)
      // 2026-06-XX 追加 (UI #2): バッジ件数を非同期取得
      //   重い処理を含むので失敗しても他は表示されるよう catch で握り潰す
      fetch('/api/sidebar-badges', { headers: { 'x-admin-password': password } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.badges) setBadges(data.badges)
        })
        .catch(() => {})
    }
  }, [])

  const filteredItems = MENU_ITEMS.filter(item => can(user, item.cap))
  // 検索の対象 = 見えるメニュー項目 ＋ 画面の中の近道（権限のあるものだけ）
  const searchable: SearchEntry[] = [
    ...filteredItems.filter(i => i.href).map(i => ({ label: i.label, where: i.section, href: i.href!, cap: i.cap })),
    ...SEARCH_ENTRIES.filter(e => can(user, e.cap)),
  ]
  const results = query.trim() ? searchMenu(query, searchable).slice(0, 12) : []
  const openEntry = (href: string) => {
    setQuery('')
    setSearch(href.includes('?') ? `?${href.split('?')[1]}` : '')
    router.push(href)
    onClose()
  }

  const sections = MENU_SECTIONS.filter(sec => filteredItems.some(i => i.section === sec))

  const handleClick = (item: MenuItem) => {
    if (item.href) {
      // 同じ画面の別タブ（/monthly ↔ /monthly?tab=export）は pathname が変わらないので、選択表示をここで合わせる
      setSearch(item.href.includes('?') ? `?${item.href.split('?')[1]}` : '')
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
        className={`fixed top-0 left-0 h-full w-52 bg-hibi-navy dark:bg-gray-950 text-white z-50 transform transition-transform duration-200 lg:translate-x-0 flex flex-col print:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header - システム名（DEDURA＋）+ グループ名。
            会社ロゴは外してある: 見るのは社内4ロールだけで常時掲げる情報価値が薄く、
            白カードがメニューより目立って視線の優先順位が逆になっていたため。
            会社名 HIBI CONSTRUCTION はログイン画面・公開カレンダー・帳票に残っている。 */}
        <div className="px-4 pt-4 pb-3 border-b border-white/10">
          <DeduraWordmark size="xl" variant="white" />
          {/* mt-1 / 50% / 9px はロックアップとして成立させるための値。
              広げると DEDURA＋ と別物に見え、暗くすると 9px では読めなくなる。 */}
          <div className="text-[9px] text-white/50 mt-1 whitespace-nowrap">{DEDURA_BYLINE}</div>
        </div>

        {/* User info */}
        <div className="px-4 py-3 border-b border-white/10 bg-white/5 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-white/50 mt-0.5">
              {(() => { const r = permRoleOf(user); return r ? PERM_ROLE_LABEL[r] : '' })()}
            </div>
          </div>
          <NotificationBell role={user.role} workerId={user.workerId} />
        </div>

        {/* メニュー検索: 画面の中のタブ・機能まで直接飛べる（lib/menu.ts SEARCH_ENTRIES） */}
        <div className="px-3 pt-3">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && results[0]) openEntry(results[0].href)
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="🔍 メニューを検索（例: 有給台帳）"
            className="w-full rounded-lg bg-white/10 placeholder-white/40 text-white text-[12px] px-2.5 py-1.5 outline-none focus:bg-white/15 focus:ring-1 focus:ring-white/30"
          />
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-2 px-1.5">
          {query.trim() && (
            <div className="mb-2">
              {results.length === 0 && <div className="px-2 py-2 text-[12px] text-white/50">見つかりません</div>}
              {results.map(r => (
                <button key={`${r.href}|${r.label}`} onClick={() => openEntry(r.href)}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/10 transition">
                  <div className="text-[13px] text-white">{r.label}</div>
                  <div className="text-[10px] text-white/45">{r.where}</div>
                </button>
              ))}
            </div>
          )}
          {!query.trim() && sections.map(section => (
            <div key={section}>
              <div className="px-1.5 py-1.5 text-[10px] text-white/40 uppercase tracking-wider">
                {section}
              </div>
              {filteredItems
                .filter(item => item.section === section)
                .map(item => {
                  const isActive = isItemActive(item, pathname, search)
                  const isExternal = !!item.external
                  // 2026-06-XX 追加 (UI #2): URL別バッジ件数
                  //   /monthly → 検算違反スタッフ数
                  //   /calendar → 未承認サイト数
                  //   /leave → 年5日アラート数
                  let badgeCount = 0
                  if (badges) {
                    if (item.href === '/monthly') badgeCount = badges.monthly
                    else if (item.href === '/calendar') badgeCount = badges.calendar
                    else if (item.href === '/leave') badgeCount = badges.leave
                  }
                  return (
                    <button
                      key={item.label}
                      onClick={() => handleClick(item)}
                      className={`w-full text-left px-2 py-2 rounded-lg flex items-center gap-2.5 text-[13px] transition ${
                        isActive
                          ? 'bg-white/15 text-white font-semibold'
                          : 'text-white/80 hover:bg-white/10'
                      }`}
                    >
                      <span>{item.icon}</span>
                      <span className="flex-1">{item.label}</span>
                      {badgeCount > 0 && (
                        <span
                          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-red-500 text-white text-[11px] font-bold rounded-full"
                          title={`未対応 ${badgeCount}件`}
                        >
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
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

'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { AuthUser } from '@/types'
import { initTheme, getFontSize, toggleFontSize, type FontSize } from '@/lib/theme'
import NotificationBell from './NotificationBell'
import { DeduraWordmark, DEDURA_BYLINE } from './Brand'
import { Icon } from './ui/Icon'
import { MENU_ITEMS, MENU_SECTIONS, MENU_HOME_SECTION, SEARCH_ENTRIES, searchMenu, activeMenuItem, type MenuItem, type SearchEntry } from '@/lib/menu'
import { can, permRoleOf, PERM_ROLE_LABEL } from '@/lib/permissions'

// メニューの中身と並び・メニュー検索の近道は lib/menu.ts、誰に見せるかは lib/permissions.ts（2026-09-26）。
//   旧: ここに役割を直書き＋MENU_ID_MAP＋設定画面の権限（Firestore rolePermissions）の3か所で食い違っていた

/** Text size icon (Aa) */
function TextSizeIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <text x="2" y="18" fontSize="16" fontWeight="bold" fontFamily="sans-serif">A</text>
      <text x="14" y="18" fontSize="11" fontWeight="bold" fontFamily="sans-serif">a</text>
    </svg>
  )
}

export type SidebarBadges = { monthly: number; calendar: number; leave: number }

// /api/sidebar-badges を同じ画面の中で1回にまとめる（2026-10-01 高速化）。
//   サイドバーとダッシュボードが同時に同じ API を呼び、当月の出面（300KB）と給与計算を2回ずつ走らせていた。
//   進行中・取得直後（数秒以内）の結果を共有する。中身は同じ API の同じ応答なので表示は変わらない
const BADGES_SHARE_MS = 5_000
let _badgesShared: { password: string; at: number; promise: Promise<SidebarBadges | null> } | null = null
export function fetchSidebarBadges(password: string): Promise<SidebarBadges | null> {
  const now = Date.now()
  if (_badgesShared && _badgesShared.password === password && now - _badgesShared.at < BADGES_SHARE_MS) {
    return _badgesShared.promise
  }
  const promise = fetch('/api/sidebar-badges', { headers: { 'x-admin-password': password } })
    .then(r => r.ok ? r.json() : null)
    .then(data => (data?.badges as SidebarBadges | undefined) ?? null)
    .catch(() => null)
  _badgesShared = { password, at: now, promise }
  return promise
}

export default function Sidebar({ user, open, onClose }: { user: AuthUser; open: boolean; onClose: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const [fontSize, setFontSizeState] = useState<FontSize>('normal')
  // 2026-06-XX 追加 (UI #2): メニュー項目の未対応件数バッジ
  const [badges, setBadges] = useState<SidebarBadges | null>(null)
  // メニュー検索（2026-09-26）
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch(window.location.search) }, [pathname])
  // 画面の中でタブを切り替えて URL の ?tab= だけ変わったとき（history.replaceState）も選択表示を合わせる。
  //   画面側は window.dispatchEvent(new Event('hibi:urlchange')) を投げる（例: 月次集計 ↔ 帳票出力）
  useEffect(() => {
    const sync = () => setSearch(window.location.search)
    window.addEventListener('hibi:urlchange', sync)
    window.addEventListener('popstate', sync)
    return () => { window.removeEventListener('hibi:urlchange', sync); window.removeEventListener('popstate', sync) }
  }, [])

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
      //   ダッシュボードも同じ件数を使うので fetchSidebarBadges で1回にまとめる
      fetchSidebarBadges(password).then(b => { if (b) setBadges(b) })
    }
  }, [])

  const filteredItems = MENU_ITEMS.filter(item => can(user, item.cap))
  // 選択中は1項目だけ（lib/menu.ts activeMenuItem）
  const activeItem = activeMenuItem(filteredItems, pathname, search)
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

      {/* 2026-09-30 第2次デザイン刷新「案1 UDホワイト」: 白いサイドバー＋線のアイコン。
          旧（2026-07 案A）は紺ベタで、メニューの字が白抜き・10〜13px と小さく読みにくかった。
          紺は「主役ボタン」「選択中の字」「グリッドの職別行・合計行」に絞ってブランドの錨にする */}
      <aside
        className={`fixed top-0 left-0 h-full w-56 bg-white dark:bg-gray-950 border-r border-hibi-line dark:border-gray-800 text-gray-800 dark:text-gray-100 z-50 transform transition-transform duration-200 lg:translate-x-0 flex flex-col print:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header - システム名（DEDURA＋）+ グループ名。
            会社ロゴは外してある: 見るのは社内4ロールだけで常時掲げる情報価値が薄く、
            白カードがメニューより目立って視線の優先順位が逆になっていたため。
            会社名 HIBI CONSTRUCTION はログイン画面・公開カレンダー・帳票に残っている。 */}
        <div className="px-5 pt-5 pb-3">
          <span className="dark:hidden"><DeduraWordmark size="xl" variant="navy" /></span>
          <span className="hidden dark:inline"><DeduraWordmark size="xl" variant="white" /></span>
          {/* mt-1 / 9px はロックアップとして成立させるための値。広げると DEDURA＋ と別物に見える */}
          <div className="text-[9px] text-gray-500 dark:text-white/50 mt-1 whitespace-nowrap">{DEDURA_BYLINE}</div>
        </div>

        {/* User info */}
        <div className="mx-3 mb-2 px-3 py-2.5 rounded-xl bg-hibi-bg dark:bg-white/5 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-hibi-navy text-white text-sm font-bold flex items-center justify-center shrink-0">
            {user.name.slice(0, 1)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold truncate">{user.name}</div>
            <div className="text-[11px] text-hibi-sub dark:text-white/50">
              {(() => { const r = permRoleOf(user); return r ? PERM_ROLE_LABEL[r] : '' })()}
            </div>
          </div>
          <NotificationBell role={user.role} workerId={user.workerId} />
        </div>

        {/* メニュー検索: 画面の中のタブ・機能まで直接飛べる（lib/menu.ts SEARCH_ENTRIES） */}
        <div className="px-3 pb-1">
          <label className="flex items-center gap-2 h-9 px-3 rounded-[10px] border border-hibi-line dark:border-gray-700 bg-[#F7F8FA] dark:bg-white/5 text-gray-500 dark:text-white/50 focus-within:border-hibi-navy focus-within:bg-white dark:focus-within:border-gray-500">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && results[0]) openEntry(results[0].href)
                if (e.key === 'Escape') setQuery('')
              }}
              placeholder="メニューを探す"
              aria-label="メニューを探す"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-white/40 outline-none"
            />
          </label>
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-1 px-3">
          {query.trim() && (
            <div className="mb-2">
              {results.length === 0 && <div className="px-2 py-2 text-[13px] text-hibi-sub dark:text-white/50">見つかりません</div>}
              {results.map(r => (
                <button key={`${r.href}|${r.label}`} onClick={() => openEntry(r.href)}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-hibi-bg dark:hover:bg-white/10 transition">
                  <div className="text-[13px] text-gray-900 dark:text-white">{r.label}</div>
                  <div className="text-[11px] text-hibi-sub dark:text-white/45">{r.where}</div>
                </button>
              ))}
            </div>
          )}
          {!query.trim() && sections.map(section => (
            <div key={section}>
              {section !== MENU_HOME_SECTION && (
                <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-gray-500 dark:text-white/40 tracking-wider">
                  {section}
                </div>
              )}
              {filteredItems
                .filter(item => item.section === section)
                .map(item => {
                  const isActive = item === activeItem
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
                      aria-current={isActive ? 'page' : undefined}
                      className={`w-full text-left px-2.5 h-9 rounded-lg flex items-center gap-2.5 text-[14px] transition ${
                        isActive
                          ? 'bg-hibi-active text-hibi-navy font-bold dark:bg-white/15 dark:text-white'
                          : 'text-gray-700 hover:bg-hibi-bg dark:text-white/80 dark:hover:bg-white/10'
                      }`}
                    >
                      <Icon name={item.icon} size={17} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {badgeCount > 0 && (
                        <span
                          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-red-600 text-white text-[11px] font-bold rounded-full"
                          title={`未対応 ${badgeCount}件`}
                        >
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                      {isExternal && (
                        <Icon name="external" size={13} className="text-gray-400 dark:text-white/30" />
                      )}
                    </button>
                  )
                })}
            </div>
          ))}
        </nav>

        {/* Font size + Logout */}
        <div className="px-3 py-3 border-t border-hibi-line dark:border-gray-800 space-y-1">
          {/* Font size toggle */}
          <button
            onClick={handleToggleFontSize}
            role="switch"
            aria-checked={fontSize === 'large'}
            className="w-full flex items-center justify-between px-2.5 h-9 rounded-lg hover:bg-hibi-bg dark:hover:bg-white/10 transition"
          >
            <div className="flex items-center gap-2.5 text-[13px] text-gray-700 dark:text-white/70">
              <TextSizeIcon />
              <span>大きい文字</span>
            </div>
            {/* Toggle switch */}
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${
                fontSize === 'large' ? 'bg-hibi-navy dark:bg-blue-500' : 'bg-gray-300 dark:bg-white/20'
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
            className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[13px] text-gray-600 hover:bg-hibi-bg hover:text-gray-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white transition"
          >
            <Icon name="logout" size={16} />
            ログアウト
          </button>
          <div className="text-[10px] text-gray-400 dark:text-white/30 text-center pt-1">v2.1</div>
        </div>
      </aside>
    </>
  )
}

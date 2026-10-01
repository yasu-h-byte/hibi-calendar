/**
 * 線のアイコン（2026-09-30 第2次デザイン刷新「案1 UDホワイト」）。
 *
 * メニューの絵文字をやめて線のアイコンにそろえた。絵文字は OS ごとに絵柄・色・大きさが違い、
 * 白いサイドバーでは色がうるさく、文字より目立って並びが読みにくくなるため。
 * 色は文字色（currentColor）に従うので、選択中・ダークモードでも自動で合う。
 *
 * 新しい形が要るときはここに1つ足す（24×24・線幅は呼び出し側で変えない）。
 */
const PATHS = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9z" /><path d="M9 11h6" /><path d="M9 15h4" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4" /><path d="M16 3v4" /></>,
  umbrella: <><path d="M12 21V11" /><path d="M5 11a7 7 0 0 1 14 0z" /></>,
  chart: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M2 20h20" /></>,
  doc: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
  yen: <><path d="M6 4l6 8 6-8" /><path d="M12 12v8" /><path d="M7 13h10" /><path d="M7 17h10" /></>,
  trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14c3 0 5 2 5 5" /></>,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  wrench: <path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 0-2-2z" />,
  star: <path d="M12 3l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L3 10l6-1z" />,
  pen: <path d="M4 20l4-1 11-11-3-3L5 16z" />,
  site: <><path d="M3 21h18" /><path d="M5 21V9l7-5 7 5v12" /><path d="M10 21v-6h4v6" /></>,
  building: <><rect x="5" y="3" width="14" height="18" /><path d="M9 7h2" /><path d="M13 7h2" /><path d="M9 11h2" /><path d="M13 11h2" /><path d="M9 15h2" /><path d="M13 15h2" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="M5 5l2 2" /><path d="M17 17l2 2" /><path d="M5 19l2-2" /><path d="M17 7l2-2" /></>,
  book: <><path d="M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z" /><path d="M20 4h-7" /><path d="M20 4v14h-7" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  bell: <><path d="M6 17v-6a6 6 0 0 1 12 0v6l2 2H4z" /><path d="M10 21h4" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  alert: <><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18v1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
  pin: <><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  logout: <><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></>,
  plane: <><path d="M2 16l20-6-20-6 4 6z" /><path d="M6 10h8" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  download: <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, strokeWidth = 1.8, className = '' }: {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`.trim()}
    >
      {PATHS[name]}
    </svg>
  )
}

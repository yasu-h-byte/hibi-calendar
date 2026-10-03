'use client'

import Link from 'next/link'

/**
 * 請求の3画面を行き来する下線タブ（2026-10-03 UI/UX 磨き込み・代表 OK）。
 * 旧: 「請求書・支払」「応援の請求書」「紙で出した請求書」と名前がばらばらで、どれが一覧でどれで作るか分かりにくかった。
 * メニューの項目は「請求・支払」の1つ。開いた画面の上にこのタブを出し、役割が名前で分かるようにする。
 */
export type InvoiceScreen = 'list' | 'create' | 'paper'

const TABS: { key: InvoiceScreen; label: string; href: string }[] = [
  { key: 'list', label: '請求・支払の一覧', href: '/peer-statement' },
  { key: 'create', label: '請求書を作る', href: '/peer-invoice' },
  { key: 'paper', label: '紙の請求書の控え', href: '/paper-invoice' },
]

export function INVOICE_SCREEN_TITLE(key: InvoiceScreen): string {
  return TABS.find(t => t.key === key)?.label ?? ''
}

export default function InvoiceNav({ current }: { current: InvoiceScreen }) {
  return (
    <nav aria-label="請求の画面" className="flex gap-5 border-b border-hibi-line dark:border-gray-700 overflow-x-auto">
      {TABS.map(t => {
        const on = t.key === current
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={`shrink-0 py-2.5 text-sm font-bold border-b-2 -mb-px transition ${on ? 'text-hibi-navy dark:text-white border-hibi-navy dark:border-white' : 'text-hibi-sub dark:text-gray-400 border-transparent hover:text-gray-900 dark:hover:text-gray-200'}`}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

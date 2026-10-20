'use client'

import Link from 'next/link'

/**
 * 請求の画面（出した請求書3つ＋受け取った請求書）を行き来する下線タブ（2026-10-03 UI/UX 磨き込み・代表 OK）。
 * 旧: 「請求書・支払」「応援の請求書」「紙で出した請求書」と名前がばらばらで、どれが一覧でどれで作るか分かりにくかった。
 * メニューの項目は「請求・支払」の1つ。開いた画面の上にこのタブを出し、役割が名前で分かるようにする。
 */
export type InvoiceScreen = 'list' | 'create' | 'paper' | 'received' | 'prime'

// 2026-10-20 代表: 請求と原価の画面を「請求・原価」（/billing・3タブ）に統合。請求書の画面の上には、一覧（出す請求書）へ戻るタブと
//   請求書の種類のタブを出す。「受け取る」は /billing のタブ③
const TABS: { key: InvoiceScreen; label: string; href: string }[] = [
  { key: 'list', label: '← 出す請求書（一覧）', href: '/billing?tab=issue' },
  { key: 'prime', label: '山岡への請求書', href: '/prime-invoice' },
  { key: 'paper', label: '紙で出した控え', href: '/paper-invoice' },
  { key: 'received', label: '受け取る（支払・入金）', href: '/billing?tab=receive' },
]

export function INVOICE_SCREEN_TITLE(key: InvoiceScreen): string {
  if (key === 'create') return '請求書を作る'
  return TABS.find(t => t.key === key)?.label ?? ''
}

export default function InvoiceNav({ current }: { current: InvoiceScreen }) {
  return (
    <nav aria-label="請求の画面" className="flex gap-5 border-b border-hibi-line dark:border-gray-700 overflow-x-auto">
      {TABS.map(t => {
        const on = t.key === current || (current === 'create' && t.key === 'list')
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

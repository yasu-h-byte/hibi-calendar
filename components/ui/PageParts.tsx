'use client'

import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

// 画面の型（2026-10-01 代表決定「全ページを休暇管理・月次集計と同じデザイン言語で順次改修」）の共通部品。
//   休暇管理（leave）と月次集計（monthly）で同じ見た目を別々に書いていたものをここへ集めた（UI改修 波0）。
//   新しい画面はこの部品を組み合わせて作る。見た目を直すときもここ1か所を直せば全画面にそろう。
//   ⚠️ Tailwind のクラスは必ず完全な文字列で書く（`bg-${c}-50` のような組み立ては CSS が生成されず無色になる）。

// ─── 見出し ─────────────────────────────────────

/** ページの見出し。group = メニューのまとまり名（小さく上に）、右側に操作ボタン */
export function PageHeader({ group, title, sub, actions }: {
  group?: string
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div>
        {group && <div className="text-[13px] text-hibi-sub dark:text-gray-400">{group}</div>}
        <h1 className={`text-2xl font-bold text-gray-900 dark:text-white ${group ? 'mt-1' : ''}`}>{title}</h1>
        {sub && <p className="text-[13px] text-hibi-sub dark:text-gray-400 mt-1">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

/** 見出し横の操作ボタン（白地・線）。ページの主操作ではない「出力」「前月コピー」など */
export function ToolButton({ icon, children, onClick, disabled, title }: {
  icon?: IconName
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-[10px] text-sm font-bold border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
      {icon && <Icon name={icon} size={15} />}{children}
    </button>
  )
}

// ─── タブ・切り替え ──────────────────────────────

export interface UnderlineTab<K extends string> {
  key: K
  label: string
  /** 件数の赤丸（0・未指定なら出さない） */
  badge?: number
}

/** 下線タブ（ページ内の大きな切り替え。絵文字は使わない） */
export function UnderlineTabs<K extends string>({ tabs, active, onChange, label }: {
  tabs: UnderlineTab<K>[]
  active: K
  onChange: (k: K) => void
  /** 読み上げ用の名前（例: 「休暇管理のタブ」） */
  label: string
}) {
  return (
    <nav className="flex gap-1 border-b border-hibi-line dark:border-gray-700 overflow-x-auto" aria-label={label}>
      {tabs.map(tab => (
        <button key={tab.key} onClick={() => onChange(tab.key)}
          aria-current={active === tab.key ? 'page' : undefined}
          className={`px-4 py-2.5 text-[15px] whitespace-nowrap flex items-center gap-1.5 border-b-[3px] -mb-px transition ${
            active === tab.key
              ? 'border-hibi-navy text-hibi-navy font-bold dark:border-blue-400 dark:text-white'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}>
          {tab.label}
          {tab.badge ? <span className="bg-red-600 text-white text-[11px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">{tab.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}

/** 小さな切り替え（絞り込み・並べ替え・表示の切り替え）。items = [値, 表示名] */
export function Segment<K extends string>({ value, onChange, items }: {
  value: K
  onChange: (v: K) => void
  items: readonly (readonly [K, string])[]
}) {
  return (
    <div className="flex gap-1 p-1 rounded-[10px] bg-gray-200/70 dark:bg-gray-800 w-fit">
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k}
          className={`h-8 px-3.5 rounded-lg text-[13px] whitespace-nowrap transition ${
            value === k
              ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white font-bold shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** 名前検索の欄（絞り込み行の右端に置く） */
export function SearchBox({ value, onChange, placeholder = '名前で探す' }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="ml-auto flex items-center gap-2 h-9 px-3 rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-500 w-full sm:w-52">
      <Icon name="search" size={15} />
      <input
        type="search" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} aria-label={placeholder}
        className="flex-1 min-w-0 bg-transparent text-sm text-gray-900 dark:text-white outline-none"
      />
    </label>
  )
}

// ─── 今やることカード ─────────────────────────────

const TODO_TONE = {
  urgent: { chip: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', title: 'text-red-700 dark:text-red-300' },
  warn: { chip: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', title: 'text-amber-800 dark:text-amber-300' },
  info: { chip: 'bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300', title: 'text-hibi-navy dark:text-blue-300' },
  ok: { chip: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300', title: 'text-gray-600 dark:text-gray-300' },
} as const
export type TodoTone = keyof typeof TODO_TONE

/**
 * 「今やること／判断材料」カード。ページ上部に 2〜4 枚並べる。
 * onClick があれば押せる（絞り込み・その作業へ）。active = 絞り込み中。tone='ok' は ✓ で灰色の数字。
 */
export function TodoCard({ icon, tone, title, big, sub, action, onClick, active }: {
  icon: IconName
  tone: TodoTone
  title: string
  big: string
  sub: string
  action?: string
  onClick?: () => void
  active?: boolean
}) {
  const t = TODO_TONE[tone]
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center ${t.chip}`}>
          <Icon name={tone === 'ok' ? 'check' : icon} size={17} />
        </span>
        <span className={`text-[13px] font-bold ${t.title}`}>{title}</span>
      </div>
      <div className={`text-xl font-bold ${tone === 'ok' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-white'}`}>{big}</div>
      <div className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed line-clamp-2">{sub}</div>
      {action && (
        <div className="mt-auto pt-1 text-[13px] font-bold text-hibi-navy dark:text-blue-300 flex items-center gap-1">
          {action}<Icon name="chevronRight" size={14} />
        </div>
      )}
    </>
  )
  const cls = `text-left bg-white dark:bg-gray-800 border rounded-xl p-4 flex flex-col gap-2 ${
    active ? 'border-hibi-navy ring-1 ring-hibi-navy dark:border-blue-400 dark:ring-blue-400' : 'border-hibi-line dark:border-gray-700'
  }`
  return onClick
    ? <button onClick={onClick} className={`${cls} hover:border-hibi-navy dark:hover:border-blue-400 transition`}>{body}</button>
    : <div className={cls}>{body}</div>
}

/**
 * 低い「今やること」の帯（2026-10-01 出面入力）。入力の表のように画面の主役が下にある画面で、
 * 大きなカードの代わりに使う（表が上のほうから始まるように）。押すとその作業へ。
 */
export function TodoStrip({ icon, tone, title, big, onClick, label }: {
  icon: IconName
  tone: TodoTone
  title: string
  big: string
  onClick?: () => void
  /** 読み上げ用（押すと何が起きるか） */
  label?: string
}) {
  const t = TODO_TONE[tone]
  const body = (
    <>
      <span className={`w-[30px] h-[30px] rounded-lg flex items-center justify-center shrink-0 ${t.chip}`}>
        <Icon name={tone === 'ok' ? 'check' : icon} size={16} />
      </span>
      <span className="flex flex-col min-w-0 flex-1 text-left">
        <span className={`text-xs font-bold ${t.title}`}>{title}</span>
        <span className={`text-[17px] font-bold leading-tight ${tone === 'ok' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-white'}`}>{big}</span>
      </span>
      {onClick && <Icon name="chevronRight" size={16} className="text-hibi-navy dark:text-blue-300 shrink-0" />}
    </>
  )
  const cls = 'bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 rounded-xl px-3.5 py-2.5 flex items-center gap-2.5'
  return onClick
    ? <button type="button" onClick={onClick} aria-label={label} className={`${cls} hover:border-hibi-navy dark:hover:border-blue-400 transition`}>{body}</button>
    : <div className={cls}>{body}</div>
}

// ─── 札 ─────────────────────────────────────────

const CHIP_TONE = {
  gray: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  cyan: 'bg-cyan-50 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
  blue: 'bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300',
  green: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
} as const
export type ChipTone = keyof typeof CHIP_TONE

/** 名前の横に付ける小さな印（要確認・帰国中・旧ルールなど）。red/amber は「要確認」の色 */
export function Chip({ tone, children, title }: { tone: ChipTone; children: ReactNode; title?: string }) {
  return <span title={title} className={`px-1.5 py-0.5 rounded text-[11px] font-bold whitespace-nowrap ${CHIP_TONE[tone]}`}>{children}</span>
}

/** 金額・日数の内訳の札（「有給手当 12,000」）。0 の項目は呼び出し側で出さない */
export function AmountChip({ label, amount, neg }: { label: ReactNode; amount: ReactNode; neg?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 px-2 py-0.5 rounded-md bg-hibi-bg dark:bg-gray-700/60 text-xs text-hibi-sub dark:text-gray-400 whitespace-nowrap">
      {label}<b className={`tabular-nums ${neg ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{neg ? '−' : ''}{amount}</b>
    </span>
  )
}

// ─── 右から開く詳細パネル ──────────────────────────

/**
 * 一覧の行を押すと右から開く詳細。Esc・背景クリックで閉じる。
 * 画面の中身は animate-fadeIn（transform）の中にあり、fixed がその枠に閉じ込められる
 * （サイドバーが暗くならない）ので body 直下に出して画面全体に重ねる。
 */
export function SidePanel({ label, onClose, children, width = 'max-w-[640px]' }: {
  /** 読み上げ用の名前（例: 「グエン の有給」） */
  label: string
  onClose: () => void
  children: ReactNode
  width?: 'max-w-[640px]' | 'max-w-[760px]' | 'max-w-[520px]'
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] print:hidden" role="dialog" aria-modal="true" aria-label={label}>
      <button className="absolute inset-0 bg-black/30 animate-fadeIn" onClick={onClose} aria-label="閉じる" />
      <aside className={`absolute right-0 top-0 h-full w-full ${width} bg-white dark:bg-gray-800 border-l border-hibi-line dark:border-gray-700 shadow-xl overflow-y-auto animate-slideInRight`}>
        {children}
      </aside>
    </div>,
    document.body,
  )
}

/** パネル見出し右上の × ボタン */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="閉じる"
      className="w-9 h-9 rounded-[10px] border border-hibi-line dark:border-gray-600 flex items-center justify-center text-gray-500 hover:bg-hibi-bg dark:hover:bg-gray-700 text-lg leading-none">×</button>
  )
}

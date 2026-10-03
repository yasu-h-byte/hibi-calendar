'use client'

import { ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { confirmDiscardDialog } from '@/lib/hooks/discardGuard'

/**
 * 共通モーダル（2026-10-03 UI/UX 磨き込み・土台③で作り直し）。
 *
 * 画面ごとに書いていた `fixed inset-0 bg-black/50 … <div className="bg-white rounded-xl p-6">` を1つにそろえる。
 * 見た目は右パネル（SidePanel）と同じ言葉: 白いカード・細枠・角丸 2xl・上に見出しと × ・下にボタン列。
 *
 *   <Modal open={show} onClose={() => setShow(false)} title="有給を付与する" size="md" dirty={formDirty}
 *          footer={<><CancelButton onClick={() => setShow(false)} /><SaveButton action="付与" onSave={…} /></>}>
 *     …フォーム…
 *   </Modal>
 *
 *   - Esc・背景クリック・× はすべて onClose。dirty を渡すと「保存していない変更があります」の窓を先に出す（SidePanel と同じ）
 *   - 日本語入力の変換を取り消す Esc では閉じない
 *   - 開いたら最初の入力欄（無ければ × ）に focus。閉じたら元の場所へ戻す
 *   - 本文が長いときはモーダルの中だけスクロール（見出しとボタン列は固定）
 *   - z-70（右パネル z-60 の中から開く窓も上に出る。確認の窓 z-80・お知らせの帯 z-100 より下）
 *     2026-10-03 本番確認: 現場マスタの右パネルから開く「一覧に無い会社を追加」が z-50 でパネルの裏に隠れていた
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

const SIZE_CLS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-2rem)]',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** 見出しの下の補足（1行） */
  sub?: ReactNode
  children: ReactNode
  /** 下のボタン列（右寄せ）。SaveButton・CancelButton を並べる */
  footer?: ReactNode
  size?: ModalSize
  /** 未保存の変更がある（閉じる前に確かめる） */
  dirty?: boolean
  /** ESCキーで閉じない場合 false */
  closeOnEsc?: boolean
  /** 背景クリックで閉じない場合 false */
  closeOnOverlay?: boolean
  /** 本文の余白を無くす（表をいっぱいに出すとき） */
  flush?: boolean
  /** 読み上げ用の名前（title が文字列でないとき） */
  label?: string
  /** スタッフ画面（日越）: 未保存ガードの窓も日越並記にする */
  bilingual?: boolean
  /** 開いたときの focus。first=最初の入力欄（PC の既定）・none=枠そのもの（本文が長く、最初の欄が下の方にあるとき）。タッチ端末では常に none（キーボードが勝手に出ないように） */
  autoFocus?: 'first' | 'none'
  className?: string
}

export function Modal({
  open,
  onClose,
  title,
  sub,
  children,
  footer,
  size = 'md',
  dirty,
  closeOnEsc = true,
  closeOnOverlay = true,
  flush = false,
  label,
  bilingual = false,
  autoFocus = 'first',
  className = '',
}: ModalProps) {
  const [mounted, setMounted] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  // Esc のハンドラは登録し直さず、最新の dirty / onClose を ref から読む
  const latest = useRef({ dirty, onClose, closeOnEsc, bilingual })
  latest.current = { dirty, onClose, closeOnEsc, bilingual }

  useEffect(() => { setMounted(true) }, [])

  // 開いたら最初の入力欄に focus・閉じたら元へ
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => {
      const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
      const first = autoFocus === 'first' && !coarse
        ? boxRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
        : null
      if (first) first.focus()
      else boxRef.current?.focus({ preventScroll: true })
    }, 0)
    return () => { clearTimeout(t); prev?.focus?.() }
  }, [open, autoFocus])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || !latest.current.closeOnEsc) return
      // 確認の窓（z-80）が開いているときはそちらが先に受け取って止める
      e.stopPropagation()
      void confirmDiscardDialog(latest.current.dirty, { bilingual: latest.current.bilingual }).then(ok => { if (ok) latest.current.onClose() })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !mounted) return null

  const requestClose = () => { void confirmDiscardDialog(dirty, { bilingual }).then(ok => { if (ok) onClose() }) }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 print:hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby={typeof title === 'string' ? titleId : undefined}
      aria-label={typeof title === 'string' ? undefined : label}
    >
      <button type="button" className="absolute inset-0 bg-black/40 animate-fadeIn" onClick={closeOnOverlay ? requestClose : undefined} aria-label="閉じる" tabIndex={-1} />
      <div
        ref={boxRef}
        tabIndex={-1}
        className={`relative w-full outline-none ${SIZE_CLS[size]} max-h-[calc(100vh-2rem)] flex flex-col bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 shadow-xl animate-modalIn ${className}`}
      >
        {(title || sub) && (
          <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-hibi-line dark:border-gray-700 shrink-0">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-base font-bold text-gray-900 dark:text-white leading-snug">{title}</h2>}
              {sub && <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 mt-0.5">{sub}</div>}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={requestClose}
              aria-label="閉じる"
              className="shrink-0 w-9 h-9 -mr-2 -mt-1 rounded-[10px] border border-hibi-line dark:border-gray-600 flex items-center justify-center text-gray-500 hover:bg-hibi-bg dark:hover:bg-gray-700 text-lg leading-none"
            >×</button>
          </div>
        )}
        <div className={`min-h-0 overflow-y-auto ${flush ? '' : 'px-5 py-4'}`}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 flex-wrap px-5 py-3 border-t border-hibi-line dark:border-gray-700 shrink-0">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** モーダル下の「やめる」ボタン（脇役）。確認の窓と同じ言葉にそろえる */
export function CancelButton({ onClick, children = 'やめる', disabled, size = 'md', className = '' }: { onClick: () => void; children?: ReactNode; disabled?: boolean; size?: 'md' | 'lg'; className?: string }) {
  const sizeCls = size === 'lg' ? 'min-h-[48px] px-5 text-base' : 'h-10 px-4 text-sm'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${sizeCls} ${className} rounded-[10px] font-bold border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 hover:bg-hibi-bg dark:hover:bg-gray-700 transition disabled:opacity-50`}
    >
      {children}
    </button>
  )
}

/** モーダル下の主役ボタン（保存以外: 「送信する」「申請する」など）。保存は SaveButton を使う */
export function PrimaryButton({ onClick, children, disabled, tone = 'main', size = 'md', className = '' }: { onClick: () => void; children: ReactNode; disabled?: boolean; tone?: 'main' | 'danger'; size?: 'md' | 'lg'; className?: string }) {
  const sizeCls = size === 'lg' ? 'min-h-[48px] px-5 text-base' : 'h-10 px-4 text-sm'
  const cls = tone === 'danger' ? 'bg-red-600 hover:bg-red-700 border-red-600' : 'bg-hibi-navy hover:bg-hibi-light border-hibi-navy'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${sizeCls} ${className} rounded-[10px] font-bold text-white border transition disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  )
}

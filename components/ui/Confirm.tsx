'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { registerConfirmHost, type ConfirmOptions, type ConfirmResult } from '@/lib/confirm-dialog'

/**
 * 確認の窓（UI/UX 磨き込み 土台②・2026-10-03 代表 OK）。
 *
 * レイアウトに <ConfirmHost /> を1つ置くと、画面側は lib/confirm-dialog.ts の confirmDialog() /
 * confirmWithReason() / confirmDanger() を await するだけで、この窓が出る。
 * 見本: https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh の1段目。
 *
 *   - 主役ボタンは紺（提出・承認・保存）。赤は取り消し・削除だけ（tone: 'danger'）
 *   - 「やめる」が左、主役が右。Esc と背景クリックは「やめる」
 *   - 理由つき（reason）は書くまで主役ボタンを押せない
 *   - スタッフ向け（vi）は日越並記で、ボタンは指で押せる高さ
 *   - 右パネル（z-[60]）やモーダル（z-50）の上に出るよう z-[80]。お知らせの帯（z-[100]）はさらに上
 */
type Pending = { id: number; opts: ConfirmOptions; resolve: (r: ConfirmResult) => void }

let seq = 0

export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([])
  useEffect(() => {
    registerConfirmHost(opts => new Promise<ConfirmResult>(resolve => {
      setQueue(q => [...q, { id: ++seq, opts, resolve }])
    }))
    return () => registerConfirmHost(null)
  }, [])
  const current = queue[0]
  const finish = useCallback((r: ConfirmResult) => {
    setQueue(q => {
      q[0]?.resolve(r)
      return q.slice(1)
    })
  }, [])
  if (!current) return null
  return <ConfirmDialog key={current.id} opts={current.opts} onDone={finish} />
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (r: ConfirmResult) => void }) {
  const [reason, setReason] = useState('')
  const firstRef = useRef<HTMLButtonElement | HTMLTextAreaElement>(null)
  const danger = opts.tone === 'danger'
  const bilingual = !!opts.vi
  const reasonRequired = !!opts.reason && opts.reason.required !== false
  const canConfirm = !reasonRequired || reason.trim().length > 0

  // 開いたら最初の操作に focus（理由欄があれば理由欄、危険なら「やめる」、それ以外は主役）。閉じたら元の場所へ戻す
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    firstRef.current?.focus()
    return () => { prev?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); onDone({ ok: false }) }
    }
    // SidePanel の Esc（閉じる）より先に受け取る
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])

  const cancel = () => onDone({ ok: false })
  const confirm = () => { if (canConfirm) onDone({ ok: true, reason: opts.reason ? reason.trim() : undefined }) }

  const mainCls = danger
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-hibi-navy hover:bg-hibi-light text-white'
  const ghostCls = 'bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-hibi-bg dark:hover:bg-gray-700'
  const btnBase = bilingual
    ? 'flex-1 min-h-[52px] px-3 rounded-[10px] text-base font-bold leading-tight flex flex-col items-center justify-center'
    : 'h-10 px-4 rounded-[10px] text-sm font-bold inline-flex items-center justify-center'

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 print:hidden" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <button type="button" className="absolute inset-0 bg-black/40 animate-fadeIn" onClick={cancel} aria-label={opts.cancelLabel || 'やめる'} tabIndex={-1} />
      <div className="relative w-full max-w-[420px] bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 shadow-xl p-5 flex flex-col gap-3 animate-modalIn">
        <div id="confirm-title" className="text-base font-bold text-gray-900 dark:text-white leading-snug">{opts.title}</div>
        {opts.vi?.title && <div className="text-sm text-hibi-sub dark:text-gray-400 -mt-1">{opts.vi.title}</div>}
        {opts.description && (
          <div className="text-sm text-hibi-sub dark:text-gray-300 whitespace-pre-line leading-relaxed">{opts.description}</div>
        )}
        {opts.vi?.description && <div className="text-sm text-hibi-sub dark:text-gray-400 whitespace-pre-line">{opts.vi.description}</div>}
        {opts.reason && (
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{opts.reason.label}{reasonRequired ? '' : '（任意）'}</span>
            <textarea
              ref={firstRef as React.RefObject<HTMLTextAreaElement>}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={opts.reason.placeholder}
              rows={3}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none resize-y"
            />
          </label>
        )}
        <div className={`flex gap-2 mt-1 ${bilingual ? '' : 'justify-end'}`}>
          <button
            type="button"
            ref={!opts.reason && danger ? (firstRef as React.RefObject<HTMLButtonElement>) : undefined}
            onClick={cancel}
            className={`${btnBase} ${ghostCls}`}
          >
            <span>{opts.cancelLabel || 'やめる'}</span>
            {bilingual && <span className="text-xs font-normal">{opts.vi?.cancelLabel || 'Không'}</span>}
          </button>
          <button
            type="button"
            ref={!opts.reason && !danger ? (firstRef as React.RefObject<HTMLButtonElement>) : undefined}
            onClick={confirm}
            disabled={!canConfirm}
            className={`${btnBase} ${mainCls} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <span>{opts.confirmLabel || 'はい'}</span>
            {bilingual && <span className="text-xs font-normal">{opts.vi?.confirmLabel || 'Có'}</span>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { notify } from '@/lib/notify'

/**
 * 保存ボタン（UI/UX 磨き込み 土台②・2026-10-03 代表 OK）。
 *
 * 押したあと何が起きているか分かる4つの顔（見本 https://claude.ai/artifact/CVvMip58wSYuRKnDukadrh の3段目）:
 *   ふだん「保存する」→ 押した直後「保存しています」（二度押しできない）→ 「✓ 保存しました」（2秒）→ ふだんに戻る
 *   失敗したら「もう一度保存する」（理由は赤の帯に出る）
 *
 * onSave の約束:
 *   - うまくいったら何も返さない（または true / { ok: true }）
 *   - だめなら throw するか { ok: false, error } を返す → このボタンが notify.failed(action, error) で赤の帯を出す
 *   - 自分で帯を出したあとは false を返す（帯を二重に出さない。ボタンは「もう一度〇〇する」）
 *   - 確認の窓で「やめる」が押された・入力の不備で止めた（失敗ではない）ときは null を返す → ふだんの顔に戻る
 *
 *   <SaveButton action="保存" onSave={async () => { const r = await postJson(...); if (!r.ok) return { ok: false, error: r.error } }} />
 */
type SaveOutcome = void | boolean | null | { ok: boolean; error?: string | null }| boolean | { ok: boolean; error?: string | null }
type Phase = 'idle' | 'saving' | 'saved' | 'failed'

export function SaveButton({
  onSave,
  action = '保存',
  label,
  savingLabel,
  savedLabel,
  retryLabel,
  hint,
  disabled,
  full,
  size = 'md',
  className = '',
  onSaved,
}: {
  onSave: () => Promise<SaveOutcome>
  /** 失敗の帯の見出しに使う名詞（「保存」→「保存できませんでした」） */
  action?: string
  /** 既定は「{action}する」 */
  label?: string
  savingLabel?: string
  savedLabel?: string
  retryLabel?: string
  /** 失敗の帯に添える次の手（例: 「締めの解除は政仁さんに頼んでください」） */
  hint?: string
  disabled?: boolean
  /** 幅いっぱい（モーダルの下のボタン列など） */
  full?: boolean
  size?: 'md' | 'lg'
  className?: string
  /** うまくいったあとに呼ぶ（閉じる・一覧を読み直す等） */
  onSaved?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (phase !== 'saved') return
    const t = setTimeout(() => { if (alive.current) setPhase('idle') }, 2000)
    return () => clearTimeout(t)
  }, [phase])

  const run = async () => {
    if (phase === 'saving') return
    setPhase('saving')
    let ok = true
    let cancelled = false
    try {
      const r = await onSave()
      if (r === null) cancelled = true
      else if (r === false) ok = false
      else if (r && typeof r === 'object' && !r.ok) { ok = false; notify.failed(action, r.error ?? undefined, hint) }
    } catch (e) {
      ok = false
      notify.failed(action, e, hint)
    }
    if (!alive.current) return
    if (cancelled) { setPhase('idle'); return }
    setPhase(ok ? 'saved' : 'failed')
    if (ok) onSaved?.()
  }

  const text = phase === 'saving' ? (savingLabel ?? `${action}しています`)
    : phase === 'saved' ? (savedLabel ?? `${action}しました`)
    : phase === 'failed' ? (retryLabel ?? `もう一度${action}する`)
    : (label ?? `${action}する`)

  const sizeCls = size === 'lg' ? 'min-h-[48px] px-5 text-base' : 'h-10 px-4 text-sm'
  const toneCls = phase === 'saved'
    ? 'bg-white dark:bg-gray-800 border border-green-600 text-green-700 dark:text-green-300'
    : phase === 'failed'
      ? 'bg-white dark:bg-gray-800 border border-red-600 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30'
      : 'bg-hibi-navy hover:bg-hibi-light text-white border border-hibi-navy'

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled || phase === 'saving'}
      aria-live="polite"
      className={`${full ? 'w-full flex-1' : ''} ${sizeCls} rounded-[10px] font-bold inline-flex items-center justify-center gap-2 transition disabled:opacity-60 disabled:cursor-not-allowed ${toneCls} ${className}`}
    >
      {phase === 'saving' && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />}
      {phase === 'saved' && <span aria-hidden="true">✓</span>}
      <span>{text}</span>
    </button>
  )
}

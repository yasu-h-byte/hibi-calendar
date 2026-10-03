'use client'

import { useEffect, useRef, useState } from 'react'
import { DeduraMark } from './Brand'
import { getFontSize, initFontSize, setFontSize, type FontSize } from '@/lib/theme'

/**
 * スタッフ・職長スマホ画面の上の帯（2026-09-30 第2次デザイン刷新「案1 UDホワイト」）。
 *
 * 旧（2026-07 案C）はチャコールの濃色ベタに白抜き文字だった。案1 では白地に濃い文字＋紺の頭文字にして、
 * 管理画面と同じ見た目にそろえる。白地×ほぼ黒の文字はコントラストが最も高く、直射日光の下でも読める。
 * 主役ボタン（出勤登録）のアンバーはそのまま残す。
 *
 * スタッフ（/attendance/[token]）・職長（/attendance/foreman/[token]）・マイページ（/mypage/[token]）で共通。
 *
 * 2026-10-03（UI/UX 磨き込み 土台②・代表 OK）: 右上の DEDURA＋ マークを押すと「文字の大きさ 標準／大きい」。
 * PC のサイドバーと同じ設定（lib/theme.ts・端末ごとに覚える）。土台①で文字を rem にしたので、ここが効く。
 */
export default function StaffHeader({ label, name, sub, note }: {
  /** 名前の上の小さな見出し（例: 職長・マイページ）。無ければ出さない */
  label?: string
  name: string
  /** 名前の下の行（ベトナム語名・現場名など） */
  sub?: string | null
  /** さらに下の薄い行（今日の日付など） */
  note?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [fontSize, setFs] = useState<FontSize>('normal')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setFs(initFontSize()) }, [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const choose = (v: FontSize) => { setFontSize(v); setFs(getFontSize()) }

  return (
    <div className="bg-white border-b border-hibi-line px-4 py-3.5" style={{ paddingTop: 'max(0.875rem, env(safe-area-inset-top, 0px))' }}>
      <div className="max-w-lg mx-auto flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-hibi-navy text-white text-base font-bold flex items-center justify-center shrink-0" aria-hidden="true">
          {name.slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          {label && <div className="text-xs text-hibi-sub">{label}</div>}
          <div className="text-lg sm:text-xl font-bold text-gray-900 truncate">{name}</div>
          {sub && <div className="text-sm text-hibi-sub truncate">{sub}</div>}
          {note && <div className="text-xs text-hibi-sub mt-0.5">{note}</div>}
        </div>
        <div ref={wrapRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label="設定 / Cài đặt"
            className="w-11 h-11 -mr-2 rounded-full flex items-center justify-center hover:bg-hibi-bg active:bg-hibi-bg"
          >
            <DeduraMark size={22} />
          </button>
          {open && (
            <div role="dialog" aria-label="文字の大きさ / Cỡ chữ" className="absolute right-0 top-12 z-40 w-[232px] bg-white rounded-2xl border border-hibi-line shadow-xl p-3 animate-modalIn">
              <div className="text-xs text-hibi-sub mb-2">文字の大きさ / Cỡ chữ</div>
              <div className="flex gap-1.5" role="group" aria-label="文字の大きさ">
                <button type="button" onClick={() => choose('normal')} aria-pressed={fontSize === 'normal'}
                  className={`flex-1 min-h-[44px] rounded-[10px] text-sm font-bold flex flex-col items-center justify-center leading-tight ${fontSize === 'normal' ? 'bg-hibi-navy text-white' : 'bg-hibi-bg text-gray-800'}`}>
                  <span>標準</span><span className="text-xs font-normal">Bình thường</span>
                </button>
                <button type="button" onClick={() => choose('large')} aria-pressed={fontSize === 'large'}
                  className={`flex-1 min-h-[44px] rounded-[10px] text-sm font-bold flex flex-col items-center justify-center leading-tight ${fontSize === 'large' ? 'bg-hibi-navy text-white' : 'bg-hibi-bg text-gray-800'}`}>
                  <span>大きい</span><span className="text-xs font-normal">Lớn</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * 「いちばん新しい読み込みだけを画面に出す」ための小さな道具（2026-10-02 総合点検）。
 *
 * 根本原因: 月を素早く切り替えると、前の月の応答があとから届いて画面に出ていた。
 *   請求書の画面では「表示は前の月の下書きなのに、『この内容で発行』は今の月で送る」になり得た。
 * 対処: 読み込みを始めるたびに前の fetch を AbortController で止め、応答が届いたら
 *   「まだ自分が最新か」を確かめてから画面に入れる。
 *
 * 使い方:
 *   const latest = useLatestRequest()
 *   const load = useCallback(async () => {
 *     const req = latest.begin()
 *     const res = await fetchWithAuth(url, { signal: req.signal })
 *     const json = await res.json()
 *     if (!req.isCurrent()) return   // 古い応答は捨てる
 *     setData(json)
 *   }, [...])
 * 止めた fetch は AbortError を投げるので、呼び出し側は catch で `req.isCurrent()` を見て黙って抜ける。
 */
export function useLatestRequest(): {
  begin: () => { signal: AbortSignal; isCurrent: () => boolean }
  /** AbortError（自分で止めたもの）か */
  isAbort: (e: unknown) => boolean
} {
  const seq = useRef(0)
  const ctrl = useRef<AbortController | null>(null)
  const begin = useCallback(() => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    const my = ++seq.current
    return { signal: c.signal, isCurrent: () => seq.current === my && !c.signal.aborted }
  }, [])
  const isAbort = useCallback((e: unknown) => e instanceof DOMException && e.name === 'AbortError', [])
  useEffect(() => () => { ctrl.current?.abort() }, [])
  // 返す物は同じ参照を保つ（2026-10-03）。旧: 毎回新しい { begin, isAbort } を返していたため、これを依存に持つ
  //   useCallback（fetchData）が描画のたびに作り直され、useEffect([fetchData]) が読み込みを繰り返す無限ループになった
  //   （お試しサイトで出面入力・月次集計が「読み込み中」のまま止まらず、API を毎秒叩いていた）
  return useMemo(() => ({ begin, isAbort }), [begin, isAbort])
}

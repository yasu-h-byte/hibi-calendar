'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'

/**
 * スタッフの顔写真を一括取得する（2026-08-03 追加）
 *
 * 1人ずつ取りに行くと人数分のリクエストが飛ぶので、`workerId → データURI` の
 * マップを1回で取る。API 側が private・10分のキャッシュを返すので、
 * 画面を行き来してもブラウザキャッシュで済み、Firestore の読み取りは増えない。
 *
 * 写真は必須データではないため、失敗しても画面は止めない（イニシャル表示に落ちる）。
 */
export function useWorkerPhotos(): {
  photos: Record<string, string>
  reload: () => void
} {
  const [photos, setPhotos] = useState<Record<string, string>>({})
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        // 保存直後は 10 分キャッシュを跨いでしまうので、reload 時はキャッシュを避ける
        const url = nonce > 0 ? `/api/workers/photo?r=${nonce}` : '/api/workers/photo'
        const res = await fetchWithAuth(url)
        if (!res.ok) return
        const data = await res.json()
        if (alive && data?.photos) setPhotos(data.photos)
      } catch {
        /* 写真は無くても業務は回るので握りつぶす */
      }
    }
    load()
    return () => { alive = false }
  }, [nonce])

  return { photos, reload }
}

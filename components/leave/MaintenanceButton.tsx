/**
 * 保守ツール起動ボタン（2026-06-XX 新設）
 *
 * ヘッダーに常駐するボタン。
 * - 健全性チェック API を定期実行
 * - 異常があれば赤バッジで件数表示 → 政仁さんが気付ける
 * - 健全状態ならグレーアウト → 通常運用では目立たない
 * - クリックで MaintenanceModal を開く
 */
'use client'

import { useState, useEffect, useCallback } from 'react'
import MaintenanceModal from './MaintenanceModal'

interface Props {
  password: string
  onChanged: () => void
}

export default function MaintenanceButton({ password, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [totalIssues, setTotalIssues] = useState<number | null>(null)

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/leave/health-check', {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        const c = data.counts || {}
        setTotalIssues((c.needsNormalization || 0) + (c.needsFyAutoFix || 0) + (c.needsExpiryProcess || 0))
      }
    } catch { /* ignore */ }
  }, [password])

  useEffect(() => {
    checkHealth()
    // 30秒ごとに再チェック（モーダル閉じた後の状態反映）
    const t = setInterval(checkHealth, 30000)
    return () => clearInterval(t)
  }, [checkHealth])

  const hasIssues = totalIssues !== null && totalIssues > 0

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`relative px-3 py-2 rounded-lg text-sm font-bold transition ${
          hasIssues
            ? 'bg-amber-500 text-white hover:bg-amber-600 animate-pulse'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
        title={hasIssues ? `${totalIssues}件の修正が必要` : '保守ツール（通常は不要）'}
      >
        🔧 保守ツール
        {hasIssues && (
          <span className="absolute -top-2 -right-2 bg-red-600 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
            {totalIssues! > 99 ? '!' : totalIssues}
          </span>
        )}
      </button>
      {open && (
        <MaintenanceModal
          password={password}
          onClose={() => { setOpen(false); checkHealth() }}
          onChanged={() => { onChanged(); checkHealth() }}
        />
      )}
    </>
  )
}

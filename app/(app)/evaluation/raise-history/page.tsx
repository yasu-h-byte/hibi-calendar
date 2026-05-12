'use client'

/**
 * 旧 /evaluation/raise-history → /evaluation?tab=raise-history へリダイレクト
 *
 * 2026-05-12: 昇給履歴を /evaluation のタブに統合したため、独立ページは廃止。
 * 既存リンク・ブックマークの後方互換のためリダイレクトのみ残す。
 */

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function RaiseHistoryRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const wid = searchParams.get('worker')
    const url = wid
      ? `/evaluation?tab=raise-history&worker=${wid}`
      : '/evaluation?tab=raise-history'
    router.replace(url)
  }, [router, searchParams])

  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-gray-500">移動中...</div>
    </div>
  )
}

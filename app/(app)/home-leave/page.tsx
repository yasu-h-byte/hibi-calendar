'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /home-leave は廃止。
 * 「休暇管理」ページの「✈️ 帰国情報」タブに統合されたためリダイレクト。
 * 既存ブックマークやリンクからのアクセスを救済する。
 */
export default function HomeLeaveRedirectPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/leave?tab=homeleave')
  }, [router])

  return (
    <div className="max-w-2xl mx-auto p-6 text-center">
      <div className="text-gray-500 dark:text-gray-400 text-sm">
        このページは「休暇管理」内の「✈️ 帰国情報」タブに移動しました。<br />
        自動的にリダイレクトしています...
      </div>
    </div>
  )
}

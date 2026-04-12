'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** アクティビティは管理者設定に統合されました。リダイレクトします。 */
export default function ActivityRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/settings')
  }, [router])
  return null
}

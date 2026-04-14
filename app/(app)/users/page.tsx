'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** ユーザー管理は管理者設定に統合されました。リダイレクトします。 */
export default function UsersRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/settings')
  }, [router])
  return null
}

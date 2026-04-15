'use client'

import { useEffect, useState } from 'react'
import { AuthUser } from '@/types'

/**
 * localStorage の hibi_auth から password と user を取得するフック
 *
 * 17+ ファイルで重複していた以下のパターンを統一:
 *   const stored = localStorage.getItem('hibi_auth')
 *   if (stored) { const { password, user } = JSON.parse(stored); ... }
 *
 * @returns { password, user, ready }
 *   - password: 認証パスワード（未取得時は空文字列）
 *   - user: ログインユーザー情報（未取得時は null）
 *   - ready: localStorage 読み込み完了フラグ（SSR対応）
 */
export function useAuthPassword(): {
  password: string
  user: AuthUser | null
  ready: boolean
} {
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const parsed = JSON.parse(stored) as { password?: string; user?: AuthUser }
        if (parsed.password) setPassword(parsed.password)
        if (parsed.user) setUser(parsed.user)
      }
    } catch {
      // ignore — malformed storage
    } finally {
      setReady(true)
    }
  }, [])

  return { password, user, ready }
}

/**
 * 即座に password を取得する同期関数（useEffect内やイベントハンドラで使用）
 * フックが使えない場面での逃げ道。
 */
export function getAuthPasswordSync(): string {
  try {
    const stored = localStorage.getItem('hibi_auth')
    if (!stored) return ''
    const parsed = JSON.parse(stored) as { password?: string }
    return parsed.password || ''
  } catch {
    return ''
  }
}

/**
 * 同様に同期で user を取得
 */
export function getAuthUserSync(): AuthUser | null {
  try {
    const stored = localStorage.getItem('hibi_auth')
    if (!stored) return null
    const parsed = JSON.parse(stored) as { user?: AuthUser }
    return parsed.user || null
  } catch {
    return null
  }
}

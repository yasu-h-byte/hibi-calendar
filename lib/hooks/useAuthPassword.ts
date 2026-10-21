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
    const stored = readAuth()
    if (stored) {
      if (stored.password) setPassword(stored.password)
      if (stored.user) setUser(stored.user)
    }
    setReady(true)
  }, [])

  return { password, user, ready }
}

/** ログインの保存（localStorage の hibi_auth）。password の欄には通行証が入る（パスワードそのものは入れない・2026-09-26） */
export interface StoredAuth {
  password: string
  user: AuthUser | null
}

const STORAGE_KEY = 'hibi_auth'

/**
 * 保存してあるログイン（通行証と本人）を読む。無い・壊れている・サーバー側（window なし）なら null。
 * 2026-10-21 総点検: 画面 32 ファイルが localStorage.getItem('hibi_auth') + JSON.parse を手書きしていたのをここに集約
 * （キー名・形・壊れたときの扱いを 1 か所に。npm run lint:auth が直読みを落とす）
 */
export function readAuth(): StoredAuth | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)   // auth-ok: ここが唯一の読み口
    if (!stored) return null
    const parsed = JSON.parse(stored) as { password?: string; user?: AuthUser }
    return { password: parsed.password || '', user: parsed.user || null }
  } catch {
    return null
  }
}

/** ログイン画面が呼ぶ（通行証と本人を保存） */
export function saveAuth(sessionToken: string, user: AuthUser): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ password: sessionToken, user }))   // auth-ok: ここが唯一の書き口
}

/** ログアウト・通行証が使えなくなったとき */
export function clearAuth(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }   // auth-ok: ここが唯一の消し口
}

/**
 * 即座に password（通行証）を取得する同期関数（useEffect内やイベントハンドラで使用）
 * フックが使えない場面での逃げ道。
 */
export function getAuthPasswordSync(): string {
  return readAuth()?.password || ''
}

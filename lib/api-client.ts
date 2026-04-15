import { getAuthPasswordSync } from './hooks/useAuthPassword'

/**
 * 認証ヘッダー付きの fetch ラッパー
 *
 * 16+ ファイルで重複していた以下のパターンを統一:
 *   fetch(url, { headers: { 'x-admin-password': password } })
 *
 * パスワードは自動的に localStorage から取得（明示的に渡すことも可）
 */
export async function fetchWithAuth(
  url: string,
  options: RequestInit & { password?: string } = {},
): Promise<Response> {
  const { password: pwArg, headers: headersArg, ...rest } = options
  const password = pwArg || getAuthPasswordSync()

  const headers: Record<string, string> = {
    'x-admin-password': password,
    ...(headersArg as Record<string, string> | undefined),
  }

  return fetch(url, { ...rest, headers })
}

/**
 * JSON を送信する POST リクエスト
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  options: { password?: string } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      password: options.password,
    })
    const contentType = res.headers.get('content-type') || ''
    const data = contentType.includes('application/json')
      ? ((await res.json().catch(() => null)) as T | null)
      : null
    if (!res.ok) {
      const err =
        data && typeof data === 'object' && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: err }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * JSON を取得する GET リクエスト
 */
export async function getJson<T = unknown>(
  url: string,
  options: { password?: string } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetchWithAuth(url, { password: options.password })
    const contentType = res.headers.get('content-type') || ''
    const data = contentType.includes('application/json')
      ? ((await res.json().catch(() => null)) as T | null)
      : null
    if (!res.ok) {
      const err =
        data && typeof data === 'object' && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: err }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * API ルート用の共通ミドルウェア
 *
 * 全 33 本の API ルートに以下のパターンが重複していた:
 *   if (!await checkApiAuth(request)) {
 *     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 *   }
 *
 * これを withAuth() でラップして統一する。
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from './auth'

export type ApiHandler = (request: NextRequest) => Promise<NextResponse> | NextResponse

/**
 * 認証付きハンドラーラッパー
 *
 * 使用例:
 *   export const GET = withAuth(async (req) => {
 *     const data = await something()
 *     return NextResponse.json(data)
 *   })
 */
export function withAuth(handler: ApiHandler): ApiHandler {
  return async (request: NextRequest) => {
    if (!(await checkApiAuth(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    try {
      return await handler(request)
    } catch (error) {
      console.error(`API error [${request.url}]:`, error)
      const detail = error instanceof Error ? error.message : String(error)
      return NextResponse.json({ error: 'Server error', detail }, { status: 500 })
    }
  }
}

/**
 * action 文字列ベースのPOSTハンドラーを生成
 * if/else if の連鎖を排除する
 *
 * 使用例:
 *   export const POST = withActions({
 *     create: async (body, req) => { ... },
 *     update: async (body, req) => { ... },
 *     delete: async (body, req) => { ... },
 *   })
 */
export function withActions<TBody extends { action?: string }>(
  actions: Record<string, (body: TBody, request: NextRequest) => Promise<NextResponse> | NextResponse>,
): ApiHandler {
  return withAuth(async (request: NextRequest) => {
    let body: TBody
    try {
      body = (await request.json()) as TBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const action = body.action
    if (!action || typeof action !== 'string') {
      return NextResponse.json({ error: 'action required' }, { status: 400 })
    }
    const handler = actions[action]
    if (!handler) {
      return NextResponse.json(
        { error: `Unknown action: ${action}`, validActions: Object.keys(actions) },
        { status: 400 },
      )
    }
    return await handler(body, request)
  })
}

/**
 * 共通エラーレスポンス
 */
export function errorResponse(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/**
 * 共通成功レスポンス
 */
export function successResponse<T>(data: T = {} as T): NextResponse {
  return NextResponse.json({ success: true, ...data })
}

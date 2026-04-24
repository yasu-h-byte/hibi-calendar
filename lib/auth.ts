import { AuthUser, UserRole, Site, Worker } from '@/types'
import { NextRequest } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'

// 個人パスワードのキャッシュ（APIリクエストごとにFirestore読み取りを避ける）
let cachedUserPasswords: Record<string, string> | null = null
let cacheTimestamp = 0
const CACHE_TTL = 60_000 // 1分

async function getUserPasswords(): Promise<Record<string, string>> {
  const now = Date.now()
  if (cachedUserPasswords && now - cacheTimestamp < CACHE_TTL) {
    return cachedUserPasswords
  }
  try {
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const mainData = mainSnap.exists() ? mainSnap.data() : {}
    cachedUserPasswords = (mainData.userPasswords || {}) as Record<string, string>
    cacheTimestamp = now
    return cachedUserPasswords
  } catch {
    return cachedUserPasswords || {}
  }
}

/**
 * API認証チェック（共通）
 * ADMIN_PASSWORD、SUPER_ADMIN_PASSWORD、または個人パスワードのいずれかに一致すればOK
 */
export async function checkApiAuth(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('x-admin-password')
  if (!authHeader) return false

  // 管理者パスワードチェック（高速）
  const adminPw = process.env.ADMIN_PASSWORD
  const superPw = process.env.SUPER_ADMIN_PASSWORD
  if ((!!adminPw && authHeader === adminPw) || (!!superPw && authHeader === superPw)) {
    return true
  }

  // 個人パスワードチェック（役員・事務）
  const userPasswords = await getUserPasswords()
  for (const pw of Object.values(userPasswords)) {
    if (pw && authHeader === pw) return true
  }

  return false
}

/** パスワード変更時にキャッシュをクリアする */
export function clearPasswordCache(): void {
  cachedUserPasswords = null
  cacheTimestamp = 0
}

/**
 * 認証 + 操作者の識別子取得（監査ログ用）
 * - super-admin: 日比靖仁 (workerId=0)
 * - admin: 共通管理者パスワード → 識別不可のため 'admin' 文字列
 * - personal: 個人パスワード → workerId (number)
 */
export type ApiAuthResult =
  | { authorized: true; actor: number | 'admin' | 'super-admin' }
  | { authorized: false }

export async function getApiAuthUser(request: NextRequest): Promise<ApiAuthResult> {
  const authHeader = request.headers.get('x-admin-password')
  if (!authHeader) return { authorized: false }

  // スーパー管理者: 日比靖仁
  const superPw = process.env.SUPER_ADMIN_PASSWORD
  if (superPw && authHeader === superPw) {
    return { authorized: true, actor: 'super-admin' }
  }

  // 共通管理者パスワード（誰か特定不可）
  const adminPw = process.env.ADMIN_PASSWORD
  if (adminPw && authHeader === adminPw) {
    return { authorized: true, actor: 'admin' }
  }

  // 個人パスワード
  const userPasswords = await getUserPasswords()
  for (const [wid, pw] of Object.entries(userPasswords)) {
    if (pw && authHeader === pw) {
      return { authorized: true, actor: Number(wid) }
    }
  }

  return { authorized: false }
}

const APPROVER_ID = 1 // 日比政仁

export function determineRole(workerId: number, sites: Site[]): { role: UserRole; foremanSites: string[] } {
  const foremanSites = sites.filter(s => s.foreman === workerId).map(s => s.id)

  if (workerId === APPROVER_ID) {
    return { role: 'approver', foremanSites }
  }

  if (foremanSites.length > 0) {
    return { role: 'foreman', foremanSites }
  }

  return { role: 'admin', foremanSites: [] }
}

export function buildAuthUser(worker: Worker, sites: Site[]): AuthUser {
  // 事務ロールはjobTypeで直接判定
  if (worker.jobType === 'jimu') {
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'jimu',
      foremanSites: [],
      token: worker.token || undefined,
    }
  }

  // 職長ロールはjobTypeでも判定（アーカイブ済み現場の職長に対応）
  if (worker.jobType === 'shokucho') {
    const foremanSites = sites.filter(s => s.foreman === worker.id).map(s => s.id)
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'foreman',
      foremanSites,
      token: worker.token || undefined,
    }
  }

  const { role, foremanSites } = determineRole(worker.id, sites)
  return {
    workerId: worker.id,
    name: worker.name,
    role,
    foremanSites,
    token: worker.token || undefined,
  }
}

import { AuthUser, UserRole, Site, Worker } from '@/types'
import { NextRequest } from 'next/server'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'

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

/** 当月の YYYYMM を返す（JST 基準） */
function currentYm(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 当該ワーカーが「現在月で職長として担当する現場ID」を返す。
 * mforeman[siteId_ym] の月別 override を優先し、なければ sites.foreman を採用。
 *
 * 2026-05-08 修正: mforeman を反映していなかったため、月途中の職長交代で
 *   旧職長が承認できる/新職長が承認できない事態が起きていた。
 */
export function computeForemanSites(
  workerId: number,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }>,
  ym: string,
): string[] {
  const result: string[] = []
  for (const site of sites) {
    if (site.archived) continue
    const monthKey = `${site.id}_${ym}`
    const override = mforeman[monthKey]?.foreman ?? mforeman[monthKey]?.wid
    const effective = override ?? site.foreman
    if (effective === workerId) result.push(site.id)
  }
  return result
}

export function determineRole(
  workerId: number,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }> = {},
  ym: string = currentYm(),
): { role: UserRole; foremanSites: string[] } {
  const foremanSites = computeForemanSites(workerId, sites, mforeman, ym)

  if (workerId === APPROVER_ID) {
    return { role: 'approver', foremanSites }
  }

  if (foremanSites.length > 0) {
    return { role: 'foreman', foremanSites }
  }

  return { role: 'admin', foremanSites: [] }
}

export function buildAuthUser(
  worker: Worker,
  sites: Site[],
  mforeman: Record<string, { foreman?: number; wid?: number }> = {},
): AuthUser {
  const ym = currentYm()
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

  // 役員ロールはjobTypeで直接判定。ただし政仁さん（APPROVER_ID=1）は事業責任者ロール
  // 役員が現場の foreman として登録されていても admin として扱う
  if (worker.jobType === 'yakuin') {
    const foremanSites = computeForemanSites(worker.id, sites, mforeman, ym)
    return {
      workerId: worker.id,
      name: worker.name,
      role: worker.id === APPROVER_ID ? 'approver' : 'admin',
      foremanSites,
      token: worker.token || undefined,
    }
  }

  // 職長ロールはjobTypeでも判定（アーカイブ済み現場の職長に対応）
  if (worker.jobType === 'shokucho') {
    const foremanSites = computeForemanSites(worker.id, sites, mforeman, ym)
    return {
      workerId: worker.id,
      name: worker.name,
      role: 'foreman',
      foremanSites,
      token: worker.token || undefined,
    }
  }

  const { role, foremanSites } = determineRole(worker.id, sites, mforeman, ym)
  return {
    workerId: worker.id,
    name: worker.name,
    role,
    foremanSites,
    token: worker.token || undefined,
  }
}

/**
 * サーバ側でリクエスト元の「ロール」を解決する（2026-06 追加）。
 *
 * これまで承認系API（submit/approve/bulk-confirm/revert/reject）は checkApiAuth の
 * パスワード一致のみで、ロール強制はフロントだけだった（＝API直叩きで誰でも承認できた）。
 * 本関数で個人パスワード→実ロールを解決し、各ルートで権限を強制する。
 *
 * - super-admin / admin（共通管理者パスワード）: 全権限
 * - 個人パスワード: 人員マスタの jobType / 職長割当からロールを判定（buildAuthUser と同じ）
 * @param ym 職長判定の対象月（"YYYY-MM" or "YYYYMM"）。省略時は当月。
 */
export interface ApiRole {
  role: UserRole | 'super-admin'
  workerId: number | null
  foremanSites: string[]
}

/** 承認・差し戻し等の管理操作を行える権限か（職長は不可・最終承認は管理者/事業責任者） */
export function isManagerRole(role: string): boolean {
  return role === 'super-admin' || role === 'admin' || role === 'approver'
}

export async function getApiRole(request: NextRequest, ym?: string): Promise<ApiRole | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return null
  if (auth.actor === 'super-admin') return { role: 'super-admin', workerId: 0, foremanSites: [] }
  if (auth.actor === 'admin') return { role: 'admin', workerId: null, foremanSites: [] }

  // 個人パスワード → 人員マスタから実ロールを解決
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const main = mainSnap.exists() ? mainSnap.data() : {}
  const workers = (main.workers || []) as Worker[]
  const sites = (main.sites || []) as Site[]
  const mforeman = (main.mforeman || {}) as Record<string, { foreman?: number; wid?: number }>
  const worker = workers.find(w => w.id === auth.actor)
  if (!worker) return null

  const u = buildAuthUser(worker, sites, mforeman)
  const targetYm = ym ? ym.replace('-', '') : currentYm()
  const foremanSites = computeForemanSites(worker.id, sites, mforeman, targetYm)
  return { role: u.role, workerId: u.workerId, foremanSites }
}

import type { NextRequest } from 'next/server'
import type { Site, Worker } from '@/types'
import { buildAuthUser, computeForemanSites, getApiAuthUser, type ApiAuthResult, type ApiRole } from '@/lib/auth'

/**
 * 出面グリッド POST（職長承認・出面保存）の「担当現場」サーバ側チェック（2026-09-15 追加）。
 *
 * 旧: checkApiAuth（パスワード一致）のみで、職長が担当現場以外を承認・入力できないのは
 *     クライアント UI だけの制限だった（API 直叩きで他現場の職長承認・出面上書きが可能）。
 * 新: 呼び出し元が「職長（role 'foreman'）」と特定できる場合、対象 siteId がその月の
 *     foremanSites（mforeman 月別交代・工種サイト込み）に含まれなければ 403。
 *
 * ⚠️ 限界: 職長が共通パスワード（ADMIN_PASSWORD）でログインして名前を選ぶ経路では、
 *   サーバに届くのは共通パスワードだけで「誰か」を特定できない（actor 'admin'）。
 *   この経路は従来どおり通す（管理者の操作と区別できないため）。個人パスワードで
 *   ログインした職長だけが本チェックの対象になる。根治は職長の個人パスワード化。
 *
 * super-admin / admin / approver / jimu（および yakuin 等 admin 扱い）は従来どおり制限しない。
 */

type MforemanMap = Record<string, { foreman?: number; wid?: number }>

export interface GridMainLike {
  workers: unknown[]
  sites: unknown[]
  mforeman: MforemanMap
}

/**
 * 認証結果と demmen/main の内容から ApiRole を解決する（純関数）。
 * getApiRole と同じ判定だが、Firestore を直接読まず呼び出し側のキャッシュ済み main を使う
 * （オートセーブで1セルごとに呼ばれるため、読み取り回数を増やさない）。
 * @param ym 対象月 "YYYYMM" or "YYYY-MM"
 */
export function resolveApiRoleFromMain(auth: ApiAuthResult, main: GridMainLike, ym: string): ApiRole | null {
  if (!auth.authorized) return null
  if (auth.actor === 'super-admin') return { role: 'super-admin', workerId: 0, foremanSites: [] }
  if (auth.actor === 'admin') return { role: 'admin', workerId: null, foremanSites: [] }

  const workers = main.workers as Worker[]
  const sites = main.sites as Site[]
  const worker = workers.find(w => w.id === auth.actor)
  if (!worker) return null
  const u = buildAuthUser(worker, sites, main.mforeman)
  const foremanSites = computeForemanSites(worker.id, sites, main.mforeman, ym.replace('-', ''))
  return { role: u.role, workerId: u.workerId, foremanSites }
}

export type SiteScopeResult = { ok: true } | { ok: false; status: 401 | 403; error: string }

/** 職長なら対象現場が担当現場か判定する（純関数）。職長以外は常に ok。 */
export function checkForemanSiteScope(role: ApiRole | null, siteId: unknown): SiteScopeResult {
  if (!role) return { ok: false, status: 401, error: 'Unauthorized' }
  if (role.role !== 'foreman') return { ok: true }
  if (typeof siteId === 'string' && siteId && role.foremanSites.includes(siteId)) return { ok: true }
  return { ok: false, status: 403, error: '担当現場ではないため操作できません（担当現場の職長または管理者のみ）' }
}

/** 担当現場チェックの対象アクションか（職長承認系と出面保存） */
export function isForemanScopedGridAction(action: unknown): boolean {
  return !action || action === 'saveAttendance'
    || action === 'approve' || action === 'approve_foreman'
    || action === 'unapprove' || action === 'unapprove_foreman'
    // 工種の出し分け（2026-09-25）: 既定の工種の設定・日別の工種切替も
    // 担当現場（親現場 id）の職長のみに限る
    || action === 'saveDefaultWorkType' || action === 'moveWorkType' || action === 'setDayWorkType'
}

/** ルートから呼ぶ入口: 認証 → ロール解決 → 担当現場チェック */
export async function checkGridForemanScope(
  request: NextRequest,
  main: GridMainLike,
  siteId: unknown,
  ym: unknown,
): Promise<SiteScopeResult> {
  const auth = await getApiAuthUser(request)
  // admin/super-admin は main も ym も不要（共通パスワード経由の職長もここ＝上記の限界）
  if (auth.authorized && typeof auth.actor !== 'number') return { ok: true }
  if (!auth.authorized) return { ok: false, status: 401, error: 'Unauthorized' }
  if (typeof ym !== 'string' || !/^\d{4}-?\d{2}$/.test(ym)) {
    // ym が無い/不正ならロール判定できないので、職長かどうかだけ当月基準で見て職長は拒否
    const role = resolveApiRoleFromMain(auth, main, '000000')
    return role?.role === 'foreman'
      ? { ok: false, status: 403, error: '対象月が不正です' }
      : checkForemanSiteScope(role, siteId)
  }
  return checkForemanSiteScope(resolveApiRoleFromMain(auth, main, ym), siteId)
}

/**
 * 申請一覧（有給申請・帰国申請）の「誰にどこまで見せるか」（2026-10-02 総合点検）。
 *
 * 旧: /api/leave-request と /api/home-long-leave の一覧は checkApiAuth（ログインしていれば誰でも）で
 *     全現場ぶんを返していた。職長が他の現場の人の申請・理由まで読めた。
 * 決まり（lib/permissions.ts に合わせる）:
 *   - 休暇管理を見られる人（leave.view: 事務・事業責任者・役員・代表）→ 全部
 *   - 職長 → 自分が職長承認する現場（approvingForemenOfSite・月別職長込み）の申請だけ
 *   - それ以外 → 無し
 */
import type { NextRequest } from 'next/server'
import { getApiAuthUser, callerCan, approvingForemenOfSite } from './auth'
import { getMainData } from './compute'
import { getStaffSites } from './attendance'

export type RequestListScope =
  | { kind: 'all' }
  | { kind: 'foreman'; workerId: number }
  | { kind: 'none' }

export async function requestListScopeOf(request: NextRequest): Promise<RequestListScope> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return { kind: 'none' }
  if (await callerCan(request, 'leave.view')) return { kind: 'all' }
  if (typeof auth.actor === 'number') return { kind: 'foreman', workerId: auth.actor }
  return { kind: 'none' }
}

type MainLike = { sites: { id: string; foreman?: number; foremen?: number[] }[]; mforeman: Record<string, { foreman?: number; wid?: number }>; workers: { id: number; job?: string }[] }

/** その申請（現場・月）を、その職長が職長承認する立場か */
function foremanApprovesSite(main: MainLike, workerId: number, siteId: string, ym: string): boolean {
  const site = main.sites.find(s => s.id === siteId)
  if (!site) return false
  return approvingForemenOfSite(site, main.mforeman || {}, ym, main.workers || []).includes(workerId)
}

/** 有給申請の一覧を範囲で絞る（現場＝申請の siteId、月＝申請の ym） */
export async function filterLeaveRequestsByScope<T extends { siteId?: string; ym?: string; date?: string }>(
  scope: RequestListScope, requests: T[],
): Promise<T[]> {
  if (scope.kind === 'all') return requests
  if (scope.kind === 'none') return []
  const main = await getMainData() as unknown as MainLike
  return requests.filter(r => {
    const ym = r.ym || (r.date ? r.date.slice(0, 7).replace('-', '') : '')
    return !!r.siteId && !!ym && foremanApprovesSite(main, scope.workerId, r.siteId, ym)
  })
}

/**
 * 帰国申請の一覧を範囲で絞る。帰国申請には現場が無いので「申請者の配置現場（今月）」を職長承認する立場か
 * （権限判定 getForemenOfWorkerSites と同じ考え方）。同じ人は1回だけ調べる
 */
export async function filterHomeLeaveRequestsByScope<T extends { workerId: number }>(
  scope: RequestListScope, requests: T[], todayYm: string,
): Promise<T[]> {
  if (scope.kind === 'all') return requests
  if (scope.kind === 'none') return []
  const main = await getMainData() as unknown as MainLike
  const cache = new Map<number, boolean>()
  const out: T[] = []
  for (const r of requests) {
    let ok = cache.get(r.workerId)
    if (ok === undefined) {
      const staffSites = await getStaffSites(r.workerId)
      ok = staffSites.some(ss => foremanApprovesSite(main, scope.workerId, ss.id, todayYm))
      cache.set(r.workerId, ok)
    }
    if (ok) out.push(r)
  }
  return out
}

/**
 * 月締めの前提「出面の承認がそろっているか」を会社ごとに数える（2026-10-02）
 *
 * 月締め（app/api/monthly/lock）の判定と、月次集計画面の締めの準備カード（app/api/monthly）で同じものを使う。
 *   旧: カードの「出面の承認」は締めるまで常に緑のチェック（実際の承認状況を見ていなかった）
 *       → 承認が残っているのに「済み」に見え、本人確認だけが警告になっていた（代表指摘）
 *
 * 対象: 労働実績（出勤 w>0 / 残業 o>0）のある「現場×日」。有給・休み・現場都合・帰国だけの日は対象外。
 * 判定は lib/approval-gap.ts（工種サイトは親にまとめ、子で承認した古い記録も数える・2分キャッシュ）。
 * 2026-09 分から最終承認（事業責任者）も必須。それより前の月は職長承認だけを見る。
 */
import { approvalGap, FINAL_APPROVAL_REQUIRED_FROM_YM, type ApprovalGap } from './approval-gap'
import { calendarSiteIdOf, type HierarchySite } from './site-hierarchy'
import { parseDKey } from './compute'

export type OrgKey = 'hibi' | 'hfu'

export interface MonthApprovalStatus {
  /** 承認が必要な「現場×日」の数（0＝実績なし） */
  needed: number
  /** 最終承認まで求める月か */
  finalRequired: boolean
  /** 足りない「現場（親）×日」。finalRequired=false の月は finalMissing を空にする */
  gap: ApprovalGap
  /** 承認がそろった（締めの前提を満たす） */
  complete: boolean
}

const isHfu = (o?: string) => o === 'hfu' || o === 'HFU'

export async function monthApprovalStatus(
  main: { workers: { id: number; org?: string }[]; sites: unknown[] },
  attD: Record<string, unknown>,
  ym: string,
  org: OrgKey | 'all',
): Promise<MonthApprovalStatus> {
  const workerOrg = new Map(main.workers.map(w => [w.id, isHfu(w.org) ? 'hfu' : 'hibi']))
  const sitesH = main.sites as unknown as HierarchySite[]
  const famDays = new Map<string, { familyId: string; day: number }>()
  for (const [key, entry] of Object.entries(attD || {})) {
    if (!entry || typeof entry !== 'object') continue
    const pk = parseDKey(key)
    if (pk.ym !== ym) continue
    const wOrg = workerOrg.get(Number(pk.wid))
    if (!wOrg) continue
    if (org !== 'all' && wOrg !== org) continue
    const e = entry as { w?: number; o?: number }
    if (!((e.w || 0) > 0 || (e.o || 0) > 0)) continue
    const fd = { familyId: calendarSiteIdOf(sitesH, pk.sid), day: Number(pk.day) }
    famDays.set(`${fd.familyId}|${fd.day}`, fd)
  }
  const finalRequired = ym >= FINAL_APPROVAL_REQUIRED_FROM_YM
  if (famDays.size === 0) return { needed: 0, finalRequired, gap: { foremanMissing: [], finalMissing: [] }, complete: true }
  const raw = await approvalGap(sitesH as { id: string; parentId?: string }[], ym, [...famDays.values()])
  const gap = finalRequired ? raw : { foremanMissing: raw.foremanMissing, finalMissing: [] }
  return { needed: famDays.size, finalRequired, gap, complete: gap.foremanMissing.length === 0 && gap.finalMissing.length === 0 }
}

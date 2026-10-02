/**
 * 月締めの前提「出面の承認がそろっているか」を会社ごとに数える（2026-10-02）
 *
 * 月締め（app/api/monthly/lock）の判定と、月次集計画面の締めの準備カード（app/api/monthly）で同じものを使う。
 *   旧: カードの「出面の承認」は締めるまで常に緑のチェック（実際の承認状況を見ていなかった）
 *       → 承認が残っているのに「済み」に見え、本人確認だけが警告になっていた（代表指摘）
 *
 * 対象の日（2026-09 分から・ALL_DAYS_APPROVAL_FROM_YM）: 本人確認と同じ（lib/attendance-confirm-server.ts の requiredFamilyDays）。
 *   その会社の人それぞれの「記録がある日（出勤・残業・有給・休み・0.6補…すべて）＋記録が無い主現場の仕事の日」の和。
 *   2026-10-02 代表決定（案B）: 0.6補・欠勤は給料の額に直接関わるので、休みだけの日も職長・事業責任者が見てから締める。
 *   旧: 出勤・残業（w>0 / o>0）のある日だけ → 締めが通っても本人確認が「承認待ち」のまま残ることがあった
 * 2026-08 分まで: 出勤・残業のある日だけ・職長承認だけ（当時の決まりのまま。締め直しを止めない）。
 * 判定は lib/approval-gap.ts（工種サイトは親にまとめ、子で承認した古い記録も数える・2分キャッシュ）。
 */
import { approvalGap, FINAL_APPROVAL_REQUIRED_FROM_YM, type ApprovalGap, type FamilyDay } from './approval-gap'
import { calendarSiteIdOf, type HierarchySite } from './site-hierarchy'
import { parseDKey } from './compute'
import { mapRawWorkers } from './workers'
import { confirmMonthContext } from './attendance-confirm-server'
import type { AttendanceEntry } from '@/types'

/** 休み・有給・0.6補だけの日や未入力の仕事の日まで承認を求める月の始まり（2026-10-02 代表決定・案B） */
export const ALL_DAYS_APPROVAL_FROM_YM = '202609'

export type OrgKey = 'hibi' | 'hfu'

export interface MonthApprovalStatus {
  /** 承認が必要な「現場×日」の数（0＝記録なし） */
  needed: number
  /** 最終承認まで求める月か */
  finalRequired: boolean
  /** 足りない「現場（親）×日」。finalRequired=false の月は finalMissing を空にする */
  gap: ApprovalGap
  /** 承認がそろった（締めの前提を満たす） */
  complete: boolean
}

const isHfu = (o?: string) => o === 'hfu' || o === 'HFU'

/** 旧（2026-08 分まで）: 出勤・残業のある「現場（親）×日」 */
function workedFamilyDays(
  main: { workers: { id: number; org?: string }[] }, sitesH: HierarchySite[], attD: Record<string, unknown>, ym: string, org: OrgKey | 'all',
): FamilyDay[] {
  const workerOrg = new Map(main.workers.map(w => [w.id, isHfu(w.org) ? 'hfu' : 'hibi']))
  const out: FamilyDay[] = []
  for (const [key, entry] of Object.entries(attD || {})) {
    if (!entry || typeof entry !== 'object') continue
    const pk = parseDKey(key)
    if (pk.ym !== ym) continue
    const wOrg = workerOrg.get(Number(pk.wid))
    if (!wOrg) continue
    if (org !== 'all' && wOrg !== org) continue
    const e = entry as { w?: number; o?: number }
    if (!((e.w || 0) > 0 || (e.o || 0) > 0)) continue
    out.push({ familyId: calendarSiteIdOf(sitesH, pk.sid), day: Number(pk.day) })
  }
  return out
}

/**
 * 2026-09 分から: 外国人スタッフは本人確認と同じ「承認が必要な日」（記録がある日すべて＋主現場の仕事の日）、
 * 日本人などは従来どおり出勤・残業のある日。その会社の全員分の和。
 *   2026-10-02 代表決定: 休み・有給・0.6補の日まで見るのは外国人だけ（本人確認と同じ範囲）。
 *   日本人・事務・役員の空欄の日まで「承認が必要」にすると、誰も入力していない現場×日が生まれて締めが止まるため
 */
async function allFamilyDays(
  main: { workers: { id: number; org?: string }[] }, sitesH: HierarchySite[], attD: Record<string, unknown>, ym: string, org: OrgKey | 'all',
): Promise<FamilyDay[]> {
  const ctx = confirmMonthContext(sitesH, ym, attD as Record<string, AttendanceEntry | null>)
  // 会社は人員マスタの org で見る（旧ルールの workedFamilyDays と同じ isHfu。mapRawWorkers の company は小文字 'hfu' しか見ない）
  const rawOrg = new Map(main.workers.map(w => [w.id, isHfu(w.org) ? 'hfu' : 'hibi']))
  const foreign = mapRawWorkers(main.workers as unknown[])
    .filter(w => !!w.visaType && w.visaType !== 'none')
    .filter(w => org === 'all' || rawOrg.get(w.id) === org)
  const lists = await Promise.all(foreign.map(w => ctx.requiredFamilyDays(w)))
  return [...lists.flat(), ...workedFamilyDays(main, sitesH, attD, ym, org)]
}

export async function monthApprovalStatus(
  main: { workers: { id: number; org?: string }[]; sites: unknown[] },
  attD: Record<string, unknown>,
  ym: string,
  org: OrgKey | 'all',
  /** fresh: 承認をキャッシュを使わず読み直す（月締めの判定・2026-10-02） */
  opts?: { fresh?: boolean },
): Promise<MonthApprovalStatus> {
  const sitesH = main.sites as unknown as HierarchySite[]
  const list = ym >= ALL_DAYS_APPROVAL_FROM_YM
    ? await allFamilyDays(main, sitesH, attD, ym, org)
    : workedFamilyDays(main, sitesH, attD, ym, org)
  const famDays = new Map<string, FamilyDay>()
  for (const fd of list) famDays.set(`${fd.familyId}|${fd.day}`, fd)
  const finalRequired = ym >= FINAL_APPROVAL_REQUIRED_FROM_YM
  if (famDays.size === 0) return { needed: 0, finalRequired, gap: { foremanMissing: [], finalMissing: [] }, complete: true }
  const raw = await approvalGap(sitesH as { id: string; parentId?: string }[], ym, [...famDays.values()], opts)
  const gap = finalRequired ? raw : { foremanMissing: raw.foremanMissing, finalMissing: [] }
  return { needed: famDays.size, finalRequired, gap, complete: gap.foremanMissing.length === 0 && gap.finalMissing.length === 0 }
}

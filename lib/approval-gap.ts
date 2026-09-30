/**
 * 「現場×日」の承認がそろっているか（職長承認・最終承認）の共通判定（2026-09-30）
 *
 * 出面の承認は attendanceApprovals/{siteId}_{ym}_{day} に { foreman, final } で持つ（lib/attendance.ts）。
 * 承認がそろってから次へ進む処理はここを通す:
 *   - 本人の出面確認（lib/attendance-confirm-server.ts）
 *   - 請求書の発行・申請・承認（lib/peer-invoice-store.ts）
 *
 * 工種サイト（鉄骨・仮設など）は親現場の画面で承認する（2026-09-30 から子の選択欄を出さない）が、
 * それより前は子の画面で承認した記録もあるので、親・子どちらかに承認があれば「承認あり」とみなす。
 * 読み取りは2分キャッシュ（同じ現場・同じ日を何度も読まない）。
 */
import { db } from './firebase'
import { doc, getDoc } from '@/lib/fsdb'

/**
 * 最終承認（事業責任者）まで必須にする月の始まり（2026-09-30 代表決定）。
 * 月締め・請求書の発行はこの月から「職長承認＋最終承認」がそろっていることを求める。
 * それより前の月は最終承認の運用が無かった（締め直し・さかのぼりの請求書を止めない）
 */
export const FINAL_APPROVAL_REQUIRED_FROM_YM = '202609'

type Approval = { foreman?: unknown; final?: unknown } | null

const AP_TTL_MS = 2 * 60 * 1000
const apCache = new Map<string, { v: Approval; ts: number }>()

async function approvalOfKey(key: string): Promise<Approval> {
  const hit = apCache.get(key)
  if (hit && Date.now() - hit.ts < AP_TTL_MS) return hit.v
  let v: Approval = null
  try {
    const s = await getDoc(doc(db, 'attendanceApprovals', key))
    v = s.exists() ? (s.data() as Approval) : null
  } catch { v = null }
  apCache.set(key, { v, ts: Date.now() })
  return v
}

export interface FamilyDay { familyId: string; day: number }

export interface ApprovalGap {
  /** 職長承認が無い「現場（親）×日」 */
  foremanMissing: FamilyDay[]
  /** 最終承認（事業責任者）が無い「現場（親）×日」 */
  finalMissing: FamilyDay[]
}

/**
 * 現場（親）×日の一覧について、職長承認・最終承認の無いものを返す。
 * @param sites 現場マスタ（親子関係 parentId を見る）
 */
export async function approvalGap(
  sites: { id: string; parentId?: string }[], ym: string, famDays: FamilyDay[],
): Promise<ApprovalGap> {
  const uniq = new Map<string, FamilyDay>()
  for (const fd of famDays) uniq.set(`${fd.familyId}|${fd.day}`, fd)
  const children = (fam: string) => sites.filter(s => s.parentId === fam).map(s => s.id)
  const results = await Promise.all([...uniq.values()].map(async fd => {
    const ids = [fd.familyId, ...children(fd.familyId)]
    const aps = await Promise.all(ids.map(id => approvalOfKey(`${id}_${ym}_${fd.day}`)))
    return { fd, foreman: aps.some(a => !!a?.foreman), final: aps.some(a => !!a?.final) }
  }))
  const byOrder = (a: FamilyDay, b: FamilyDay) => a.familyId.localeCompare(b.familyId) || a.day - b.day
  return {
    foremanMissing: results.filter(r => !r.foreman).map(r => r.fd).sort(byOrder),
    finalMissing: results.filter(r => !r.final).map(r => r.fd).sort(byOrder),
  }
}

/** 画面・エラーに出す短い説明（現場名ごとに日を並べる） */
export function describeApprovalGap(gap: ApprovalGap, siteName: (familyId: string) => string): string {
  const fmt = (list: FamilyDay[]) => {
    const by = new Map<string, number[]>()
    for (const fd of list) by.set(fd.familyId, [...(by.get(fd.familyId) || []), fd.day])
    return [...by.entries()].map(([f, days]) =>
      `${siteName(f)} ${days.slice(0, 10).join('・')}日${days.length > 10 ? ` 他${days.length - 10}日` : ''}`).join('／')
  }
  const parts: string[] = []
  if (gap.foremanMissing.length) parts.push(`職長承認がない日: ${fmt(gap.foremanMissing)}`)
  if (gap.finalMissing.length) parts.push(`最終承認がない日: ${fmt(gap.finalMissing)}`)
  return parts.join('\n')
}

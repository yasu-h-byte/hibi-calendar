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

/** 承認の記録の日時（{ by, at }。古い記録などで無ければ ''） */
const atOf = (v: unknown): string => (v && typeof v === 'object' && typeof (v as { at?: unknown }).at === 'string' ? (v as { at: string }).at : '')

const AP_TTL_MS = 2 * 60 * 1000
// 読み取り中の Promise もそのまま持つ（2026-10-02 点検: 値だけを持っていたため、同時に何人分も判定すると
//   同じ承認ドキュメントを人数ぶん重ねて読んでいた）
const apCache = new Map<string, { p: Promise<Approval>; ts: number }>()

async function approvalOfKey(key: string, fresh = false): Promise<Approval> {
  const hit = apCache.get(key)
  if (!fresh && hit && Date.now() - hit.ts < AP_TTL_MS) return hit.p
  const p = getDoc(doc(db, 'attendanceApprovals', key))
    .then(s => (s.exists() ? (s.data() as Approval) : null))
    .catch(() => null)
  apCache.set(key, { p, ts: Date.now() })
  return p
}

/**
 * 承認を書いた・消したときに呼ぶ（同じサーバの中のキャッシュを消す）。
 * 別のサーバ（Vercel の別インスタンス）には届かないので、締めの判定は fresh で読み直す
 */
export function invalidateApprovalCache(key: string): void {
  apCache.delete(key)
}

export interface FamilyDay { familyId: string; day: number }

export interface ApprovalGap {
  /** 職長承認が無い「現場（親）×日」 */
  foremanMissing: FamilyDay[]
  /** 最終承認（事業責任者）が無い「現場（親）×日」 */
  finalMissing: FamilyDay[]
  /**
   * 見つかった承認のうち、いちばん新しい日時（ISO）。足りない承認が無いときは「全部そろった日時」になる
   * （本人確認の催促を「そろってから3日」で出すのに使う・2026-10-05）。日時の無い古い記録だけなら undefined
   */
  latestAt?: string
}

/**
 * 現場（親）×日の一覧について、職長承認・最終承認の無いものを返す。
 * @param sites 現場マスタ（親子関係 parentId を見る）
 */
export async function approvalGap(
  sites: { id: string; parentId?: string }[], ym: string, famDays: FamilyDay[],
  /** fresh: キャッシュを使わず読み直す（月締め・本人確認の記録など、判定を確定させるところで使う・2026-10-02） */
  opts?: { fresh?: boolean },
): Promise<ApprovalGap> {
  const uniq = new Map<string, FamilyDay>()
  for (const fd of famDays) uniq.set(`${fd.familyId}|${fd.day}`, fd)
  const children = (fam: string) => sites.filter(s => s.parentId === fam).map(s => s.id)
  const results = await Promise.all([...uniq.values()].map(async fd => {
    const ids = [fd.familyId, ...children(fd.familyId)]
    const aps = await Promise.all(ids.map(id => approvalOfKey(`${id}_${ym}_${fd.day}`, !!opts?.fresh)))
    // 親・子のどちらにも承認があるときは、早い方（＝その日がそろった時刻）を採る
    const first = (list: string[]) => list.filter(Boolean).sort()[0] || ''
    const foremanAt = first(aps.map(a => atOf(a?.foreman)))
    const finalAt = first(aps.map(a => atOf(a?.final)))
    return { fd, foreman: aps.some(a => !!a?.foreman), final: aps.some(a => !!a?.final), at: foremanAt > finalAt ? foremanAt : finalAt }
  }))
  const latestAt = results.map(r => r.at).filter(Boolean).sort().pop()
  const byOrder = (a: FamilyDay, b: FamilyDay) => a.familyId.localeCompare(b.familyId) || a.day - b.day
  return {
    foremanMissing: results.filter(r => !r.foreman).map(r => r.fd).sort(byOrder),
    finalMissing: results.filter(r => !r.final).map(r => r.fd).sort(byOrder),
    ...(latestAt ? { latestAt } : {}),
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

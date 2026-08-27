import { db } from './firebase'
import { getDocs, collection, query, where } from '@/lib/fsdb'

/**
 * 帰国期間情報を取得（2026-05-13 単一ソース化）
 *
 * 旧構成（〜2026-05-13）: 2ストレージから統合取得していた
 *   ① `homeLongLeave` コレクション（スマホ申請）
 *   ② `demmen/main.homeLeaves` 配列（管理者手動登録）
 *   問題: 同じ申請が両方に存在する状態（承認時にコピーされる）、
 *         さらに片方を編集してももう片方に反映されず重複表示が発生していた。
 *
 * 新構成: 単一ソース = `homeLongLeave` コレクション
 *   - スマホ申請: 通常通り status='pending' → 'foreman_approved' → 'approved'
 *   - 管理者の手動登録: status='approved' で直接作成
 *   - 編集/削除: doc 単位で直接更新（並列書き込み安全）
 *   - workerName は表示時にマスタからルックアップする（キャッシュ追従問題回避）
 */
export interface HomeLeaveEntry {
  workerId: number
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
}

/**
 * 「復帰未定（急な帰国）」を表す終了日の番兵値（2026-07-18 追加）。
 * 既存の終了日比較（endDate >= 月末 / endDate < today 等）は全て文字列比較のため、
 * 遠い未来の番兵を入れると「開始日以降ずっと帰国中」が自然に表現できる。
 * 復帰が確定したら実際の復帰日に置き換える。
 */
export const HOME_LEAVE_SENTINEL_END = '9999-12-31'
/** 終了日が番兵値か（＝復帰未定か）を判定 */
export function isReturnUndecided(endDate?: string): boolean {
  return !!endDate && endDate >= HOME_LEAVE_SENTINEL_END
}

export async function getAllActiveHomeLeaves(): Promise<HomeLeaveEntry[]> {
  const result: HomeLeaveEntry[] = []

  try {
    const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
    hlSnap.forEach(d => {
      const hl = d.data()
      // 2026-08-27 修正（休暇届総点検）: **最終承認済み(approved)のみ**を給与・通知に反映。
      //   旧: foreman_approved（職長承認どまり）も含めており、政仁さんの最終承認前に
      //   基本給の按分が減っていた（承認フロー原則違反）。さらに、その状態で締めると
      //   スナップショットに未確定の帰国が凍結され、後から承認も取消もできない詰みになっていた
      if (hl.status !== 'approved') return
      if (!hl.startDate || !hl.endDate) return
      result.push({
        workerId: hl.workerId,
        startDate: hl.startDate,
        endDate: hl.endDate,
      })
    })
  } catch { /* ignore */ }

  return result
}

/**
 * 指定スタッフが対象月(ym: "YYYYMM")の全期間を帰国中かどうか判定
 * - 月の1日〜末日がすべて帰国期間に含まれる場合のみ true
 * - 月の途中で帰国・復帰する場合は false（署名対象）
 */
export function isFullMonthHomeLeave(
  workerId: number,
  ym: string,
  homeLeaves: HomeLeaveEntry[]
): boolean {
  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

  // 2026-08-27 修正: 連続する複数の申請（例 8/1-15 + 8/16-31）が合算で月全体を
  //   カバーするケースにも対応（旧: 単一レコード判定で false → 未署名通知が誤発火）
  const mine = homeLeaves
    .filter(hl => hl.workerId === workerId && hl.endDate >= monthStart && hl.startDate <= monthEnd)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
  let cursor = monthStart
  for (const hl of mine) {
    if (hl.startDate > cursor) return false  // カバーの穴
    if (hl.endDate >= monthEnd) return true
    // 翌日へ（endDate は帰国期間に含む）
    const d = new Date(hl.endDate + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    const next = d.toISOString().slice(0, 10)
    if (next > cursor) cursor = next
  }
  return false
}

/**
 * 指定日が承認済みの帰国期間に含まれるか（2026-08-27 追加・休暇届総点検）。
 * 帰国中の日は無給の帰国扱いであり、有給(p)と両立しない。
 * 有給の申請・承認・スマホ直接入力のガードに使う。
 */
export async function isDateInApprovedHomeLeave(workerId: number, dateIso: string): Promise<boolean> {
  const leaves = await getAllActiveHomeLeaves()
  return leaves.some(hl => hl.workerId === workerId && dateIso >= hl.startDate && dateIso <= hl.endDate)
}

/**
 * 2つのYM形式に対応（YYYYMM or YYYY-MM）
 */
export function normalizeYm(ym: string): string {
  return ym.replace('-', '')
}

/**
 * approved な帰国記録だけを取得（手動登録 + スマホ承認済み）
 * UI 表示用。pending は除外、foreman_approved も除外（最終承認後のみ表示）。
 */
export async function getApprovedHomeLeaves(): Promise<Array<{
  id: string
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  note?: string
  source: 'mobile' | 'manual'
}>> {
  const result: Array<{
    id: string
    workerId: number
    workerName: string
    startDate: string
    endDate: string
    reason: string
    note?: string
    source: 'mobile' | 'manual'
  }> = []
  try {
    const q = query(collection(db, 'homeLongLeave'), where('status', '==', 'approved'))
    const snap = await getDocs(q)
    snap.forEach(d => {
      const v = d.data()
      result.push({
        id: d.id,
        workerId: v.workerId,
        workerName: v.workerName || '',
        startDate: v.startDate,
        endDate: v.endDate,
        reason: v.reason || '一時帰国',
        note: v.note,
        // requestedAt が無いものは管理者手動登録、ある場合はスマホ申請由来
        source: v.requestedAt ? 'mobile' : 'manual',
      })
    })
  } catch { /* ignore */ }
  return result
}

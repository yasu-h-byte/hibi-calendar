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
      // 承認待ち（pending/foreman_approved）も予定として扱う（旧仕様維持）
      if (hl.status !== 'approved' && hl.status !== 'foreman_approved') return
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

  return homeLeaves.some(hl =>
    hl.workerId === workerId &&
    hl.startDate <= monthStart &&
    hl.endDate >= monthEnd
  )
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

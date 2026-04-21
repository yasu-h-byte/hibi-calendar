import { db } from './firebase'
import { doc, getDoc, getDocs, collection } from 'firebase/firestore'

/**
 * 帰国期間情報を2つのソースから統合取得
 * - demmen/main の homeLeaves 配列（手動登録、承認済み扱い）
 * - homeLongLeave コレクション（スマホ申請、approved / foreman_approved）
 */
export interface HomeLeaveEntry {
  workerId: number
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
}

export async function getAllActiveHomeLeaves(): Promise<HomeLeaveEntry[]> {
  const result: HomeLeaveEntry[] = []
  const seen = new Set<string>()

  try {
    // ① スマホ申請
    const hlSnap = await getDocs(collection(db, 'homeLongLeave'))
    hlSnap.forEach(d => {
      const hl = d.data()
      if (hl.status !== 'approved' && hl.status !== 'foreman_approved') return
      const key = `${hl.workerId}_${hl.startDate}`
      seen.add(key)
      result.push({
        workerId: hl.workerId,
        startDate: hl.startDate,
        endDate: hl.endDate,
      })
    })
  } catch { /* ignore */ }

  try {
    // ② 手動登録
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    if (mainSnap.exists()) {
      const manual: { workerId: number; startDate: string; endDate: string }[] = mainSnap.data().homeLeaves || []
      for (const mhl of manual) {
        if (!mhl.startDate || !mhl.endDate) continue
        const key = `${mhl.workerId}_${mhl.startDate}`
        if (seen.has(key)) continue
        result.push({
          workerId: mhl.workerId,
          startDate: mhl.startDate,
          endDate: mhl.endDate,
        })
      }
    }
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

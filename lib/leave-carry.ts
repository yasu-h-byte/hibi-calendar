/**
 * 次期付与レコードの繰越（carryOver）を、前期の有給消化の変化に追随して再計算する
 * （2026-09-02 追加・有給繰越の総点検）。
 *
 * ■ なぜ必要か（グエン ヴァン ファン事案）
 *   半自動付与は付与日の30日前から実行できるため、次期レコードの carryOver は
 *   「実行時点の前期残」で固定される。実行後に前期の有給を取ると前期残は減るのに
 *   次期の繰越は減らず、繰越が過大になる（ファン: 8/17 に繰越11で作成 → その後1日取得
 *   → 実際の前期残は10）。承認済みの未来有給や日付変更・取消でも同じズレが起きる。
 *
 * ■ 方針
 *   有給(p)が出面に書かれる／消えるたびに、その日が属する付与期（前期）の次のレコードの
 *   繰越を calcLegalCarryOver で計算し直す。手動で繰越を調整したレコード
 *   （hasManualCarryOverOverride）と日本人（繰越なし）は触らない。
 *   呼び出し元は setAttendanceEntry / removePaidLeaveForDay（lib/attendance.ts）。
 *   失敗しても出面の書き込み自体は成功させる（ログのみ）。
 */
import { db } from './firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { calcLegalCarryOver, hasManualCarryOverOverride, selectActiveGrantRecord } from './leave-compute'

type Rec = {
  fy?: string | number
  grantDate?: string
  grantDays?: number
  grant?: number
  carryOver?: number
  carry?: number
  adjustment?: number
  adj?: number
  buyoutDays?: number
  buyoutHistory?: Array<{ days?: number }>
  _archived?: boolean
  [k: string]: unknown
}

/**
 * dateIso が属する付与レコード（前期）と、その次の付与レコード（次期）の添字を返す。
 * 次期が無ければ null（= 繰越を書く先が無い）。副作用なし・テスト可能。
 */
export function pickCarryTarget(records: Rec[], dateIso: string): { prevIdx: number; nextIdx: number } | null {
  const prev = selectActiveGrantRecord(records as Parameters<typeof selectActiveGrantRecord>[0], dateIso) as Rec | null
  if (!prev || !prev.grantDate) return null
  const prevIdx = records.indexOf(prev)
  if (prevIdx < 0) return null
  let nextIdx = -1
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (r._archived || !r.grantDate) continue
    if (!(((r.grantDays ?? 0) > 0) || ((r.grant ?? 0) > 0))) continue
    if (r.grantDate <= prev.grantDate) continue
    if (nextIdx < 0 || r.grantDate < (records[nextIdx].grantDate as string)) nextIdx = i
  }
  if (nextIdx < 0) return null
  return { prevIdx, nextIdx }
}

export async function recomputeNextCarryOver(
  workerId: number,
  dateIso: string,
): Promise<{ updated: boolean; from?: number; to?: number; reason?: string }> {
  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) return { updated: false, reason: 'main not found' }
  const data = snap.data()
  const worker = ((data.workers || []) as { id: number; visa?: string }[]).find(w => w.id === workerId)
  if (!worker) return { updated: false, reason: 'worker not found' }
  if (!worker.visa || worker.visa === 'none') return { updated: false, reason: 'japanese' }  // 日本人は繰越なし

  const plData = (data.plData || {}) as Record<string, Rec[]>
  const records = plData[String(workerId)] || []
  const t = pickCarryTarget(records, dateIso)
  if (!t) return { updated: false, reason: 'no next record' }
  const prev = records[t.prevIdx]
  const next = records[t.nextIdx]
  if (hasManualCarryOverOverride(next)) return { updated: false, reason: 'manual override' }

  // 前期の実消化（出面の p・承認済みの未来分を含む・同日多現場は1日）
  const { getLeaveBalance } = await import('./leave-balance')
  const bal = await getLeaveBalance(workerId, dateIso)
  if (bal.noGrant) return { updated: false, reason: 'no grant at date' }
  const prevGrant = prev.grantDays ?? prev.grant ?? 0
  const prevCarry = prev.carryOver ?? prev.carry ?? 0
  const prevAdj = prev.adjustment ?? prev.adj ?? 0
  const prevBuyout = prev.buyoutDays ?? (prev.buyoutHistory || []).reduce((s, h) => s + (h.days || 0), 0)
  const newCarry = calcLegalCarryOver({ prevGrant, prevCarry, prevAdj, prevBuyout, periodUsed: bal.periodUsed ?? 0 })
  const oldCarry = next.carryOver ?? next.carry ?? 0
  if (newCarry === oldCarry) return { updated: false, from: oldCarry, to: newCarry, reason: 'unchanged' }

  next.carryOver = newCarry
  next.carryOverRecalcAt = new Date().toISOString()
  next.carryOverRecalcFrom = oldCarry
  next.carryOverRecalcTrigger = dateIso
  // race-fix: dot-notation で 1 worker 単位に局所化
  await updateDoc(ref, { [`plData.${String(workerId)}`]: records })
  try {
    const { logActivity } = await import('./activity')
    await logActivity('system', 'leave.carryOverRecalc',
      `workerId=${workerId} ${next.grantDate} の繰越を ${oldCarry}→${newCarry} に再計算（${dateIso} の有給変更に追随）`)
  } catch { /* ログ失敗は無視 */ }
  return { updated: true, from: oldCarry, to: newCarry }
}

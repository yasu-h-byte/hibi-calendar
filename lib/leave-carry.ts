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

/**
 * 繰越を書き換える対象（前期・次期）を決める。書き換えない理由があれば reason を返す。
 * 副作用なし・テスト可能。事前チェック（キャッシュ）と本処理（最新の main）で同じ判定を使う。
 */
export function resolveCarryTarget(
  workers: { id: number; visa?: string }[],
  plData: Record<string, Rec[]>,
  workerId: number,
  dateIso: string,
): { records: Rec[]; prevIdx: number; nextIdx: number } | { reason: string } {
  const worker = workers.find(w => w.id === workerId)
  if (!worker) return { reason: 'worker not found' }
  if (!worker.visa || worker.visa === 'none') return { reason: 'japanese' }  // 日本人は繰越なし
  const records = plData[String(workerId)] || []
  const t = pickCarryTarget(records, dateIso)
  if (!t) return { reason: 'no next record' }
  const next = records[t.nextIdx]
  if (hasManualCarryOverOverride(next)) return { reason: 'manual override' }
  // 移行時に登録したレコード（legacy）の繰越は触らない（2026-09-02 代表確認）。
  //   システムの出面データは実質 2025-10 からで、それ以前の期の消化は紙の管理簿にしかない。
  //   legacy レコードの繰越は「8月末時点で管理簿と一致」と確認済みの値なので、
  //   システム内の消化数だけで計算し直すと確認済みの値を壊す（タン・ケンの前期など）。
  if (next.method === 'legacy') return { reason: 'legacy record' }
  return { records, ...t }
}

export async function recomputeNextCarryOver(
  workerId: number,
  dateIso: string,
): Promise<{ updated: boolean; from?: number; to?: number; reason?: string }> {
  // 事前チェック（2026-10-02）: setAttendanceEntry は有給以外の保存でも（deleteFields に 'p' が
  //   入るため）ここへ来る。書き換える次期が無い大半のケースは、30秒キャッシュの main だけで
  //   抜けて、最新 main の読み直しと最大13か月分の出面読み（getLeaveBalance）を省く。
  //   キャッシュが古くて「次期が無い」と誤判定しても、次期を作る半自動付与は作成時に繰越を計算する。
  {
    const { getMainData } = await import('./compute')
    const cached = await getMainData()
    const pre = resolveCarryTarget(cached.workers, cached.plData as unknown as Record<string, Rec[]>, workerId, dateIso)
    if ('reason' in pre) return { updated: false, reason: pre.reason }
  }

  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) return { updated: false, reason: 'main not found' }
  const data = snap.data()
  const r = resolveCarryTarget(
    (data.workers || []) as { id: number; visa?: string }[],
    (data.plData || {}) as Record<string, Rec[]>,
    workerId, dateIso,
  )
  if ('reason' in r) return { updated: false, reason: r.reason }
  const records = r.records
  const prev = records[r.prevIdx]
  const next = records[r.nextIdx]

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

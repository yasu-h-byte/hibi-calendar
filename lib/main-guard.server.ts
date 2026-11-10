import 'server-only'
/**
 * demmen/main への「控えと同じなら書く」書き込み（2026-11-10 全体点検）。決まりは lib/main-guard.ts。
 */
import { db } from '@/lib/firebase'
import { runTransaction } from '@/lib/fsdb'
import { MainConflictError, findMainConflict, type GuardCheck, type MainGuard } from '@/lib/main-guard'

/**
 * トランザクションの中で main を読み直し、check の場所が控え（guard）と同じなら updates を書く。
 * 違っていたら何も書かずに MainConflictError を投げる（呼び出し側は 409 で「もう一度」と返す）。
 * updates は updateDoc と同じ形（'plData.12' のような点つきの名前も可）。空なら何もしない。
 */
export async function guardedMainUpdate(mainRef: any, guard: MainGuard, check: GuardCheck, updates: Record<string, unknown>): Promise<void> {
  if (Object.keys(updates).length === 0) return
  await runTransaction(db, async tx => {
    const snap = await tx.get(mainRef)
    const where = findMainConflict(guard, snap.exists() ? snap.data() : null, check)
    if (where) throw new MainConflictError(where)
    tx.update(mainRef, updates)
  })
}

/** plData を人ごとに書く updates を作る（plData.{人} = 配列。空マップを渡す形にしない） */
export function plUpdates(plData: Record<string, unknown>, keys: string[] = Object.keys(plData)): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[`plData.${k}`] = plData[k]
  return out
}

/**
 * 給与チェックの注意点の「確認した」の記録を読む（サーバー専用・2026-10-05）。判定は lib/pay-note-ack.ts。
 *
 * 保存先: payNoteAcks/{ym}_{workerId}_{code}。月ごとに数件なので ym で引く。
 * メニューの赤い数字（/api/sidebar-badges）が開くたびに呼ぶので、60秒だけキャッシュする（読み取りを増やさない）。
 * 書いた・消したときは invalidatePayNoteAcks で同じサーバのキャッシュを消す。締めの判定は fresh で読み直す。
 */
import { db } from './firebase'
import { collection, getDocs, query, where } from '@/lib/fsdb'
import type { PayNoteAck } from './pay-note-ack'

const TTL_MS = 60 * 1000
const cache = new Map<string, { p: Promise<PayNoteAck[]>; ts: number }>()

export async function loadPayNoteAcks(ym: string, opts?: { fresh?: boolean }): Promise<PayNoteAck[]> {
  const hit = cache.get(ym)
  if (!opts?.fresh && hit && Date.now() - hit.ts < TTL_MS) return hit.p
  const p = getDocs(query(collection(db, 'payNoteAcks'), where('ym', '==', ym)))
    .then(qs => qs.docs.map(d => d.data() as PayNoteAck))
  cache.set(ym, { p, ts: Date.now() })
  // 読めなかったときは次の呼び出しで読み直す（失敗をキャッシュしない）
  p.catch(() => { if (cache.get(ym)?.p === p) cache.delete(ym) })
  return p
}

export function invalidatePayNoteAcks(ym: string): void {
  cache.delete(ym)
}

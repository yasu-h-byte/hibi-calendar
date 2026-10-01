/**
 * その会社・その月の請求書の記録のうち、いちばん最後に動いたもの（2026-10-01）。
 * 差し戻し → 再申請 → 発行 → 取り消し のように履歴が重なるとき、
 * 「差し戻しが1件でもある」ではなく最後の動きで状態を決めるために使う。
 * 各記録の時刻は、申請・発行・差し戻し/取り下げ・取り消しの時刻のうち最も新しいもの。
 * 画面（クライアント）からも使うので、サーバ専用の依存を持たせないこと。
 */
export function latestPeerInvoiceRecord<T extends {
  issuedAt?: string; requestedAt?: string; rejectedAt?: string; voidedAt?: string
}>(records: T[]): T | undefined {
  const at = (r: T) => [r.voidedAt, r.rejectedAt, r.issuedAt, r.requestedAt].filter((x): x is string => !!x).sort().pop() || ''
  let best: T | undefined
  for (const r of records) if (!best || at(r) > at(best)) best = r
  return best
}

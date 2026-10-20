'use client'

/**
 * 「請求・原価」のタブ③の上に出す「来てもらった分（支払う側の見込み）」（2026-10-20）。
 * 同業者・外注から応援をもらった人工 × 借りる単価（出面の外注原価と同じ額）を会社ごとに。
 * 旧「請求・支払の一覧」の支払う側を引き継いだ。届いた請求書との見比べは下の一覧（ReceiveView）が行う。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import type { PeerStatement } from '@/lib/peer-statement'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

export default function PaymentsPreview({ ym }: { ym: string }) {
  const { ready } = useAuthPassword()
  const [rows, setRows] = useState<PeerStatement[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const latest = useLatestRequest()
  const load = useCallback(async () => {
    if (!ready) return
    setRows(null)
    const req = latest.begin()
    try {
      const res = await fetchWithAuth(`/api/peer-statement?ym=${ym}`, { signal: req.signal })
      if (!req.isCurrent()) return
      const j = await res.json().catch(() => null)
      setRows(res.ok && j ? ((j.statements || []) as PeerStatement[]).filter(r => r.paymentTotal > 0) : [])
    } catch (e) { if (!latest.isAbort(e) && req.isCurrent()) setRows([]) }
  }, [ready, ym, latest])
  useEffect(() => { load() }, [load])

  if (!rows || rows.length === 0) return null
  const total = rows.reduce((t, r) => t + r.paymentTotal, 0)
  return (
    <details className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-3" open>
      <summary className="cursor-pointer flex items-center gap-3 flex-wrap text-sm">
        <span className="font-bold text-gray-900 dark:text-white">来てもらった分の見込み（支払う側・{rows.length}社）</span>
        <span className="font-bold tabular-nums">{yen(total)}</span>
        <span className="text-xs text-hibi-sub dark:text-gray-400">出面の人工 × 借りる単価（税抜）。届いた請求書とこの額を見比べます</span>
      </summary>
      <div className="mt-2 text-sm">
        {rows.map(r => (
          <div key={r.companyId} className="border-t border-hibi-line dark:border-gray-700 py-2">
            <button type="button" onClick={() => setOpen(open === r.companyId ? null : r.companyId)} className="w-full flex items-center gap-3 text-left">
              <span className="font-bold">{r.companyName}</span>
              <span className="ml-auto tabular-nums font-bold">{yen(r.paymentTotal)}</span>
              <span className="text-xs text-hibi-sub dark:text-gray-400">{open === r.companyId ? '閉じる' : '現場ごと'}</span>
            </button>
            {open === r.companyId && (
              <div className="mt-2 rounded-lg border border-hibi-line dark:border-gray-700 overflow-hidden text-xs">
                <div className="grid grid-cols-[minmax(0,1fr)_64px_72px_110px] gap-2 px-3 py-1.5 bg-hibi-thead dark:bg-gray-700 font-bold text-hibi-sub dark:text-gray-300"><span>現場（工種）</span><span className="text-right">人工</span><span className="text-right">残業(h)</span><span className="text-right">金額</span></div>
                {r.payments.map(l => (
                  <div key={l.siteId} className="grid grid-cols-[minmax(0,1fr)_64px_72px_110px] gap-2 px-3 py-1.5 border-t border-hibi-line dark:border-gray-700 tabular-nums">
                    <span className="truncate">{l.siteName}</span><span className="text-right">{l.days}</span><span className="text-right text-hibi-sub">{l.otHours || '—'}</span><span className="text-right font-bold">{yen(l.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

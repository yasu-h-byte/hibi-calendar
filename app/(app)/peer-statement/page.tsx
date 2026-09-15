'use client'

/**
 * 同業者との請求・支払（2026-09-15）
 *
 * 二次業者同士の人の貸し借りは相殺せず、互いに請求書を送り合う。
 * 月ごと・会社ごとに「請求する側」と「支払う側」を分けて並べ、届いた請求書・送る請求書と突き合わせる。
 * 金額は出面の実績から出した見込み。請求書の作成は次の段階。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import type { PeerStatement } from '@/lib/peer-statement'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}
function shiftYm(ym: string, delta: number): string {
  let y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6)) + delta
  while (m < 1) { m += 12; y-- }
  while (m > 12) { m -= 12; y++ }
  return `${y}${String(m).padStart(2, '0')}`
}

export default function PeerStatementPage() {
  const { ready } = useAuthPassword()
  const [ym, setYm] = useState(currentYm())
  const [rows, setRows] = useState<PeerStatement[] | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!ready) return
    setRows(null); setErr('')
    const res = await fetchWithAuth(`/api/peer-statement?ym=${ym}`)
    if (!res.ok) { setErr('読み込みに失敗しました'); return }
    const data = await res.json()
    setRows(data.statements || [])
  }, [ready, ym])
  useEffect(() => { load() }, [load])

  const billingSum = (rows || []).reduce((s, r) => s + r.billingTotal, 0)
  const paymentSum = (rows || []).reduce((s, r) => s + r.paymentTotal, 0)

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">同業者との請求・支払</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            相殺はしません。応援に行った分は「請求する」、応援をもらった分は「支払う」に分けて出します。金額は出面の実績から出した見込みです。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setYm(shiftYm(ym, -1))} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm">◀</button>
          <span className="text-sm font-bold tabular-nums">{ym.slice(0, 4)}年{parseInt(ym.slice(4, 6))}月</span>
          <button onClick={() => setYm(shiftYm(ym, 1))} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm">▶</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
          <div className="text-xs text-blue-700 dark:text-blue-300">請求する（応援に行った分）</div>
          <div className="text-lg font-bold tabular-nums text-blue-900 dark:text-blue-100">{yen(billingSum)}</div>
        </div>
        <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
          <div className="text-xs text-amber-700 dark:text-amber-300">支払う（応援をもらった分）</div>
          <div className="text-lg font-bold tabular-nums text-amber-900 dark:text-amber-100">{yen(paymentSum)}</div>
        </div>
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {!rows && !err && <p className="text-sm text-gray-400">集計中…</p>}
      {rows && rows.length === 0 && <p className="text-sm text-gray-400">この月の貸し借りはありません。</p>}

      {rows?.map(r => (
        <section key={r.companyId} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4 space-y-3">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-base font-bold">{r.companyName}</h2>
            <div className="text-xs text-gray-500 tabular-nums space-x-3">
              {r.billingTotal > 0 && <span className="text-blue-700 dark:text-blue-300">請求 {yen(r.billingTotal)}</span>}
              {r.paymentTotal > 0 && <span className="text-amber-700 dark:text-amber-300">支払 {yen(r.paymentTotal)}</span>}
            </div>
          </div>

          {r.billing.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-xs font-bold text-blue-700 dark:text-blue-300 mb-1">請求する（{r.companyName} の現場へ応援）</div>
              <table className="w-full text-xs border-collapse">
                <thead><tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  <th className="px-2 py-1.5 text-left">現場（工種）</th>
                  <th className="px-2 py-1.5 text-right">鳶 人工</th><th className="px-2 py-1.5 text-right">鳶 単価</th>
                  <th className="px-2 py-1.5 text-right">土工 人工</th><th className="px-2 py-1.5 text-right">土工 単価</th>
                  <th className="px-2 py-1.5 text-right">金額</th>
                </tr></thead>
                <tbody>
                  {r.billing.map(l => (
                    <tr key={l.siteId} className="border-t border-gray-100 dark:border-gray-700 tabular-nums">
                      <td className="px-2 py-1.5">{l.siteName}</td>
                      <td className="px-2 py-1.5 text-right">{l.tobiDays || '—'}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500">{l.tobiDays ? yen(l.tobiRate) : '—'}</td>
                      <td className="px-2 py-1.5 text-right">{l.dokoDays || '—'}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500">{l.dokoDays ? yen(l.dokoRate) : '—'}</td>
                      <td className="px-2 py-1.5 text-right font-bold">{yen(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.payments.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-xs font-bold text-amber-700 dark:text-amber-300 mb-1">支払う（{r.companyName} から応援をもらった分）</div>
              <table className="w-full text-xs border-collapse">
                <thead><tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  <th className="px-2 py-1.5 text-left">現場（工種）</th>
                  <th className="px-2 py-1.5 text-right">人工</th><th className="px-2 py-1.5 text-right">残業(h)</th>
                  <th className="px-2 py-1.5 text-right">金額</th>
                </tr></thead>
                <tbody>
                  {r.payments.map(l => (
                    <tr key={l.siteId} className="border-t border-gray-100 dark:border-gray-700 tabular-nums">
                      <td className="px-2 py-1.5">{l.siteName}</td>
                      <td className="px-2 py-1.5 text-right">{l.days}</td>
                      <td className="px-2 py-1.5 text-right">{l.otHours || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-bold">{yen(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <p className="text-[11px] text-gray-400 leading-relaxed">
        請求の人工には、その応援現場へ連れて行った外注の人工も含みます。残業は時間を人工に換算して加えています（鳶・外注は8時間、外国人は7時間で1人工）。
        単価は現場マスタの単価タブ（工種ごと）の受取単価、支払は出面の外注原価（借りる単価）です。
      </p>
    </div>
  )
}

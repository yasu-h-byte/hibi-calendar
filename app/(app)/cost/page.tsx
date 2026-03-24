'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYen, fmtYenMan, fmtNum, fmtPct } from '@/lib/format'

interface SiteProfit {
  id: string; name: string
  billing: number; billingByMonth: Record<string, number[]>
  cost: number; subCost: number; totalCost: number
  profit: number; profitRate: number; workDays: number; subWorkDays: number
  tobiEquiv: number; tobiRate: number; tobiBase: number
}

interface SubconSiteBreakdown {
  siteId: string; siteName: string; workDays: number; otCount: number; cost: number
}

interface SubconCostDetail {
  id: string; name: string; type: string; rate: number; otRate: number
  workDays: number; otCount: number; cost: number
  siteBreakdown: SubconSiteBreakdown[]
}

interface CostData {
  sites: SiteProfit[]
  subconDetails: SubconCostDetail[]
  ymRange: string[]
  totals: { billing: number; cost: number; subCost: number; totalCost: number; profit: number; profitRate: number; workDays: number; subWorkDays: number; otHours: number }
}

type PeriodType = 'monthly' | '3months' | '6months' | 'fiscal' | 'yearly'

export default function CostPage() {
  const [password, setPassword] = useState('')
  const [data, setData] = useState<CostData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodType>('monthly')
  const [ym, setYm] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  // Local billing edits: siteId_ym -> number[]
  const [billingEdits, setBillingEdits] = useState<Record<string, number[]>>({})

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch(`/api/cost?ym=${ym}&period=${period}`, { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const d = await res.json()
        setData(d)
        // Initialize billing edits from data
        const edits: Record<string, number[]> = {}
        for (const site of d.sites) {
          for (const [m, arr] of Object.entries(site.billingByMonth as Record<string, number[]>)) {
            edits[`${site.id}_${m}`] = arr.length > 0 ? [...arr] : [0]
          }
        }
        setBillingEdits(edits)
      }
    } finally {
      setLoading(false)
    }
  }, [password, ym, period])

  useEffect(() => { fetchData() }, [fetchData])

  const profitColor = (r: number) => r > 15 ? 'text-green-600' : r > 0 ? 'text-yellow-600' : 'text-red-600'

  const ymOptions: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear(); const m = d.getMonth() + 1
    ymOptions.push({ value: `${y}${String(m).padStart(2, '0')}`, label: `${y}年${m}月` })
  }

  const ymLabel = (m: string) => `${parseInt(m.slice(4))}月`

  // Period navigation (prev/next month)
  const navigateMonth = (direction: -1 | 1) => {
    const y = parseInt(ym.slice(0, 4))
    const m = parseInt(ym.slice(4, 6))
    const d = new Date(y, m - 1 + direction, 1)
    setYm(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const ymDisplayLabel = `${parseInt(ym.slice(0, 4))}年${parseInt(ym.slice(4))}月`

  const isMultiMonth = period !== 'monthly'
  const ymRange = data?.ymRange || [ym]

  // Save billing for a site+month
  const saveBilling = async (siteId: string, month: string, amounts: number[]) => {
    await fetch('/api/cost', {
      method: 'POST',
      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, ym: month, amounts }),
    })
    fetchData()
  }

  // Update a billing row value locally
  const updateBillingRow = (siteId: string, month: string, rowIndex: number, value: number) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr[rowIndex] = value
      return { ...prev, [key]: arr }
    })
  }

  // Add billing row
  const addBillingRow = (siteId: string, month: string) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0]), 0]
      return { ...prev, [key]: arr }
    })
  }

  // Remove billing row
  const removeBillingRow = (siteId: string, month: string, rowIndex: number) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr.splice(rowIndex, 1)
      if (arr.length === 0) arr.push(0)
      return { ...prev, [key]: arr }
    })
  }

  const t = data?.totals
  // Max total cost for bar chart scaling
  const maxCost = data ? Math.max(...data.sites.map(s => s.cost + s.subCost), 1) : 1

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">原価・収益管理</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {([['monthly', '月次'], ['3months', '3ヶ月'], ['6months', '6ヶ月'], ['fiscal', '決算期'], ['yearly', '年間']] as [PeriodType, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setPeriod(key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                  period === key ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={() => navigateMonth(-1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">◀前</button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[80px] text-center">{ymDisplayLabel}</span>
          <button onClick={() => navigateMonth(1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">次▶</button>
          <select value={ym} onChange={e => setYm(e.target.value)} className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
            {ymOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* KPI */}
      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-hibi-navy tabular-nums">{fmtYenMan(t.billing)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">総請求額</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className={`text-2xl font-bold tabular-nums ${profitColor(t.profitRate)}`}>{fmtYenMan(t.profit)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">粗利（{fmtPct(t.profitRate)}）</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-blue-600 tabular-nums">{fmtYenMan(t.cost)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">自社労務費</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-orange-600 tabular-nums">{fmtYenMan(t.subCost)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">外注費</div>
          </div>
        </div>
      )}

      {/* Site profit table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-3 py-3 whitespace-nowrap">現場</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">
                請求額
                {isMultiMonth && <span className="text-xs text-gray-400 ml-1">（合計）</span>}
              </th>
              <th className="px-3 py-3 text-right whitespace-nowrap">社員人件費</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">外注費</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">原価計</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">粗利</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">粗利率</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">鳶換算人工</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">人工あたり売上</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : !data || data.sites.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : (
              <>
                {data.sites.map(s => {
                  const totalWorkers = s.workDays + s.subWorkDays
                  return (
                    <tr key={s.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 align-top">
                      <td className="px-3 py-2.5 font-medium">{s.name}</td>
                      {/* Billing column with multiple rows */}
                      <td className="px-3 py-2 text-right">
                        {isMultiMonth ? (
                          /* Multi-month: show each month inline */
                          <div className="space-y-1">
                            <div className="flex gap-1 justify-end flex-wrap">
                              {ymRange.slice(0, 6).map(m => {
                                const key = `${s.id}_${m}`
                                const rows = billingEdits[key] || [0]
                                return (
                                  <div key={m} className="text-center">
                                    <div className="text-[10px] text-gray-400 mb-0.5">{ymLabel(m)}</div>
                                    {rows.map((val, ri) => (
                                      <div key={ri} className="flex items-center gap-0.5 mb-0.5">
                                        <input
                                          type="number"
                                          defaultValue={val || ''}
                                          placeholder="0"
                                          onBlur={(e) => {
                                            const v = Number(e.target.value) || 0
                                            updateBillingRow(s.id, m, ri, v)
                                            const updated = [...rows]
                                            updated[ri] = v
                                            saveBilling(s.id, m, updated)
                                          }}
                                          className="w-16 text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-1 py-0.5 text-xs tabular-nums focus:ring-1 focus:ring-hibi-navy focus:outline-none"
                                        />
                                        {rows.length > 1 && (
                                          <button onClick={() => { removeBillingRow(s.id, m, ri); const updated = [...rows]; updated.splice(ri, 1); saveBilling(s.id, m, updated.length > 0 ? updated : [0]) }}
                                            className="text-gray-300 hover:text-red-400 text-xs leading-none">×</button>
                                        )}
                                      </div>
                                    ))}
                                    <button onClick={() => addBillingRow(s.id, m)}
                                      className="text-[10px] text-blue-400 hover:text-blue-600">+ 行追加</button>
                                  </div>
                                )
                              })}
                            </div>
                            <div className="text-xs font-bold tabular-nums border-t border-gray-100 pt-1">
                              合計: {fmtYen(s.billing)}
                            </div>
                          </div>
                        ) : (
                          /* Single month: show billing rows with add/remove */
                          <div className="space-y-0.5">
                            {(() => {
                              const key = `${s.id}_${ym}`
                              const rows = billingEdits[key] || [0]
                              return (
                                <>
                                  {rows.map((val, ri) => (
                                    <div key={ri} className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        defaultValue={val || ''}
                                        placeholder="0"
                                        onBlur={(e) => {
                                          const v = Number(e.target.value) || 0
                                          updateBillingRow(s.id, ym, ri, v)
                                          const updated = [...rows]
                                          updated[ri] = v
                                          saveBilling(s.id, ym, updated)
                                        }}
                                        className="w-24 text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm tabular-nums focus:ring-1 focus:ring-hibi-navy focus:outline-none"
                                      />
                                      {rows.length > 1 && (
                                        <button onClick={() => { removeBillingRow(s.id, ym, ri); const updated = [...rows]; updated.splice(ri, 1); saveBilling(s.id, ym, updated.length > 0 ? updated : [0]) }}
                                          className="text-gray-300 hover:text-red-400 text-sm leading-none w-4">×</button>
                                      )}
                                    </div>
                                  ))}
                                  <button onClick={() => addBillingRow(s.id, ym)}
                                    className="text-[11px] text-blue-400 hover:text-blue-600">+ 行追加</button>
                                  {rows.length > 1 && (
                                    <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums border-t border-gray-100 pt-0.5">
                                      計: {fmtYen(rows.reduce((a, b) => a + b, 0))}
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.cost)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.subCost)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.totalCost)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${profitColor(s.profitRate)}`}>{fmtYen(s.profit)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(s.profitRate)}`}>{fmtPct(s.profitRate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {s.tobiEquiv > 0 ? fmtNum(s.tobiEquiv) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {totalWorkers > 0 ? (
                          <span>
                            {fmtYen(Math.round(s.billing / totalWorkers))}
                            {s.tobiBase > 0 && (
                              <span className={`ml-1 text-xs font-medium ${Math.round(s.billing / totalWorkers) >= s.tobiBase ? 'text-blue-600' : 'text-red-600'}`}>
                                {Math.round(s.billing / totalWorkers / s.tobiBase * 100)}%
                              </span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
                {t && (
                  <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold">
                    <td className="px-3 py-2.5">合計</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.billing)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.cost)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.subCost)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.totalCost)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(t.profitRate)}`}>{fmtYen(t.profit)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(t.profitRate)}`}>{fmtPct(t.profitRate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">—</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {(t.workDays + t.subWorkDays) > 0
                        ? fmtYen(Math.round(t.billing / (t.workDays + t.subWorkDays)))
                        : '—'}
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Cost Bar Chart */}
      {data && data.sites.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
          <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-3">現場別原価バーチャート</h2>
          <div className="space-y-2">
            {data.sites
              .filter(s => s.cost > 0 || s.subCost > 0)
              .sort((a, b) => (b.cost + b.subCost) - (a.cost + a.subCost))
              .map(s => {
                const total = s.cost + s.subCost
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="w-24 text-xs text-gray-700 truncate text-right flex-shrink-0">{s.name}</div>
                    <div className="flex-1 flex items-center h-6">
                      <div className="flex h-full rounded-lg overflow-hidden transition-all duration-500 ease-out"
                        style={{ width: `${Math.max((total / maxCost) * 100, 2)}%` }}>
                        {s.cost > 0 && (
                          <div
                            className="bg-blue-500 h-full transition-all duration-500"
                            style={{ width: `${total > 0 ? (s.cost / total) * 100 : 0}%` }}
                            title={`自社: ${fmtYen(s.cost)}`}
                          />
                        )}
                        {s.subCost > 0 && (
                          <div
                            className="bg-orange-400 h-full transition-all duration-500"
                            style={{ width: `${total > 0 ? (s.subCost / total) * 100 : 0}%` }}
                            title={`外注: ${fmtYen(s.subCost)}`}
                          />
                        )}
                      </div>
                    </div>
                    <div className="w-24 text-xs text-gray-600 dark:text-gray-400 tabular-nums text-right flex-shrink-0">{fmtYen(total)}</div>
                  </div>
                )
              })}
          </div>
          <div className="flex gap-4 mt-3 pt-2 border-t border-gray-100">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-blue-500" />
              <span className="text-xs text-gray-600 dark:text-gray-400">自社人件費</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-orange-400" />
              <span className="text-xs text-gray-600 dark:text-gray-400">外注費</span>
            </div>
          </div>
        </div>
      )}

      {/* Subcon cost detail table */}
      {data && data.subconDetails && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
          <div className="px-4 py-3 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
            <h2 className="text-sm font-bold text-hibi-navy dark:text-white">外注先別原価明細</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th className="px-3 py-3">外注先</th>
                <th className="px-3 py-3 text-right">人工単価</th>
                <th className="px-3 py-3 text-right">残業単価</th>
                <th className="px-3 py-3 text-right">人工数</th>
                <th className="px-3 py-3 text-right">残業人数</th>
                <th className="px-3 py-3 text-right">合計金額</th>
              </tr>
            </thead>
            <tbody>
              {data.subconDetails.map(sc => {
                const hasWork = sc.workDays > 0
                return (
                  <tr key={sc.id} className={`border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${!hasWork ? 'opacity-50' : ''}`}>
                    <td className={`px-3 py-2.5 font-medium ${!hasWork ? 'italic text-gray-400' : ''}`}>
                      {sc.name}
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${sc.type === '鳶業者' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{sc.type}</span>
                      {!hasWork && <span className="ml-2 text-xs text-gray-400">稼働なし</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(sc.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{sc.otRate ? fmtYen(sc.otRate) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(sc.workDays)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(sc.otCount)}</td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmtYen(sc.cost)}</td>
                  </tr>
                )
              })}
              {/* Grand total footer */}
              <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold">
                <td className="px-3 py-2.5">合計</td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(data.subconDetails.reduce((s, sc) => s + sc.workDays, 0))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(data.subconDetails.reduce((s, sc) => s + sc.otCount, 0))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {fmtYen(data.subconDetails.reduce((s, sc) => s + sc.cost, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

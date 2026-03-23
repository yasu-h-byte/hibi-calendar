'use client'

import { useEffect, useState, useCallback } from 'react'

interface SiteProfit {
  id: string; name: string
  billing: number; cost: number; subCost: number; totalCost: number
  profit: number; profitRate: number; workDays: number; subWorkDays: number
}

interface CostData {
  sites: SiteProfit[]
  totals: { billing: number; cost: number; subCost: number; totalCost: number; profit: number; profitRate: number; workDays: number; subWorkDays: number; otHours: number }
}

export default function CostPage() {
  const [password, setPassword] = useState('')
  const [data, setData] = useState<CostData | null>(null)
  const [loading, setLoading] = useState(true)
  const [ym, setYm] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch(`/api/cost?ym=${ym}`, { headers: { 'x-admin-password': password } })
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => { fetchData() }, [fetchData])

  const fmtYen = (v: number) => v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toLocaleString()}`
  const fmtRate = (v: number) => `${v.toFixed(1)}%`
  const profitColor = (r: number) => r > 15 ? 'text-green-600' : r > 0 ? 'text-yellow-600' : 'text-red-600'

  // YM options
  const ymOptions: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear(); const m = d.getMonth() + 1
    ymOptions.push({ value: `${y}${String(m).padStart(2, '0')}`, label: `${y}年${m}月` })
  }

  const t = data?.totals

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-hibi-navy">原価・収益管理</h1>
        <select value={ym} onChange={e => setYm(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          {ymOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* KPI */}
      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-2xl font-bold text-hibi-navy">{fmtYen(t.billing)}</div>
            <div className="text-xs text-gray-500">総請求額</div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className={`text-2xl font-bold ${profitColor(t.profitRate)}`}>{fmtYen(t.profit)}</div>
            <div className="text-xs text-gray-500">粗利（{fmtRate(t.profitRate)}）</div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-2xl font-bold text-blue-600">{fmtYen(t.cost)}</div>
            <div className="text-xs text-gray-500">自社労務費</div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 text-center">
            <div className="text-2xl font-bold text-orange-600">{fmtYen(t.subCost)}</div>
            <div className="text-xs text-gray-500">外注費</div>
          </div>
        </div>
      )}

      {/* Site profit table */}
      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-600">
              <th className="px-3 py-3">現場</th>
              <th className="px-3 py-3 text-right">請求額</th>
              <th className="px-3 py-3 text-right">社員人件費</th>
              <th className="px-3 py-3 text-right">外注費</th>
              <th className="px-3 py-3 text-right">原価計</th>
              <th className="px-3 py-3 text-right">粗利</th>
              <th className="px-3 py-3 text-right">粗利率</th>
              <th className="px-3 py-3 text-right">自社人工</th>
              <th className="px-3 py-3 text-right">外注人工</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : !data || data.sites.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : (
              <>
                {data.sites.map(s => (
                  <tr key={s.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2.5 font-medium">{s.name}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(s.billing)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(s.cost)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(s.subCost)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(s.totalCost)}</td>
                    <td className={`px-3 py-2.5 text-right font-bold ${profitColor(s.profitRate)}`}>{fmtYen(s.profit)}</td>
                    <td className={`px-3 py-2.5 text-right ${profitColor(s.profitRate)}`}>{fmtRate(s.profitRate)}</td>
                    <td className="px-3 py-2.5 text-right">{s.workDays}</td>
                    <td className="px-3 py-2.5 text-right">{s.subWorkDays}</td>
                  </tr>
                ))}
                {t && (
                  <tr className="border-t-2 border-hibi-navy bg-gray-50 font-bold">
                    <td className="px-3 py-2.5">合計</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(t.billing)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(t.cost)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(t.subCost)}</td>
                    <td className="px-3 py-2.5 text-right">{fmtYen(t.totalCost)}</td>
                    <td className={`px-3 py-2.5 text-right ${profitColor(t.profitRate)}`}>{fmtYen(t.profit)}</td>
                    <td className={`px-3 py-2.5 text-right ${profitColor(t.profitRate)}`}>{fmtRate(t.profitRate)}</td>
                    <td className="px-3 py-2.5 text-right">{t.workDays}</td>
                    <td className="px-3 py-2.5 text-right">{t.subWorkDays}</td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

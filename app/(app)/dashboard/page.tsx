'use client'

import { useEffect, useState, useCallback } from 'react'

interface KPI {
  totalWorkDays: number
  billing: number
  profit: number
  profitRate: number
  otHours: number
}

interface SiteRow {
  id: string
  name: string
  inHouseWorkDays: number
  subconWorkDays: number
  billing: number
  cost: number
  profit: number
  profitRate: number
}

interface Totals {
  inHouseWorkDays: number
  subconWorkDays: number
  billing: number
  cost: number
  profit: number
  profitRate: number
}

function formatMan(value: number): string {
  return (value / 10000).toFixed(1)
}

function profitRateColor(rate: number): string {
  if (rate > 15) return 'text-green-600'
  if (rate > 0) return 'text-yellow-600'
  return 'text-red-600'
}

function profitRateBg(rate: number): string {
  if (rate > 15) return 'bg-green-50'
  if (rate > 0) return 'bg-yellow-50'
  return 'bg-red-50'
}

function buildYmOptions(count: number = 12): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const ym = `${y}${String(m).padStart(2, '0')}`
    result.push({ ym, label: `${y}年${m}月` })
  }
  return result
}

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

export default function DashboardPage() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(currentYm)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [kpi, setKpi] = useState<KPI | null>(null)
  const [sites, setSites] = useState<SiteRow[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)

  const ymOptions = buildYmOptions()

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw } = JSON.parse(stored)
      setPassword(pw)
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/dashboard?ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        setError('データの取得に失敗しました')
        return
      }
      const data = await res.json()
      setKpi(data.kpi)
      setSites(data.sites)
      setTotals(data.totals)
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const ymLabel = ymOptions.find(o => o.ym === ym)?.label || ym

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">ダッシュボード</h1>
          <p className="text-sm text-gray-500 mt-1">月次実績サマリー</p>
        </div>
        <select
          value={ym}
          onChange={e => setYm(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          {ymOptions.map(o => (
            <option key={o.ym} value={o.ym}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 text-red-600 rounded-lg p-4 text-sm">{error}</div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : kpi && totals ? (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 稼働人工 */}
            <div className="bg-white rounded-xl shadow p-5">
              <div className="text-xs text-gray-500 mb-1">稼働人工</div>
              <div className="text-2xl font-bold text-hibi-navy">
                {kpi.totalWorkDays.toFixed(1)}
              </div>
              <div className="text-xs text-gray-400 mt-1">人工</div>
            </div>

            {/* 売上合計 */}
            <div className="bg-white rounded-xl shadow p-5">
              <div className="text-xs text-gray-500 mb-1">売上合計</div>
              <div className="text-2xl font-bold text-hibi-navy">
                {formatMan(kpi.billing)}
              </div>
              <div className="text-xs text-gray-400 mt-1">万円</div>
            </div>

            {/* 粗利 */}
            <div className="bg-white rounded-xl shadow p-5">
              <div className="text-xs text-gray-500 mb-1">粗利</div>
              <div className={`text-2xl font-bold ${profitRateColor(kpi.profitRate)}`}>
                {formatMan(kpi.profit)}
              </div>
              <div className={`text-xs mt-1 font-semibold ${profitRateColor(kpi.profitRate)}`}>
                {kpi.profitRate.toFixed(1)}%
              </div>
            </div>

            {/* 残業時間 */}
            <div className="bg-white rounded-xl shadow p-5">
              <div className="text-xs text-gray-500 mb-1">残業時間</div>
              <div className="text-2xl font-bold text-hibi-navy">
                {kpi.otHours.toFixed(1)}
              </div>
              <div className="text-xs text-gray-400 mt-1">時間</div>
            </div>
          </div>

          {/* Site Breakdown Table */}
          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-hibi-navy">現場別内訳 - {ymLabel}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="text-left px-4 py-3 font-semibold whitespace-nowrap">現場名</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">自社人工</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">外注人工</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">売上(万)</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">原価(万)</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">粗利(万)</th>
                    <th className="text-right px-4 py-3 font-semibold whitespace-nowrap">粗利率</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.filter(s => s.billing > 0 || s.inHouseWorkDays > 0 || s.subconWorkDays > 0).map(site => (
                    <tr
                      key={site.id}
                      className={`border-b border-gray-50 hover:bg-gray-50 ${profitRateBg(site.profitRate)}`}
                    >
                      <td className="px-4 py-3 font-medium text-hibi-navy whitespace-nowrap">
                        {site.name}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {site.inHouseWorkDays.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {site.subconWorkDays.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMan(site.billing)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMan(site.cost)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${profitRateColor(site.profitRate)}`}>
                        {formatMan(site.profit)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums font-bold ${profitRateColor(site.profitRate)}`}>
                        {site.profitRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Footer totals */}
                <tfoot>
                  <tr className="bg-hibi-navy text-white font-semibold">
                    <td className="px-4 py-3">合計</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.inHouseWorkDays.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.subconWorkDays.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMan(totals.billing)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMan(totals.cost)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMan(totals.profit)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.profitRate.toFixed(1)}%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Empty state for no data */}
          {sites.filter(s => s.billing > 0 || s.inHouseWorkDays > 0 || s.subconWorkDays > 0).length === 0 && (
            <div className="text-center py-8 text-gray-400">
              {ymLabel}のデータがありません
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

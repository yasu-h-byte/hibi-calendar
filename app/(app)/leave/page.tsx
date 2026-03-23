'use client'

import { useEffect, useState, useCallback } from 'react'

interface PLWorker {
  id: number; name: string; org: string; visa: string
  grantDays: number; carryOver: number; adjustment: number; used: number
  total: number; remaining: number; rate: number
}

export default function LeavePage() {
  const [password, setPassword] = useState('')
  const [workers, setWorkers] = useState<PLWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [fy, setFy] = useState(() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    return m >= 10 ? `${y}` : `${y - 1}`
  })

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch(`/api/leave?fy=${fy}`, { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
      }
    } finally {
      setLoading(false)
    }
  }, [password, fy])

  useEffect(() => { fetchData() }, [fetchData])

  const eligible = workers.length
  const totalRemaining = workers.reduce((s, w) => s + w.remaining, 0)
  const totalUsed = workers.reduce((s, w) => s + w.used, 0)
  const alertCount = workers.filter(w => w.remaining <= 3).length

  const fyOptions = []
  for (let y = 2024; y <= 2027; y++) fyOptions.push({ value: `${y}`, label: `${y}年度（${y}/10〜${y + 1}/9）` })

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">有給管理</h1>
          <p className="text-sm text-gray-500 mt-1">有給休暇の付与・消化状況</p>
        </div>
        <select value={fy} onChange={e => setFy(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          {fyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-hibi-navy">{eligible}</div>
          <div className="text-xs text-gray-500">対象人数</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{totalRemaining}</div>
          <div className="text-xs text-gray-500">有給残日数</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{totalUsed}</div>
          <div className="text-xs text-gray-500">消化日数</div>
        </div>
        <div className="bg-white rounded-xl shadow p-4 text-center">
          <div className={`text-2xl font-bold ${alertCount > 0 ? 'text-red-500' : 'text-green-600'}`}>{alertCount}</div>
          <div className="text-xs text-gray-500">残3日以下</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-600">
              <th className="px-3 py-3">名前</th>
              <th className="px-3 py-3">所属</th>
              <th className="px-3 py-3 text-right">付与</th>
              <th className="px-3 py-3 text-right">繰越</th>
              <th className="px-3 py-3 text-right">合計</th>
              <th className="px-3 py-3 text-right">消化</th>
              <th className="px-3 py-3 text-right">残</th>
              <th className="px-3 py-3">消化率</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : workers.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">対象者がいません</td></tr>
            ) : workers.map(w => {
              const rate = w.total > 0 ? (w.used / w.total * 100) : 0
              return (
                <tr key={w.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium">{w.name}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${w.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {w.org === 'hfu' ? 'HFU' : '日比'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">{w.grantDays}</td>
                  <td className="px-3 py-2.5 text-right">{w.carryOver}</td>
                  <td className="px-3 py-2.5 text-right font-medium">{w.total}</td>
                  <td className="px-3 py-2.5 text-right">{w.used}</td>
                  <td className={`px-3 py-2.5 text-right font-bold ${w.remaining <= 3 ? 'text-red-500' : 'text-green-600'}`}>
                    {w.remaining}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${Math.min(100, rate)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500">{rate.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

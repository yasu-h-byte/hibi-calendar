'use client'

import { useEffect, useState, useCallback } from 'react'

interface PLWorker {
  id: number; name: string; org: string; visa: string
  grantDays: number; carryOver: number; adjustment: number; used: number
  total: number; remaining: number; rate: number; grantMonth?: number
}

type OrgFilter = 'all' | 'hibi' | 'hfu'

export default function LeavePage() {
  const [password, setPassword] = useState('')
  const [workers, setWorkers] = useState<PLWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [editWorker, setEditWorker] = useState<PLWorker | null>(null)
  const [editForm, setEditForm] = useState({ grantDays: '', carryOver: '', adjustment: '' })
  const [saving, setSaving] = useState(false)
  const [orgFilter, setOrgFilter] = useState<OrgFilter>('all')
  const [showGrantModal, setShowGrantModal] = useState(false)
  const [grantForm, setGrantForm] = useState({ workerId: '', grantDays: '10', grantMonth: '' })
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

  const filteredWorkers = orgFilter === 'all'
    ? workers
    : workers.filter(w => orgFilter === 'hfu' ? w.org === 'hfu' : w.org !== 'hfu')

  const eligible = filteredWorkers.length
  const totalRemaining = filteredWorkers.reduce((s, w) => s + w.remaining, 0)
  const totalUsed = filteredWorkers.reduce((s, w) => s + w.used, 0)
  const alertCount = filteredWorkers.filter(w => w.remaining <= 3).length

  const handleGrant = async () => {
    if (!grantForm.workerId) { alert('対象者を選択してください'); return }
    setSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grant', workerId: Number(grantForm.workerId), fy, grantDays: grantForm.grantDays, grantMonth: grantForm.grantMonth }),
      })
      setShowGrantModal(false)
      setGrantForm({ workerId: '', grantDays: '10', grantMonth: '' })
      fetchData()
    } finally { setSaving(false) }
  }

  const handleCarryOver = async () => {
    if (!confirm('繰越自動計算を実行しますか？前年度の残日数を繰越に反映します。')) return
    setSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'carryOver', fy }),
      })
      fetchData()
    } finally { setSaving(false) }
  }

  const fyOptions = []
  for (let y = 2024; y <= 2027; y++) fyOptions.push({ value: `${y}`, label: `${y}年度（${y}/10〜${y + 1}/9）` })

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">有給管理</h1>
          <p className="text-sm text-gray-500 mt-1">有給休暇の付与・消化状況</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGrantModal(true)}
            className="bg-green-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-green-700 transition">
            + 有給付与
          </button>
          <button onClick={handleCarryOver} disabled={saving}
            className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm hover:bg-orange-600 transition disabled:opacity-50">
            繰越自動計算
          </button>
          <select value={fy} onChange={e => setFy(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            {fyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Org filter tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {([['all', '全員'], ['hibi', '日比建設'], ['hfu', 'HFU']] as [OrgFilter, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setOrgFilter(key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              orgFilter === key ? 'bg-white text-hibi-navy shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
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
              <th className="px-3 py-3 text-center">発生月</th>
              <th className="px-3 py-3 text-right">付与</th>
              <th className="px-3 py-3 text-right">繰越</th>
              <th className="px-3 py-3 text-right">合計</th>
              <th className="px-3 py-3 text-right">消化</th>
              <th className="px-3 py-3 text-right">残</th>
              <th className="px-3 py-3">消化率</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : filteredWorkers.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">対象者がいません</td></tr>
            ) : filteredWorkers.map(w => {
              const rate = w.total > 0 ? (w.used / w.total * 100) : 0
              return (
                <tr key={w.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium">{w.name}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${w.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {w.org === 'hfu' ? 'HFU' : '日比'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-600 text-xs">
                    {w.grantMonth ? `${w.grantMonth}月` : '—'}
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
                  <td className="px-3 py-2.5">
                    <button onClick={() => { setEditWorker(w); setEditForm({ grantDays: String(w.grantDays), carryOver: String(w.carryOver), adjustment: String(w.adjustment) }) }}
                      className="text-hibi-navy text-xs underline">編集</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Grant Modal */}
      {showGrantModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowGrantModal(false)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">有給付与</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">対象者</label>
                <select value={grantForm.workerId} onChange={e => setGrantForm({ ...grantForm, workerId: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">選択してください</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}（{w.org === 'hfu' ? 'HFU' : '日比'}）</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">付与日数</label>
                <input type="number" value={grantForm.grantDays} onChange={e => setGrantForm({ ...grantForm, grantDays: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">発生月</label>
                <select value={grantForm.grantMonth} onChange={e => setGrantForm({ ...grantForm, grantMonth: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">未設定</option>
                  {[10,11,12,1,2,3,4,5,6,7,8,9].map(m => <option key={m} value={m}>{m}月</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={handleGrant} disabled={saving}
                className="flex-1 bg-green-600 text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
                {saving ? '処理中...' : '付与'}
              </button>
              <button onClick={() => setShowGrantModal(false)}
                className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2.5 text-sm">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditWorker(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">{editWorker.name} - 有給編集</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">付与日数</label>
                <input type="number" value={editForm.grantDays} onChange={e => setEditForm({ ...editForm, grantDays: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">繰越日数</label>
                <input type="number" value={editForm.carryOver} onChange={e => setEditForm({ ...editForm, carryOver: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">調整</label>
                <input type="number" value={editForm.adjustment} onChange={e => setEditForm({ ...editForm, adjustment: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button disabled={saving} onClick={async () => {
                setSaving(true)
                try {
                  await fetch('/api/leave', {
                    method: 'POST',
                    headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workerId: editWorker.id, fy, ...editForm }),
                  })
                  setEditWorker(null)
                  fetchData()
                } finally { setSaving(false) }
              }} className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditWorker(null)} className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2.5 text-sm">キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

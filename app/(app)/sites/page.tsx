'use client'

import { useEffect, useState, useCallback } from 'react'

interface SiteData {
  id: string
  name: string
  start: string
  end: string
  foreman: number
  archived: boolean
}

interface SiteAssign {
  workers: number[]
  subcons: string[]
}

interface WorkerMinimal {
  id: number
  name: string
  jobType: string
  retired: string
}

const EMPTY_FORM = {
  name: '',
  start: '',
  end: '',
  foreman: '0',
  archived: false,
}

export default function SitesPage() {
  const [sites, setSites] = useState<SiteData[]>([])
  const [assign, setAssign] = useState<Record<string, SiteAssign>>({})
  const [workers, setWorkers] = useState<WorkerMinimal[]>([])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw } = JSON.parse(stored)
      setPassword(pw)
    }
  }, [])

  const headers = useCallback(() => ({
    'x-admin-password': password,
    'Content-Type': 'application/json',
  }), [password])

  const fetchSites = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/sites', { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        setSites(data.sites || [])
        setAssign(data.assign || {})
        setWorkers(data.workers || [])
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchSites() }, [fetchSites])

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  const openEdit = (s: SiteData) => {
    setEditId(s.id)
    setForm({
      name: s.name,
      start: s.start,
      end: s.end,
      foreman: String(s.foreman),
      archived: s.archived,
    })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('現場名を入力してください'); return }
    setSaving(true)
    try {
      const body = editId
        ? { action: 'update', id: editId, name: form.name, start: form.start, end: form.end, foreman: form.foreman, archived: form.archived }
        : { action: 'add', name: form.name, start: form.start, end: form.end, foreman: form.foreman }
      await fetch('/api/sites', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
      setShowModal(false)
      fetchSites()
    } finally {
      setSaving(false)
    }
  }

  const getWorkerName = (id: number): string => {
    if (!id) return '—'
    const w = workers.find(x => x.id === id)
    return w ? w.name : `ID:${id}`
  }

  const activeWorkers = workers.filter(w => !w.retired)

  const isActive = (s: SiteData): boolean => {
    if (s.archived) return false
    if (!s.end) return true
    return new Date(s.end) >= new Date(new Date().toISOString().slice(0, 10))
  }

  const filtered = showArchived ? sites : sites.filter(s => !s.archived)

  const sorted = [...filtered].sort((a, b) => {
    // Active sites first, then by start date descending
    const aActive = isActive(a)
    const bActive = isActive(b)
    if (aActive !== bActive) return aActive ? -1 : 1
    return (b.start || '').localeCompare(a.start || '')
  })

  const activeCount = sites.filter(s => isActive(s)).length
  const archivedCount = sites.filter(s => s.archived).length

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">現場マスタ</h1>
          <p className="text-sm text-gray-500 mt-1">
            稼働中: {activeCount}件 / アーカイブ: {archivedCount}件 / 合計: {sites.length}件
          </p>
        </div>
        <button onClick={openAdd} className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition">
          + 新規追加
        </button>
      </div>

      {/* Show archived toggle */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={e => setShowArchived(e.target.checked)}
            className="rounded border-gray-300 text-hibi-navy focus:ring-hibi-navy"
          />
          アーカイブ済みを表示
        </label>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-600">
              <th className="px-3 py-3">現場名</th>
              <th className="px-3 py-3">工期</th>
              <th className="px-3 py-3">職長</th>
              <th className="px-3 py-3 text-center">自社人数</th>
              <th className="px-3 py-3 text-center">外注数</th>
              <th className="px-3 py-3 text-center">状態</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : sorted.map(s => {
              const siteAssign = assign[s.id]
              const workerCount = siteAssign ? siteAssign.workers.length : 0
              const subconCount = siteAssign ? siteAssign.subcons.length : 0
              const active = isActive(s)

              return (
                <tr key={s.id} className={`border-t hover:bg-gray-50 ${s.archived ? 'opacity-45' : ''}`}>
                  <td className="px-3 py-2.5 font-medium">{s.name}</td>
                  <td className="px-3 py-2.5 text-gray-600 text-xs whitespace-nowrap">
                    {s.start && s.end
                      ? `${s.start} ~ ${s.end}`
                      : s.start
                        ? `${s.start} ~`
                        : s.end
                          ? `~ ${s.end}`
                          : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{getWorkerName(s.foreman)}</td>
                  <td className="px-3 py-2.5 text-center text-gray-600">{workerCount}</td>
                  <td className="px-3 py-2.5 text-center text-gray-600">{subconCount}</td>
                  <td className="px-3 py-2.5 text-center">
                    {s.archived ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-500">アーカイブ</span>
                    ) : active ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">稼働中</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">終了</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => openEdit(s)} className="text-hibi-navy text-xs underline hover:text-hibi-light">
                      編集
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">
              {editId ? '現場編集' : '現場追加'}
            </h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">現場名 *</label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="例：〇〇ビル新築工事"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">工期開始</label>
                  <input
                    type="date"
                    value={form.start}
                    onChange={e => setForm({ ...form, start: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">工期終了</label>
                  <input
                    type="date"
                    value={form.end}
                    onChange={e => setForm({ ...form, end: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">職長</label>
                <select
                  value={form.foreman}
                  onChange={e => setForm({ ...form, foreman: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                >
                  <option value="0">未設定</option>
                  {activeWorkers.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>

              {editId && (
                <div className="pt-2">
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.archived}
                      onChange={e => setForm({ ...form, archived: e.target.checked })}
                      className="rounded border-gray-300 text-hibi-navy focus:ring-hibi-navy"
                    />
                    アーカイブ（非表示にする）
                  </label>
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-6">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm hover:bg-hibi-light transition disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setShowModal(false)}
                className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2.5 text-sm hover:bg-gray-300 transition">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

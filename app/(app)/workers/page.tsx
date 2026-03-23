'use client'

import { useEffect, useState, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Worker } from '@/types'

const ORG_LABELS: Record<string, string> = { hibi: '日比建設', hfu: 'HFU' }
const VISA_LABELS: Record<string, string> = { none: '日本人', jisshu: '技能実習', tokutei: '特定技能' }
const JOB_LABELS: Record<string, string> = { yakuin: '役員', shokucho: '職長', tobi: 'とび', doko: '土工' }

interface WorkerExt extends Worker {
  rate?: number
  otMul?: number
  hireDate?: string
  retired?: string
}

const EMPTY_FORM = {
  name: '', org: 'hibi', visa: 'none', job: 'tobi',
  rate: '', otMul: '1.25', hireDate: '', retired: '',
}

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerExt[]>([])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [qrWorker, setQrWorker] = useState<WorkerExt | null>(null)
  const [sortKey, setSortKey] = useState<string>('id')
  const [sortAsc, setSortAsc] = useState(true)

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

  const fetchWorkers = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchWorkers() }, [fetchWorkers])

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  const openEdit = (w: WorkerExt) => {
    setEditId(w.id)
    setForm({
      name: w.name,
      org: w.company === 'HFU' ? 'hfu' : 'hibi',
      visa: w.visaType || 'none',
      job: w.jobType || 'tobi',
      rate: String(w.rate || ''),
      otMul: String(w.otMul || 1.25),
      hireDate: w.hireDate || '',
      retired: w.retired || '',
    })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('名前を入力してください'); return }
    setSaving(true)
    try {
      const body = editId
        ? { action: 'update', id: editId, name: form.name, org: form.org, visa: form.visa, job: form.job, rate: form.rate, otMul: form.otMul, hireDate: form.hireDate, retired: form.retired || undefined }
        : { action: 'add', name: form.name, org: form.org, visa: form.visa, job: form.job, rate: form.rate, otMul: form.otMul, hireDate: form.hireDate }
      await fetch('/api/workers', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
      setShowModal(false)
      fetchWorkers()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`${name} を削除しますか？この操作は取り消せません。`)) return
    await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'delete', id }),
    })
    fetchWorkers()
  }

  const handleGenToken = async (id: number) => {
    const res = await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'generateToken', id }),
    })
    if (res.ok) fetchWorkers()
  }

  const handleRevokeToken = async (id: number, name: string) => {
    if (!confirm(`${name} のトークンを無効化しますか？`)) return
    await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'revokeToken', id }),
    })
    fetchWorkers()
  }

  // Filter & sort
  const filtered = workers.filter(w => {
    if (tab === 'hibi') return w.company !== 'HFU'
    if (tab === 'hfu') return w.company === 'HFU'
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'id') cmp = a.id - b.id
    else if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
    else if (sortKey === 'rate') cmp = (a.rate || 0) - (b.rate || 0)
    return sortAsc ? cmp : -cmp
  })

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(true) }
  }

  const hibiCount = workers.filter(w => w.company !== 'HFU').length
  const hfuCount = workers.filter(w => w.company === 'HFU').length
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">人員マスタ</h1>
          <p className="text-sm text-gray-500 mt-1">
            日比建設: {hibiCount}名 / HFU: {hfuCount}名 / 合計: {workers.length}名
          </p>
        </div>
        <button onClick={openAdd} className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition">
          + 新規追加
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {[
          { key: 'all', label: '全員' },
          { key: 'hibi', label: '日比建設' },
          { key: 'hfu', label: 'HFU' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key ? 'bg-hibi-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-600">
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('id')}>
                ID {sortKey === 'id' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('name')}>
                名前 {sortKey === 'name' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3">所属</th>
              <th className="px-3 py-3">職種</th>
              <th className="px-3 py-3">在留資格</th>
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('rate')}>
                日額 {sortKey === 'rate' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3">📱</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : sorted.map(w => (
              <tr key={w.id} className={`border-t hover:bg-gray-50 ${w.retired ? 'opacity-45' : ''}`}>
                <td className="px-3 py-2.5 text-gray-400">{w.id}</td>
                <td className="px-3 py-2.5 font-medium">
                  {w.name}
                  {w.retired && <span className="ml-2 text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">退職</span>}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    w.company === 'HFU' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {w.company === 'HFU' ? 'HFU' : '日比'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-gray-600">{JOB_LABELS[w.jobType || ''] || w.jobType}</td>
                <td className="px-3 py-2.5">
                  {w.visaType && w.visaType !== 'none' && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      w.visaType === 'jisshu' ? 'bg-orange-100 text-orange-700' : 'bg-teal-100 text-teal-700'
                    }`}>
                      {VISA_LABELS[w.visaType] || w.visaType}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-gray-600">
                  {w.rate ? `¥${w.rate.toLocaleString()}` : '—'}
                </td>
                <td className="px-3 py-2.5">
                  {w.token ? (
                    <div className="flex items-center gap-1">
                      <span className="text-green-500 text-xs">✓</span>
                      <button onClick={() => setQrWorker(w)} className="text-hibi-navy text-xs underline">QR</button>
                    </div>
                  ) : (
                    <button onClick={() => handleGenToken(w.id)} className="text-gray-400 text-xs hover:text-hibi-navy">
                      発行
                    </button>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(w)} className="text-hibi-navy text-xs underline hover:text-hibi-light">
                      編集
                    </button>
                    {!w.retired && (
                      <button onClick={() => handleDelete(w.id, w.name)} className="text-red-400 text-xs hover:text-red-600 ml-2">
                        削除
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">
              {editId ? '社員編集' : '社員追加'}
            </h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">名前 *</label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="例：山田太郎"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">所属</label>
                  <select value={form.org} onChange={e => setForm({ ...form, org: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="hibi">日比建設</option>
                    <option value="hfu">HFU</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">職種</label>
                  <select value={form.job} onChange={e => setForm({ ...form, job: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="tobi">とび</option>
                    <option value="doko">土工</option>
                    <option value="shokucho">職長</option>
                    <option value="yakuin">役員</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">在留資格</label>
                <select value={form.visa} onChange={e => setForm({ ...form, visa: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="none">なし（日本人）</option>
                  <option value="jisshu">技能実習</option>
                  <option value="tokutei">特定技能</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">日額単価（円）</label>
                  <input type="number" value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })}
                    placeholder="25000"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">残業倍率</label>
                  <input type="number" step="0.05" value={form.otMul} onChange={e => setForm({ ...form, otMul: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">入社日</label>
                <input type="date" value={form.hireDate} onChange={e => setForm({ ...form, hireDate: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
              </div>

              {editId && (
                <div>
                  <label className="text-xs text-gray-500 block mb-1">退職日</label>
                  <input type="date" value={form.retired} onChange={e => setForm({ ...form, retired: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
              )}
            </div>

            {/* Token management (edit only) */}
            {editId && (() => {
              const w = workers.find(x => x.id === editId)
              if (!w) return null
              return w.token ? (
                <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                  <div className="text-xs text-gray-500 mb-2">モバイルトークン</div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-white px-2 py-1 rounded border flex-1 truncate">{w.token}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${baseUrl}/attendance/${w.token}`)
                        alert('URLをコピーしました')
                      }}
                      className="text-xs bg-hibi-navy text-white px-3 py-1 rounded"
                    >
                      URL
                    </button>
                    <button onClick={() => handleRevokeToken(w.id, w.name)} className="text-xs text-red-500 hover:text-red-700">
                      無効化
                    </button>
                  </div>
                </div>
              ) : null
            })()}

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

      {/* QR Modal */}
      {qrWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setQrWorker(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-2">{qrWorker.name}</h3>
            <p className="text-xs text-gray-500 mb-4 break-all">{baseUrl}/attendance/{qrWorker.token}</p>
            <div className="flex justify-center mb-4">
              <QRCodeSVG value={`${baseUrl}/attendance/${qrWorker.token}`} size={200} level="M" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${baseUrl}/attendance/${qrWorker.token}`)
                  alert('URLをコピーしました')
                }}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2 text-sm"
              >
                URLコピー
              </button>
              <button onClick={() => setQrWorker(null)} className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2 text-sm">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

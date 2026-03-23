'use client'

import { useEffect, useState, useCallback } from 'react'

interface Subcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
}

interface SiteMinimal {
  id: string; name: string
}

const EMPTY_FORM = { name: '', type: '鳶業者', rate: '', otRate: '', note: '' }

export default function SubconsPage() {
  const [password, setPassword] = useState('')
  const [subcons, setSubcons] = useState<Subcon[]>([])
  const [subconSites, setSubconSites] = useState<Record<string, string[]>>({})
  const [sites, setSites] = useState<SiteMinimal[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  const headers = useCallback(() => ({
    'x-admin-password': password, 'Content-Type': 'application/json',
  }), [password])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/subcons', { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        setSubcons(data.subcons || [])
        setSubconSites(data.subconSites || {})
        setSites(data.sites || [])
      }
    } finally { setLoading(false) }
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  const openAdd = () => {
    if (subcons.length >= 20) { alert('外注先は最大20社までです'); return }
    setEditId(null); setForm(EMPTY_FORM); setShowModal(true)
  }
  const openEdit = (sc: Subcon) => {
    setEditId(sc.id)
    setForm({ name: sc.name, type: sc.type, rate: String(sc.rate || ''), otRate: String(sc.otRate || ''), note: sc.note || '' })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('名前を入力してください'); return }
    setSaving(true)
    try {
      const body = editId
        ? { action: 'update', id: editId, name: form.name, type: form.type, rate: form.rate, otRate: form.otRate, note: form.note }
        : { action: 'add', ...form }
      await fetch('/api/subcons', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
      setShowModal(false); fetchData()
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`${name} を削除しますか？`)) return
    await fetch('/api/subcons', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'delete', id }) })
    fetchData()
  }

  const getSiteName = (siteId: string) => {
    const s = sites.find(x => x.id === siteId)
    return s ? s.name : siteId
  }

  const tobiSubcons = subcons.filter(sc => sc.type === '鳶業者')
  const dokoSubcons = subcons.filter(sc => sc.type === '土工業者')

  const renderSubconRow = (sc: Subcon) => {
    const assignedSites = subconSites[sc.id] || []
    return (
      <tr key={sc.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
        <td className="px-3 py-2.5 font-medium">{sc.name}</td>
        <td className="px-3 py-2.5 text-right">{`¥${(sc.rate || 0).toLocaleString()}`}</td>
        <td className="px-3 py-2.5 text-right">{sc.otRate ? `¥${sc.otRate.toLocaleString()}/h` : '—'}</td>
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap gap-1">
            {assignedSites.length > 0 ? assignedSites.map(siteId => (
              <span key={siteId} className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                {getSiteName(siteId)}
              </span>
            )) : <span className="text-xs text-gray-300">未配置</span>}
          </div>
        </td>
        <td className="px-3 py-2.5 text-gray-500 text-xs">{sc.note}</td>
        <td className="px-3 py-2.5">
          <div className="flex gap-2">
            <button onClick={() => openEdit(sc)} className="text-hibi-navy text-xs underline">編集</button>
            <button onClick={() => handleDelete(sc.id, sc.name)} className="text-red-400 text-xs hover:text-red-600">削除</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">外注先マスタ</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">鳶業者: {tobiSubcons.length}社 / 土工業者: {dokoSubcons.length}社 / 合計: {subcons.length}社</p>
        </div>
        <button onClick={openAdd} className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition">+ 新規追加</button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-3 py-3">外注先名</th>
              <th className="px-3 py-3 text-right">人工単価</th>
              <th className="px-3 py-3 text-right">残業単価</th>
              <th className="px-3 py-3">配置現場</th>
              <th className="px-3 py-3">備考</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : subcons.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">外注先がありません</td></tr>
            ) : (
              <>
                {/* 鳶業者グループ */}
                <tr className="bg-yellow-50 dark:bg-yellow-900/20">
                  <td colSpan={6} className="px-3 py-2 font-bold text-yellow-800 text-sm">
                    {`鳶業者（${tobiSubcons.length}社）`}
                  </td>
                </tr>
                {tobiSubcons.map(renderSubconRow)}

                {/* 土工業者グループ */}
                <tr className="bg-yellow-50 dark:bg-yellow-900/20">
                  <td colSpan={6} className="px-3 py-2 font-bold text-yellow-800 text-sm">
                    {`土工業者（${dokoSubcons.length}社）`}
                  </td>
                </tr>
                {dokoSubcons.map(renderSubconRow)}
              </>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">{editId ? '外注先編集' : '外注先追加'}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">外注先名 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例：村田工業"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">区分</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                  <option value="鳶業者">鳶業者</option>
                  <option value="土工業者">土工業者</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">人工単価（円）</label>
                  <input type="number" value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })} placeholder="25000"
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">残業単価（円）</label>
                  <input type="number" value={form.otRate} onChange={e => setForm({ ...form, otRate: e.target.value })} placeholder="4000"
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">備考</label>
                <input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm hover:bg-hibi-light transition disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setShowModal(false)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm hover:bg-gray-300 transition">キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

import { useEffect, useState, useCallback } from 'react'

interface RatePeriod {
  from: string
  tobiRate: number
  dokoRate: number
}

interface SiteData {
  id: string
  name: string
  start: string
  end: string
  foreman: number
  archived: boolean
  tobiRate: number
  dokoRate: number
  rates: RatePeriod[]
}

interface SiteAssign {
  workers: number[]
  subcons: string[]
  subconRates?: Record<string, { rate: number; otRate: number }>
}

interface WorkerMinimal {
  id: number
  name: string
  jobType: string
  retired: string
}

interface SubconMinimal {
  id: string
  name: string
  type: string
  rate: number
  otRate: number
}

interface MforemanEntry {
  wid: number
}

const EMPTY_FORM = {
  name: '',
  start: '',
  end: '',
  foreman: '0',
  archived: false,
  tobiRate: '',
  dokoRate: '',
}

export default function SitesPage() {
  const [sites, setSites] = useState<SiteData[]>([])
  const [assign, setAssign] = useState<Record<string, SiteAssign>>({})
  const [workers, setWorkers] = useState<WorkerMinimal[]>([])
  const [subcons, setSubcons] = useState<SubconMinimal[]>([])
  const [mforeman, setMforeman] = useState<Record<string, MforemanEntry>>({})
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Modal-only state
  const [formRates, setFormRates] = useState<RatePeriod[]>([])
  const [formSubconRates, setFormSubconRates] = useState<Record<string, { rate: string; otRate: string }>>({})
  const [formDeputies, setFormDeputies] = useState<{ ym: string; wid: string }[]>([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

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
        setSubcons(data.subcons || [])
        setMforeman(data.mforeman || {})
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchSites() }, [fetchSites])

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setFormRates([])
    setFormSubconRates({})
    setFormDeputies([])
    setShowDeleteConfirm(false)
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
      tobiRate: String(s.tobiRate || ''),
      dokoRate: String(s.dokoRate || ''),
    })
    // Load rates
    setFormRates(s.rates && s.rates.length > 0 ? [...s.rates] : [])

    // Load subcon rates for this site
    const siteAssign = assign[s.id]
    const existingScRates = siteAssign?.subconRates || {}
    const scRateForm: Record<string, { rate: string; otRate: string }> = {}
    if (siteAssign?.subcons) {
      for (const scId of siteAssign.subcons) {
        const existing = existingScRates[scId]
        scRateForm[scId] = {
          rate: existing?.rate ? String(existing.rate) : '',
          otRate: existing?.otRate ? String(existing.otRate) : '',
        }
      }
    }
    setFormSubconRates(scRateForm)

    // Load deputy foreman entries for this site
    const deps: { ym: string; wid: string }[] = []
    for (const [key, val] of Object.entries(mforeman)) {
      if (key.startsWith(s.id + '_')) {
        const ym = key.slice(s.id.length + 1) // e.g. "202510"
        const ymFormatted = ym.length === 6 ? `${ym.slice(0, 4)}-${ym.slice(4)}` : ym
        deps.push({ ym: ymFormatted, wid: String(val.wid) })
      }
    }
    deps.sort((a, b) => b.ym.localeCompare(a.ym))
    setFormDeputies(deps)
    setShowDeleteConfirm(false)
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('現場名を入力してください'); return }
    setSaving(true)
    try {
      // Compute latest tobiRate/dokoRate from rates array
      let latestTobiRate = Number(form.tobiRate) || 0
      let latestDokoRate = Number(form.dokoRate) || 0
      if (formRates.length > 0) {
        const sorted = [...formRates].sort((a, b) => b.from.localeCompare(a.from))
        latestTobiRate = sorted[0].tobiRate
        latestDokoRate = sorted[0].dokoRate
      }

      // Build subconRates object (only non-empty values)
      const subconRates: Record<string, { rate: number; otRate: number }> = {}
      for (const [scId, vals] of Object.entries(formSubconRates)) {
        const r = Number(vals.rate) || 0
        const ot = Number(vals.otRate) || 0
        if (r || ot) {
          subconRates[scId] = { rate: r, otRate: ot }
        }
      }

      const body = editId
        ? {
            action: 'update',
            id: editId,
            name: form.name,
            start: form.start,
            end: form.end,
            foreman: form.foreman,
            archived: form.archived,
            tobiRate: latestTobiRate,
            dokoRate: latestDokoRate,
            rates: formRates,
            subconRates,
          }
        : {
            action: 'add',
            name: form.name,
            start: form.start,
            end: form.end,
            foreman: form.foreman,
            tobiRate: latestTobiRate,
            dokoRate: latestDokoRate,
          }
      await fetch('/api/sites', { method: 'POST', headers: headers(), body: JSON.stringify(body) })

      // Save deputy foreman entries
      if (editId) {
        // Determine which mforeman keys existed before
        const existingKeys = new Set<string>()
        for (const key of Object.keys(mforeman)) {
          if (key.startsWith(editId + '_')) {
            existingKeys.add(key)
          }
        }

        // Save new / updated entries
        const newKeys = new Set<string>()
        for (const dep of formDeputies) {
          if (!dep.ym || !dep.wid) continue
          const ymKey = dep.ym.replace('-', '')
          const key = `${editId}_${ymKey}`
          newKeys.add(key)
          // Only call API if changed or new
          const existing = mforeman[key]
          if (!existing || existing.wid !== Number(dep.wid)) {
            await fetch('/api/sites', {
              method: 'POST',
              headers: headers(),
              body: JSON.stringify({ action: 'setDeputy', siteId: editId, ym: ymKey, workerId: dep.wid }),
            })
          }
        }

        // Remove deleted entries
        for (const key of existingKeys) {
          if (!newKeys.has(key)) {
            const ym = key.slice(editId.length + 1)
            await fetch('/api/sites', {
              method: 'POST',
              headers: headers(),
              body: JSON.stringify({ action: 'removeDeputy', siteId: editId, ym }),
            })
          }
        }
      }

      setShowModal(false)
      fetchSites()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editId) return
    setSaving(true)
    try {
      await fetch('/api/sites', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'delete', id: editId }),
      })
      setShowModal(false)
      setShowDeleteConfirm(false)
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
  const foremanWorkers = workers.filter(w => !w.retired && (w.jobType === '職長' || w.jobType === 'とび'))

  const isActive = (s: SiteData): boolean => {
    if (s.archived) return false
    if (!s.end) return true
    return new Date(s.end) >= new Date(new Date().toISOString().slice(0, 10))
  }

  const filtered = showArchived ? sites : sites.filter(s => !s.archived)

  const sorted = [...filtered].sort((a, b) => {
    const aActive = isActive(a)
    const bActive = isActive(b)
    if (aActive !== bActive) return aActive ? -1 : 1
    return (b.start || '').localeCompare(a.start || '')
  })

  const activeCount = sites.filter(s => isActive(s)).length
  const archivedCount = sites.filter(s => s.archived).length

  // Get the latest rate from the rates array
  const getLatestRate = (s: SiteData): { tobiRate: number; dokoRate: number } | null => {
    if (s.rates && s.rates.length > 0) {
      const sorted = [...s.rates].sort((a, b) => b.from.localeCompare(a.from))
      return { tobiRate: sorted[0].tobiRate, dokoRate: sorted[0].dokoRate }
    }
    if (s.tobiRate || s.dokoRate) {
      return { tobiRate: s.tobiRate, dokoRate: s.dokoRate }
    }
    return null
  }

  // Rate period helpers
  const addRatePeriod = () => {
    setFormRates([...formRates, { from: new Date().toISOString().slice(0, 10), tobiRate: 36000, dokoRate: 28000 }])
  }
  const removeRatePeriod = (idx: number) => {
    setFormRates(formRates.filter((_, i) => i !== idx))
  }
  const updateRatePeriod = (idx: number, field: keyof RatePeriod, value: string | number) => {
    const updated = [...formRates]
    if (field === 'from') {
      updated[idx] = { ...updated[idx], from: value as string }
    } else {
      updated[idx] = { ...updated[idx], [field]: Number(value) || 0 }
    }
    setFormRates(updated)
  }

  // Compute latest rate from formRates for display
  const latestFormRate = formRates.length > 0
    ? [...formRates].sort((a, b) => b.from.localeCompare(a.from))[0]
    : null

  // Deputy foreman helpers
  const addDeputy = () => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    setFormDeputies([...formDeputies, { ym, wid: '' }])
  }
  const removeDeputy = (idx: number) => {
    setFormDeputies(formDeputies.filter((_, i) => i !== idx))
  }
  const updateDeputy = (idx: number, field: 'ym' | 'wid', value: string) => {
    const updated = [...formDeputies]
    updated[idx] = { ...updated[idx], [field]: value }
    setFormDeputies(updated)
  }

  // Subcon helpers
  const getAssignedSubcons = (): SubconMinimal[] => {
    if (!editId) return []
    const siteAssign = assign[editId]
    if (!siteAssign?.subcons) return []
    return siteAssign.subcons
      .map(scId => subcons.find(sc => sc.id === scId))
      .filter((sc): sc is SubconMinimal => !!sc)
  }

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
              <th className="px-3 py-3 text-right">鳶単価</th>
              <th className="px-3 py-3 text-right">土工単価</th>
              <th className="px-3 py-3 text-center">自社人数</th>
              <th className="px-3 py-3 text-center">外注数</th>
              <th className="px-3 py-3 text-center">状態</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : sorted.map(s => {
              const siteAssign = assign[s.id]
              const workerCount = siteAssign ? siteAssign.workers.length : 0
              const subconCount = siteAssign ? siteAssign.subcons.length : 0
              const active = isActive(s)
              const rate = getLatestRate(s)

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
                  <td className="px-3 py-2.5 text-right">
                    {rate?.tobiRate ? (
                      <div>
                        <div className="font-medium">{`¥${rate.tobiRate.toLocaleString()}`}</div>
                        <div className="text-xs text-gray-400">{`85%: ¥${Math.round(rate.tobiRate * 0.85).toLocaleString()}`}</div>
                      </div>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {rate?.dokoRate ? (
                      <div>
                        <div className="font-medium">{`¥${rate.dokoRate.toLocaleString()}`}</div>
                        <div className="text-xs text-gray-400">{`85%: ¥${Math.round(rate.dokoRate * 0.85).toLocaleString()}`}</div>
                      </div>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
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
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4">
              {editId ? '現場編集' : '現場追加'}
            </h3>

            <div className="space-y-4">
              {/* Basic info */}
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
                <div className="pt-1">
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

              {/* ── 常用単価（税抜）── */}
              <div className="border-2 border-orange-300 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-bold text-orange-700">常用単価（税抜）</h4>

                {formRates.length === 0 ? (
                  <div className="text-xs text-gray-400">期間単価が設定されていません</div>
                ) : (
                  <div className="space-y-2">
                    {formRates.map((rate, idx) => (
                      <div key={idx} className="bg-orange-50 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 whitespace-nowrap">期間開始</label>
                          <input
                            type="date"
                            value={rate.from}
                            onChange={e => updateRatePeriod(idx, 'from', e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 focus:ring-2 focus:ring-orange-400 focus:outline-none"
                          />
                          <button
                            onClick={() => removeRatePeriod(idx)}
                            className="text-red-400 hover:text-red-600 text-lg px-1"
                            title="削除"
                          >
                            ×
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-xs text-gray-500">鳶単価</label>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => updateRatePeriod(idx, 'tobiRate', rate.tobiRate - 1000)}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                              >
                                -1000
                              </button>
                              <input
                                type="number"
                                value={rate.tobiRate}
                                onChange={e => updateRatePeriod(idx, 'tobiRate', e.target.value)}
                                className="border border-gray-300 rounded px-2 py-1 text-sm w-full text-right focus:ring-2 focus:ring-orange-400 focus:outline-none"
                              />
                              <button
                                onClick={() => updateRatePeriod(idx, 'tobiRate', rate.tobiRate + 1000)}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                              >
                                +1000
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">土工単価</label>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => updateRatePeriod(idx, 'dokoRate', rate.dokoRate - 1000)}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                              >
                                -1000
                              </button>
                              <input
                                type="number"
                                value={rate.dokoRate}
                                onChange={e => updateRatePeriod(idx, 'dokoRate', e.target.value)}
                                className="border border-gray-300 rounded px-2 py-1 text-sm w-full text-right focus:ring-2 focus:ring-orange-400 focus:outline-none"
                              />
                              <button
                                onClick={() => updateRatePeriod(idx, 'dokoRate', rate.dokoRate + 1000)}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                              >
                                +1000
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={addRatePeriod}
                  className="text-orange-600 hover:text-orange-800 text-sm font-medium"
                >
                  + 期間追加
                </button>

                {/* Latest rate summary */}
                {latestFormRate && (
                  <div className="bg-orange-100 rounded-lg px-3 py-2 text-xs text-orange-800">
                    最新85%: 鳶 ¥{Math.round(latestFormRate.tobiRate * 0.85).toLocaleString()} / 土工 ¥{Math.round(latestFormRate.dokoRate * 0.85).toLocaleString()}
                    {latestFormRate.tobiRate > 0 && (
                      <span className="ml-2">
                        換算係数: {(latestFormRate.dokoRate / latestFormRate.tobiRate).toFixed(3)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* ── 外注単価（この現場） ── */}
              {editId && (
                <div className="border-2 border-orange-300 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold text-orange-700">外注単価（この現場）</h4>

                  {(() => {
                    const assignedSc = getAssignedSubcons()
                    if (assignedSc.length === 0) {
                      return <div className="text-xs text-gray-400">この現場に外注先が割り当てられていません</div>
                    }
                    return (
                      <div className="space-y-2">
                        {assignedSc.map(sc => {
                          const scRate = formSubconRates[sc.id] || { rate: '', otRate: '' }
                          return (
                            <div key={sc.id} className="bg-orange-50 rounded-lg p-3">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="font-medium text-sm">{sc.name}</span>
                                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">{sc.type}</span>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-xs text-gray-500">人工単価</label>
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        const cur = Number(scRate.rate) || sc.rate
                                        setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, rate: String(cur - 1000) } })
                                      }}
                                      className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                                    >
                                      -1000
                                    </button>
                                    <input
                                      type="number"
                                      value={scRate.rate}
                                      onChange={e => setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, rate: e.target.value } })}
                                      placeholder={`${sc.rate.toLocaleString()}`}
                                      className="border border-gray-300 rounded px-2 py-1 text-sm w-full text-right focus:ring-2 focus:ring-orange-400 focus:outline-none placeholder:text-gray-300"
                                    />
                                    <button
                                      onClick={() => {
                                        const cur = Number(scRate.rate) || sc.rate
                                        setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, rate: String(cur + 1000) } })
                                      }}
                                      className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                                    >
                                      +1000
                                    </button>
                                  </div>
                                </div>
                                <div>
                                  <label className="text-xs text-gray-500">残業単価</label>
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        const cur = Number(scRate.otRate) || sc.otRate
                                        setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, otRate: String(cur - 500) } })
                                      }}
                                      className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                                    >
                                      -500
                                    </button>
                                    <input
                                      type="number"
                                      value={scRate.otRate}
                                      onChange={e => setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, otRate: e.target.value } })}
                                      placeholder={`${sc.otRate.toLocaleString()}`}
                                      className="border border-gray-300 rounded px-2 py-1 text-sm w-full text-right focus:ring-2 focus:ring-orange-400 focus:outline-none placeholder:text-gray-300"
                                    />
                                    <button
                                      onClick={() => {
                                        const cur = Number(scRate.otRate) || sc.otRate
                                        setFormSubconRates({ ...formSubconRates, [sc.id]: { ...scRate, otRate: String(cur + 500) } })
                                      }}
                                      className="bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-1 text-xs font-bold"
                                    >
                                      +500
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                        <p className="text-xs text-gray-400">空欄 = マスタ単価（placeholder表示）を使用</p>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* ── 代理職長（月単位） ── */}
              {editId && (
                <div className="border border-gray-300 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold text-hibi-navy">代理職長（月単位）</h4>

                  {formDeputies.length === 0 ? (
                    <div className="text-xs text-gray-400">代理職長が設定されていません</div>
                  ) : (
                    <div className="space-y-2">
                      {formDeputies.map((dep, idx) => (
                        <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
                          <input
                            type="month"
                            value={dep.ym}
                            onChange={e => updateDeputy(idx, 'ym', e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                          />
                          <select
                            value={dep.wid}
                            onChange={e => updateDeputy(idx, 'wid', e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                          >
                            <option value="">選択してください</option>
                            {foremanWorkers.map(w => (
                              <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => removeDeputy(idx)}
                            className="text-red-400 hover:text-red-600 text-lg px-1"
                            title="削除"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={addDeputy}
                    className="text-hibi-navy hover:text-hibi-light text-sm font-medium"
                  >
                    + 追加
                  </button>
                </div>
              )}
            </div>

            {/* Buttons */}
            <div className="flex gap-2 mt-6">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm hover:bg-hibi-light transition disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setShowModal(false)}
                className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2.5 text-sm hover:bg-gray-300 transition">
                キャンセル
              </button>
              {editId && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="bg-red-500 text-white rounded-lg px-4 py-2.5 text-sm font-bold hover:bg-red-600 transition"
                >
                  削除
                </button>
              )}
            </div>

            {/* Delete confirmation */}
            {showDeleteConfirm && (
              <div className="mt-4 bg-red-50 border border-red-300 rounded-lg p-4">
                <p className="text-sm text-red-700 font-medium mb-3">
                  「{form.name}」を削除しますか？この操作は取り消せません。
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleDelete}
                    disabled={saving}
                    className="bg-red-600 text-white rounded-lg px-4 py-2 text-sm font-bold hover:bg-red-700 transition disabled:opacity-50"
                  >
                    {saving ? '削除中...' : '削除する'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="bg-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm hover:bg-gray-300 transition"
                  >
                    やめる
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

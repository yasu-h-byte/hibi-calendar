'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth, postJson } from '@/lib/api-client'

interface Subcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
  /** 兼業業者を1社としてまとめるためのグループ名（任意）
   *  例: 「株式会社A（鳶）」「株式会社A（土工）」を companyGroup="株式会社A" でグルーピング */
  companyGroup?: string
}

interface SiteMinimal {
  id: string; name: string
}

const EMPTY_FORM = { name: '', type: '鳶業者', rate: '', otRate: '', note: '', companyGroup: '' }

export default function SubconsPage() {
  const { ready } = useAuthPassword()
  const [subcons, setSubcons] = useState<Subcon[]>([])
  const [subconSites, setSubconSites] = useState<Record<string, string[]>>({})
  const [subconRates, setSubconRates] = useState<Record<string, Record<string, { rate?: number; otRate?: number }>>>({})
  const [sites, setSites] = useState<SiteMinimal[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [siteRateForm, setSiteRateForm] = useState<Record<string, string>>({}) // siteId -> rate string
  const [saving, setSaving] = useState(false)
  // 表示モード: 'flat' = 区分別（鳶/土工）/ 'group' = 会社グループ別（兼業業者を1グループに集約）
  const [viewMode, setViewMode] = useState<'flat' | 'group'>('flat')
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})

  const fetchData = useCallback(async () => {
    if (!ready) return
    setLoading(true)
    try {
      const res = await fetchWithAuth('/api/subcons')
      if (res.ok) {
        const data = await res.json()
        setSubcons(data.subcons || [])
        setSubconSites(data.subconSites || {})
        setSubconRates(data.subconRates || {})
        setSites(data.sites || [])
      }
    } finally { setLoading(false) }
  }, [ready])

  useEffect(() => { fetchData() }, [fetchData])

  const openAdd = () => {
    if (subcons.length >= 20) { alert('外注先は最大20社までです'); return }
    setEditId(null); setForm(EMPTY_FORM); setSiteRateForm({}); setShowModal(true)
  }
  const openEdit = (sc: Subcon) => {
    setEditId(sc.id)
    setForm({ name: sc.name, type: sc.type, rate: String(sc.rate || ''), otRate: String(sc.otRate || ''), note: sc.note || '', companyGroup: sc.companyGroup || '' })
    // 現在の現場別単価を初期値にセット
    const rateMap: Record<string, string> = {}
    const existingRates = subconRates[sc.id] || {}
    for (const [siteId, rateOv] of Object.entries(existingRates)) {
      if (rateOv.rate) rateMap[siteId] = String(rateOv.rate)
    }
    setSiteRateForm(rateMap)
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('名前を入力してください'); return }
    setSaving(true)
    try {
      const body = editId
        ? { action: 'update', id: editId, name: form.name, type: form.type, rate: form.rate, otRate: form.otRate, note: form.note, companyGroup: form.companyGroup }
        : { action: 'add', ...form }
      const res = await postJson('/api/subcons', body)
      if (!res.ok) { alert('保存に失敗しました'); setSaving(false); return }

      // 編集モードで現場別単価が入力されている場合、updateSiteRates を呼ぶ
      if (editId) {
        const siteRatesPayload: Record<string, number | null> = {}
        const assignedSites = subconSites[editId] || []
        for (const siteId of assignedSites) {
          const inputVal = siteRateForm[siteId]
          const numVal = inputVal ? Number(inputVal) : 0
          siteRatesPayload[siteId] = numVal > 0 ? numVal : null
        }
        if (Object.keys(siteRatesPayload).length > 0) {
          await postJson('/api/subcons', {
            action: 'updateSiteRates', subconId: editId, siteRates: siteRatesPayload,
          })
        }
      }

      setShowModal(false); fetchData()
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`${name} を削除しますか？`)) return
    await postJson('/api/subcons', { action: 'delete', id })
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
    const siteRateMap = subconRates[sc.id] || {}
    return (
      <tr key={sc.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
        <td className="px-3 py-2.5 font-medium">{sc.name}</td>
        <td className="px-3 py-2.5 text-right">{`¥${(sc.rate || 0).toLocaleString()}`}</td>
        <td className="px-3 py-2.5 text-right">{sc.otRate ? `¥${sc.otRate.toLocaleString()}/h` : '—'}</td>
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap gap-1">
            {assignedSites.length > 0 ? assignedSites.map(siteId => {
              const override = siteRateMap[siteId]?.rate
              const hasOverride = !!override && override > 0
              return (
                <span
                  key={siteId}
                  className={`text-xs px-1.5 py-0.5 rounded ${hasOverride ? 'bg-orange-100 text-orange-700' : 'bg-indigo-100 text-indigo-700'}`}
                  title={hasOverride ? `現場別単価: ¥${override.toLocaleString()}` : '基本単価'}
                >
                  {getSiteName(siteId)}{hasOverride && ` (¥${override.toLocaleString()})`}
                </span>
              )
            }) : <span className="text-xs text-gray-300">未配置</span>}
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

  // ── 会社グループ表示用の集計 ──
  // companyGroup が同じ業者をまとめる。グループ無しの単独業者は1社扱い。
  const companyGroups = (() => {
    const groups: { key: string; companyGroup: string | null; members: Subcon[] }[] = []
    const idx: Record<string, number> = {}
    for (const sc of subcons) {
      const k = (sc.companyGroup && sc.companyGroup.trim()) || `__solo_${sc.id}`
      if (idx[k] === undefined) {
        idx[k] = groups.length
        groups.push({
          key: k,
          companyGroup: sc.companyGroup && sc.companyGroup.trim() ? sc.companyGroup.trim() : null,
          members: [],
        })
      }
      groups[idx[k]].members.push(sc)
    }
    // ソート: 兼業（members≥2）を先に、その後フラット
    groups.sort((a, b) => {
      if (a.members.length >= 2 && b.members.length < 2) return -1
      if (a.members.length < 2 && b.members.length >= 2) return 1
      return (a.companyGroup || a.members[0].name).localeCompare(b.companyGroup || b.members[0].name, 'ja')
    })
    return groups
  })()
  const multiBizCount = companyGroups.filter(g => g.members.length >= 2).length

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">外注先マスタ</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            鳶業者: {tobiSubcons.length}社 / 土工業者: {dokoSubcons.length}社 / 合計: {subcons.length}社
            {multiBizCount > 0 && ` / 兼業: ${multiBizCount}社`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 表示モード切替 */}
          <div className="inline-flex bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('flat')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                viewMode === 'flat' ? 'bg-white dark:bg-gray-600 text-hibi-navy shadow-sm' : 'text-gray-500'
              }`}
            >
              区分別
            </button>
            <button
              onClick={() => setViewMode('group')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                viewMode === 'group' ? 'bg-white dark:bg-gray-600 text-hibi-navy shadow-sm' : 'text-gray-500'
              }`}
            >
              会社グループ
            </button>
          </div>
          <button onClick={openAdd} className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition">+ 新規追加</button>
        </div>
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
            ) : viewMode === 'flat' ? (
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
            ) : (
              /* 会社グループ表示モード（兼業業者を1グループに集約） */
              <>
                {companyGroups.map(g => {
                  if (g.members.length === 1) {
                    return renderSubconRow(g.members[0])
                  }
                  // 兼業業者: グループヘッダ + メンバー行
                  const expanded = expandedGroups[g.key] !== false  // デフォルト展開
                  return (
                    <RenderGroupedSubcon
                      key={g.key}
                      group={g}
                      expanded={expanded}
                      onToggle={() => setExpandedGroups(prev => ({ ...prev, [g.key]: !expanded }))}
                      renderRow={renderSubconRow}
                    />
                  )
                })}
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

              {/* 会社グループ（兼業業者を1社にまとめるための任意項目） */}
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                <label className="text-xs text-blue-700 dark:text-blue-300 block mb-1 font-medium">
                  会社グループ（兼業業者のみ・任意）
                </label>
                <input value={form.companyGroup} onChange={e => setForm({ ...form, companyGroup: e.target.value })}
                  placeholder="例：株式会社A"
                  list="subcon-company-groups"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 focus:outline-none" />
                <datalist id="subcon-company-groups">
                  {Array.from(new Set(subcons.map(s => s.companyGroup).filter(Boolean) as string[])).map(g => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
                <p className="text-[10px] text-blue-600 dark:text-blue-300/80 mt-1">
                  鳶と土工を両方やる業者の場合、両方のエントリに同じ会社名を入れるとグルーピング表示できます。
                </p>
              </div>

              {/* 現場別単価（編集モード＆配置あり時のみ） */}
              {editId && (subconSites[editId] || []).length > 0 && (
                <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold text-hibi-navy dark:text-blue-300">
                      🏗 現場別単価（任意）
                    </label>
                    <span className="text-[10px] text-gray-400">
                      基本単価: ¥{(Number(form.rate) || 0).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">
                    空欄の場合は基本単価を使用します。残業単価は基本単価×1.25で自動計算。
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {(subconSites[editId] || []).map(siteId => {
                      const siteName = sites.find(s => s.id === siteId)?.name || siteId
                      return (
                        <div key={siteId} className="flex items-center gap-2">
                          <span className="text-xs text-gray-700 dark:text-gray-300 flex-1 truncate" title={siteName}>
                            {siteName}
                          </span>
                          <input
                            type="number"
                            value={siteRateForm[siteId] || ''}
                            onChange={e => setSiteRateForm(prev => ({ ...prev, [siteId]: e.target.value }))}
                            placeholder={`基本: ${(Number(form.rate) || 0).toLocaleString()}`}
                            className="w-28 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm text-right focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                          />
                          <span className="text-xs text-gray-400">円</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
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

// 兼業業者を1グループにまとめて表示するコンポーネント
function RenderGroupedSubcon({
  group,
  expanded,
  onToggle,
  renderRow,
}: {
  group: { key: string; companyGroup: string | null; members: Subcon[] }
  expanded: boolean
  onToggle: () => void
  renderRow: (sc: Subcon) => React.ReactNode
}) {
  return (
    <>
      <tr className="bg-blue-50 dark:bg-blue-900/20 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/30" onClick={onToggle}>
        <td colSpan={6} className="px-3 py-2 font-bold text-blue-800 dark:text-blue-200 text-sm">
          <span className="inline-block w-4">{expanded ? '▼' : '▶'}</span>
          🏢 {group.companyGroup}（兼業 {group.members.length}件）
          <span className="ml-2 text-xs font-normal text-blue-600 dark:text-blue-300">
            {group.members.map(m => m.type).join(' / ')}
          </span>
        </td>
      </tr>
      {expanded && group.members.map(m => renderRow(m))}
    </>
  )
}

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { COMPANY_ROLES, companyRoles, canBorrowFrom, type CompanyRole } from '@/lib/companies'
import { PageHeader, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton } from '@/components/ui/PageParts'

interface PaymentTerms {
  closing: 'end'
  payMonthOffset: 1 | 2
  payDay: number | 'end'
}

interface Subcon {
  id: string; name: string; type: string; rate: number; otRate: number; note: string
  /** 兼業業者を1社としてまとめるためのグループ名（任意）
   *  例: 「株式会社A（鳶）」「株式会社A（土工）」を companyGroup="株式会社A" でグルーピング */
  companyGroup?: string
  /** 役割（元請/一次/同業/外注）。2026-09-15 取引先マスタ化 */
  roles?: string[]
  /** 応援の請求書（2026-09-25）の宛名用。gc/prime/peer のみ編集画面に表示 */
  postal?: string
  address?: string
  honorific?: string
  paymentTerms?: PaymentTerms
}

interface SiteMinimal {
  id: string; name: string
}

const EMPTY_FORM = {
  name: '', type: '鳶業者', rate: '', otRate: '', note: '', companyGroup: '', roles: ['peer'] as string[],
  postal: '', address: '', honorific: '御中', payMonthOffset: '1' as '1' | '2', payDay: 'end' as string,
}

type ScFilter = 'all' | 'norate' | 'unassigned' | 'noaddr'
const SC_FILTER_LABEL: Record<Exclude<ScFilter, 'all'>, string> = { norate: '単価がない会社', unassigned: '配置していない会社', noaddr: '住所がない会社' }
const SC_COLS = 'lg:grid-cols-[minmax(0,1fr)_170px_130px_100px_minmax(0,1.3fr)]'

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
  // 役割で絞り込み（2026-09-15）
  const [roleFilter, setRoleFilter] = useState<'all' | CompanyRole>('all')
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [scFilter, setScFilter] = useState<ScFilter>('all')

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
    if (subcons.length >= 80) { alert('取引先は最大80社までです'); return }
    setEditId(null); setForm(EMPTY_FORM); setSiteRateForm({}); setShowModal(true)
  }
  const openEdit = (sc: Subcon) => {
    setEditId(sc.id)
    setForm({
      name: sc.name, type: sc.type, rate: String(sc.rate || ''), otRate: String(sc.otRate || ''), note: sc.note || '', companyGroup: sc.companyGroup || '', roles: companyRoles(sc),
      postal: sc.postal || '', address: sc.address || '', honorific: sc.honorific || '御中',
      payMonthOffset: (sc.paymentTerms?.payMonthOffset === 2 ? '2' : '1'),
      payDay: sc.paymentTerms?.payDay === undefined ? 'end' : String(sc.paymentTerms.payDay),
    })
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
    if (!form.roles.length) { alert('役割を1つ以上選んでください'); return }
    setSaving(true)
    try {
      // 元請・一次・同業のみ、応援の請求書の宛名用データを一緒に送る
      const isParty = form.roles.includes('gc') || form.roles.includes('prime') || form.roles.includes('peer')
      const partyFields = isParty ? {
        postal: form.postal, address: form.address, honorific: form.honorific || '御中',
        paymentTerms: { closing: 'end' as const, payMonthOffset: Number(form.payMonthOffset) as 1 | 2, payDay: form.payDay === 'end' ? 'end' as const : (Number(form.payDay) || 'end' as const) },
      } : {}
      const body = editId
        ? { action: 'update', id: editId, name: form.name, type: form.type, rate: form.rate, otRate: form.otRate, note: form.note, companyGroup: form.companyGroup, roles: form.roles, ...partyFields }
        : { action: 'add', name: form.name, type: form.type, rate: form.rate, otRate: form.otRate, note: form.note, companyGroup: form.companyGroup, roles: form.roles, ...partyFields }
      const res = await postJson('/api/subcons', body)
      if (!res.ok) {
        alert(res.error || (res.data as { error?: string } | null)?.error || '保存に失敗しました'); setSaving(false); return
      }

      // 編集モードで現場別単価を変えた現場だけ updateSiteRates を送る
      //   2026-10-02 総合点検: 旧は配置現場ぶん全部を毎回送り、サーバが `{ rate }` に置き換えていたので、
      //   保存のたびに現場別の残業単価（otRate）が消えた。変えていない現場は送らない（サーバ側も otRate を残す）
      if (editId) {
        const siteRatesPayload: Record<string, number | null> = {}
        const existingRates = subconRates[editId] || {}
        for (const siteId of subconSites[editId] || []) {
          const inputVal = siteRateForm[siteId]
          const numVal = inputVal ? Number(inputVal) : 0
          const next = numVal > 0 ? numVal : null
          const cur = existingRates[siteId]?.rate || null
          if (next !== cur) siteRatesPayload[siteId] = next
        }
        if (Object.keys(siteRatesPayload).length > 0) {
          const r = await postJson('/api/subcons', {
            action: 'updateSiteRates', subconId: editId, siteRates: siteRatesPayload,
          })
          if (!r.ok) { alert(r.error || (r.data as { error?: string } | null)?.error || '現場別単価の保存に失敗しました'); setSaving(false); return }
        }
      }

      setShowModal(false); fetchData()
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: string, name: string): Promise<boolean> => {
    if (!confirm(`${name} を削除しますか？\n（出面・請負体制・請求書から使われている取引先は削除できません）`)) return false
    // 2026-10-02 総合点検: 旧は応答を見ておらず、拒否されても消えたように見えた
    const r = await postJson('/api/subcons', { action: 'delete', id })
    if (!r.ok) { alert(r.error || (r.data as { error?: string } | null)?.error || '削除できませんでした'); return false }
    fetchData()
    return true
  }

  const getSiteName = (siteId: string) => {
    const s = sites.find(x => x.id === siteId)
    return s ? s.name : siteId
  }

  const renderSubconRow = (sc: Subcon) => {
    const assignedSites = subconSites[sc.id] || []
    const siteRateMap = subconRates[sc.id] || {}
    const borrow = canBorrowFrom(sc)
    return (
      <div key={sc.id} role="button" tabIndex={0}
        onClick={() => openEdit(sc)}
        onKeyDown={e => { if (e.key === 'Enter') openEdit(sc) }}
        className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 ${SC_COLS} gap-x-3 gap-y-1 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums`}>
        <span className="col-span-2 lg:col-span-1 min-w-0">
          <span className="block text-[15px] font-bold text-gray-900 dark:text-gray-100">{sc.name}</span>
          {sc.note && <span className="block text-xs text-hibi-sub dark:text-gray-400 truncate">{sc.note}</span>}
        </span>
        <span className="flex flex-wrap gap-1">
          {companyRoles(sc).map(r => (
            <span key={r} className={`text-xs px-2 py-0.5 rounded-md font-bold ${ROLE_BADGE[r]}`}>
              {COMPANY_ROLES.find(x => x.key === r)?.label}
            </span>
          ))}
        </span>
        <span className={`lg:text-right text-[15px] font-bold ${borrow && !sc.rate ? 'text-red-700 dark:text-red-400' : ''}`}>{borrow ? `¥${(sc.rate || 0).toLocaleString()}` : <span className="text-gray-300 dark:text-gray-600">—</span>}</span>
        <span className="lg:text-right text-[13px] text-hibi-sub dark:text-gray-400">{borrow && sc.otRate ? `¥${sc.otRate.toLocaleString()}/h` : '—'}</span>
        <span className="col-span-2 lg:col-span-1 flex flex-wrap gap-1">
          {assignedSites.length > 0 ? assignedSites.map(siteId => {
            const override = siteRateMap[siteId]?.rate
            const hasOverride = !!override && override > 0
            return (
              <Chip key={siteId} tone={hasOverride ? 'amber' : 'gray'} title={hasOverride ? `この現場の単価: ¥${override.toLocaleString()}` : 'この会社の単価'}>
                {getSiteName(siteId)}{hasOverride && `（¥${override.toLocaleString()}）`}
              </Chip>
            )
          }) : borrow ? <span className="text-xs text-hibi-sub dark:text-gray-400">配置なし</span> : <span className="text-xs text-hibi-sub dark:text-gray-400">現場マスタの請負体制で選ぶ</span>}
        </span>
      </div>
    )
  }

  // 今やること（2026-10-01 改修）
  const noRate = subcons.filter(sc => canBorrowFrom(sc) && !sc.rate)
  const unassigned = subcons.filter(sc => canBorrowFrom(sc) && (subconSites[sc.id] || []).length === 0)
  const noAddress = subcons.filter(sc => companyRoles(sc).includes('peer') && !(sc.address || '').trim())
  const scNames = (arr: Subcon[]) => arr.slice(0, 3).map(sc => sc.name).join('・') + (arr.length > 3 ? ` ほか${arr.length - 3}社` : '')
  const scFilterIds: Record<Exclude<ScFilter, 'all'>, Set<string>> = {
    norate: new Set(noRate.map(sc => sc.id)), unassigned: new Set(unassigned.map(sc => sc.id)), noaddr: new Set(noAddress.map(sc => sc.id)),
  }
  const toggleScFilter = (f: Exclude<ScFilter, 'all'>) => { setRoleFilter('all'); setViewMode('flat'); setScFilter(scFilter === f ? 'all' : f) }
  const q = query.trim().replace(/[\s　]/g, '').toLowerCase()
  const pass = (sc: Subcon) => (scFilter === 'all' || scFilterIds[scFilter].has(sc.id)) && (!q || sc.name.replace(/[\s　]/g, '').toLowerCase().includes(q))

  const filtered = roleFilter === 'all' ? subcons : subcons.filter(sc => companyRoles(sc).includes(roleFilter))
  const tobiSubcons = filtered.filter(sc => canBorrowFrom(sc) && sc.type !== '土工業者').filter(sc => pass(sc))
  const dokoSubcons = filtered.filter(sc => canBorrowFrom(sc) && sc.type === '土工業者').filter(sc => pass(sc))
  // 元請・一次だけの会社（人の貸し借りをしない）
  const partyOnly = filtered.filter(sc => !canBorrowFrom(sc)).filter(sc => pass(sc))

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
  // 会社ごと表示でも、役割の絞り込み（roleFilter）と検索・絞り込み（pass）を会社ひとつずつに効かせる
  //   （グループの誰か1社が当てはまったら全員出す、にしない）
  const filteredIds = new Set(filtered.map(sc => sc.id))
  const shownGroups = companyGroups
    .map(g => ({ ...g, members: g.members.filter(m => filteredIds.has(m.id) && pass(m)) }))
    .filter(g => g.members.length > 0)

  const groupHead = (label: string) => (
    <div className="px-5 py-2 text-xs font-bold text-hibi-sub dark:text-gray-400 bg-gray-50 dark:bg-gray-700/40 border-t border-hibi-line dark:border-gray-700">{label}</div>
  )

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="マスタ・管理"
        title="取引先マスタ"
        sub="元請・一次は現場マスタの請負体制で選びます。人の貸し借りをする同業者と外注業者は、出面の外注として配置できます"
        actions={
          <button onClick={openAdd} className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[15px] font-bold hover:bg-hibi-light inline-flex items-center gap-1.5">
            <span className="text-lg leading-none">＋</span>取引先を追加
          </button>
        }
      />

      {/* ① 今やること */}
      {!loading && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <TodoCard icon="yen" tone={noRate.length > 0 ? 'urgent' : 'ok'} title="単価が入っていない"
            big={noRate.length > 0 ? `${noRate.length}社` : 'ありません'}
            sub={noRate.length > 0 ? `${scNames(noRate)}。人工単価が ¥0 のまま出面に入れると、原価が0円になります` : '人を借りる会社は、全社に単価が入っています'}
            action={noRate.length > 0 ? '見る' : undefined} active={scFilter === 'norate'}
            onClick={noRate.length > 0 ? () => toggleScFilter('norate') : undefined} />
          <TodoCard icon="doc" tone={noAddress.length > 0 ? 'warn' : 'ok'} title="請求書の宛先（住所）がない"
            big={noAddress.length > 0 ? `${noAddress.length}社` : 'ありません'}
            sub={noAddress.length > 0 ? `${scNames(noAddress)}。応援の請求書の宛名に使います` : '同業者は全社、住所が入っています'}
            action={noAddress.length > 0 ? '見る' : undefined} active={scFilter === 'noaddr'}
            onClick={noAddress.length > 0 ? () => toggleScFilter('noaddr') : undefined} />
          <TodoCard icon="site" tone={unassigned.length > 0 ? 'info' : 'ok'} title="どの現場にも配置していない"
            big={unassigned.length > 0 ? `${unassigned.length}社` : 'ありません'}
            sub={unassigned.length > 0 ? `${scNames(unassigned)}。配置は出面入力の「配置」から` : '人を借りる会社は、どこかの現場に配置されています'}
            action={unassigned.length > 0 ? '見る' : undefined} active={scFilter === 'unassigned'}
            onClick={unassigned.length > 0 ? () => toggleScFilter('unassigned') : undefined} />
        </section>
      )}

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
          <h2 className="text-[17px] font-bold text-gray-900 dark:text-white">取引先（{subcons.length}社）</h2>
          <Segment value={roleFilter} onChange={v => { setRoleFilter(v); setScFilter('all') }} items={[
            ['all', `すべて ${subcons.length}`],
            ...COMPANY_ROLES.map(r => [r.key, `${r.label} ${subcons.filter(sc => companyRoles(sc).includes(r.key)).length}`] as const),
          ]} />
          {multiBizCount > 0 && (
            <Segment value={viewMode} onChange={setViewMode} items={[['flat', '区分ごと'], ['group', '会社ごと（兼業をまとめる）']]} />
          )}
          {scFilter !== 'all' && (
            <button onClick={() => setScFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[13px] font-bold">
              {SC_FILTER_LABEL[scFilter]}だけ表示中 ×
            </button>
          )}
          <SearchBox value={query} onChange={setQuery} placeholder="会社名で探す" />
        </div>
        <div className={`hidden lg:grid ${SC_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
          <span>会社</span><span>役割</span><span className="text-right">人工単価（借りる）</span><span className="text-right">残業単価</span><span>配置している現場</span>
        </div>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">読み込み中...</div>
        ) : subcons.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-hibi-sub">取引先がありません</div>
        ) : viewMode === 'flat' ? (
          <>
            {tobiSubcons.length > 0 && <>{groupHead(`鳶業者（${tobiSubcons.length}社）`)}{tobiSubcons.map(renderSubconRow)}</>}
            {dokoSubcons.length > 0 && <>{groupHead(`土工業者（${dokoSubcons.length}社）`)}{dokoSubcons.map(renderSubconRow)}</>}
            {partyOnly.length > 0 && <>{groupHead(`元請・一次（${partyOnly.length}社）`)}{partyOnly.map(renderSubconRow)}</>}
            {tobiSubcons.length + dokoSubcons.length + partyOnly.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub">当てはまる会社はありません</div>
            )}
          </>
        ) : (
          /* 会社グループ表示モード（兼業業者を1グループに集約） */
          <>
            {shownGroups.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub">当てはまる会社はありません</div>
            )}
            {shownGroups.map(g => {
              if (g.members.length === 1) return renderSubconRow(g.members[0])
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
      </section>

      {showModal && (
        <SidePanel label={editId ? `${form.name} の編集` : '取引先を追加'} onClose={() => setShowModal(false)}>
          <div className="flex flex-col min-h-full">
            <div className="px-6 py-5 border-b border-hibi-line dark:border-gray-700 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-[22px] font-bold text-gray-900 dark:text-white">{editId ? (form.name || '（名前なし）') : '取引先を追加'}</h2>
                {editId && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {form.roles.map(r => (
                      <span key={r} className={`text-xs px-2 py-0.5 rounded-md font-bold ${ROLE_BADGE[r as CompanyRole] || ''}`}>{COMPANY_ROLES.find(x => x.key === r)?.label}</span>
                    ))}
                    <span className="text-[13px] text-hibi-sub dark:text-gray-400">{form.type}</span>
                  </div>
                )}
              </div>
              <CloseButton onClick={() => setShowModal(false)} />
            </div>
            <div className="px-6 py-5 flex-1 space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">取引先名 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例：村田工業"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
              </div>
              {/* 役割（2026-09-15）。同じ会社が一次でも同業でもあり得るので複数選べる */}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">役割 *（複数選択可）</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {COMPANY_ROLES.map(r => (
                    <label key={r.key} className="flex items-start gap-1.5 text-sm cursor-pointer">
                      <input type="checkbox" className="mt-1"
                        checked={form.roles.includes(r.key)}
                        onChange={e => setForm({ ...form, roles: e.target.checked ? [...form.roles, r.key] : form.roles.filter(x => x !== r.key) })} />
                      <span>{r.label}<span className="block text-[10px] text-gray-400">{r.hint}</span></span>
                    </label>
                  ))}
                </div>
              </div>
              {/* 応援の請求書（2026-09-25）の宛名用データ。元請・一次・同業のみ */}
              {(form.roles.includes('gc') || form.roles.includes('prime') || form.roles.includes('peer')) && (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3 border border-emerald-200 dark:border-emerald-800 space-y-2">
                  <label className="text-xs text-emerald-700 dark:text-emerald-300 block font-medium">
                    請求書の宛名（応援の請求書用・任意）
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <input value={form.postal} onChange={e => setForm({ ...form, postal: e.target.value })} placeholder="郵便番号 123-4567"
                      className="col-span-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm" />
                    <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="住所"
                      className="col-span-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 items-center">
                    <input value={form.honorific} onChange={e => setForm({ ...form, honorific: e.target.value })} placeholder="敬称（御中）"
                      className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm" />
                    <select value={form.payMonthOffset} onChange={e => setForm({ ...form, payMonthOffset: e.target.value as '1' | '2' })}
                      className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm">
                      <option value="1">翌月払い</option>
                      <option value="2">翌々月払い</option>
                    </select>
                    <select value={form.payDay} onChange={e => setForm({ ...form, payDay: e.target.value })}
                      className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-1.5 text-sm">
                      <option value="end">月末払い</option>
                      {[5, 10, 15, 20, 25].map(d => <option key={d} value={String(d)}>{d}日払い</option>)}
                    </select>
                  </div>
                  <p className="text-[10px] text-emerald-700/80 dark:text-emerald-300/70">
                    月末締め固定。支払日が土日祝なら前営業日に繰り上げて請求書に印字します。
                  </p>
                </div>
              )}
              {(form.roles.includes('peer') || form.roles.includes('subcon')) && (<>
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
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">人工単価（円・応援をもらうとき）</label>
                  <input type="number" value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })} placeholder="25000"
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">残業単価（円）</label>
                  <input type="number" value={form.otRate} onChange={e => setForm({ ...form, otRate: e.target.value })} placeholder="4000"
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
              </div>
              <p className="text-[10px] text-gray-400">応援に行くときの受取単価は、現場マスタの単価タブで現場ごとに入力します。</p>
              </>)}
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
            <div className="sticky bottom-0 mt-auto px-6 py-3.5 border-t border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center gap-2.5">
              {editId && (
                <button type="button" onClick={async () => { const ok = await handleDelete(editId, form.name); if (ok) setShowModal(false) }}
                  className="text-xs text-hibi-sub dark:text-gray-400 hover:text-red-700 underline">取引先を削除する</button>
              )}
              <button onClick={() => setShowModal(false)}
                className="ml-auto h-11 px-5 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-gray-700 dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">閉じる</button>
              <button onClick={handleSave} disabled={saving}
                className="h-11 px-6 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50">
                {saving ? '保存中...' : '保存する'}
              </button>
            </div>
          </div>
        </SidePanel>
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
      <button type="button" onClick={onToggle}
        className="w-full text-left px-5 py-2 border-t border-hibi-line dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40 text-sm font-bold text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700">
        <span className="inline-block w-4 text-hibi-sub">{expanded ? '▾' : '▸'}</span>
        {group.companyGroup}（兼業 {group.members.length}件）
        <span className="ml-2 text-xs font-normal text-hibi-sub dark:text-gray-400">{group.members.map(m => m.type).join(' / ')}</span>
      </button>
      {expanded && group.members.map(m => renderRow(m))}
    </>
  )
}

/** 役割バッジの色（クラス文字列は完全な形で書く：Tailwind の生成対象にするため） */
const ROLE_BADGE: Record<CompanyRole, string> = {
  gc: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  prime: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  peer: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  subcon: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
}

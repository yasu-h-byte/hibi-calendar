'use client'

import { siteLeaderLabel } from '@/lib/companies'
import { useEffect, useState, useCallback } from 'react'
import { can } from '@/lib/permissions'
import { COMPANY_ROLES, SELF_COMPANY_ID, SELF_COMPANY_LABEL, hasRole, resolveSiteParties, type CompanyRole } from '@/lib/companies'
import { fmtYen } from '@/lib/format'
import { todayJstIso, addDaysIso } from '@/lib/date-utils'
import { PageHeader, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton } from '@/components/ui/PageParts'
import { dailyAllowanceYen, DRIVE_ALLOWANCE_YEN, SITE_ALLOWANCE_FROM_YM, judgeFromSamples, COMMUTE_SAMPLE_TARGET } from '@/lib/allowance'

interface RatePeriod {
  from: string
  tobiRate: number
  dokoRate: number
}

interface SiteBreakConfig {
  enabled: boolean
  minutes: number
  mandatory: boolean
}

interface SiteWorkScheduleConfig {
  startTime: string
  endTime: string
  morningBreak: SiteBreakConfig
  lunchBreak: SiteBreakConfig
  afternoonBreak: SiteBreakConfig
}

const DEFAULT_WORK_SCHEDULE: SiteWorkScheduleConfig = {
  startTime: '08:00',
  endTime: '17:00',
  morningBreak:   { enabled: true, minutes: 30, mandatory: false },
  lunchBreak:     { enabled: true, minutes: 60, mandatory: true },
  afternoonBreak: { enabled: true, minutes: 30, mandatory: false },
}

interface CommuteState {
  address: string
  samples: { date: string; am?: number; pm?: number; source: 'manual' | 'auto' }[]
  judgedMin?: number
  frozenAt?: string
}
const EMPTY_COMMUTE: CommuteState = { address: '', samples: [] }

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
  workSchedule?: SiteWorkScheduleConfig | null
  commute?: CommuteState
  noDriveAllowance?: boolean
  /** 就業カレンダーが必要になる月（YYYYMM）。'999912' = スポット */
  calendarFromYm?: string
  siteType?: 'direct' | 'support'
  client?: string
  gcId?: string
  primeId?: string
  ownerId?: string
  /** 工種サイト（2026-09-15）。親現場の id と工種名 */
  parentId?: string
  workType?: string
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
  roles?: string[]
}

interface MforemanEntry {
  wid: number
}

const EMPTY_FORM = {
  name: '',
  siteType: 'direct',
  client: '',
  // 請負体制（2026-09-15）。担当の二次が自社なら自社現場、同業者なら応援現場
  gcId: '',
  primeId: '',
  ownerId: SELF_COMPANY_ID as string,
  workType: '',
  start: '',
  end: '',
  foreman: '0',
  archived: false,
  tobiRate: '',
  dokoRate: '',
}

type SiteFilter = 'all' | 'ending' | 'foreman' | 'rate'
const SITE_FILTER_LABEL: Record<Exclude<SiteFilter, 'all'>, string> = { ending: '工期の終わりが近い現場', foreman: '職長がいない現場', rate: '既定の単価の現場' }
const SITE_COLS = 'lg:grid-cols-[minmax(0,1.6fr)_170px_110px_160px_110px_minmax(0,0.9fr)]'

export default function SitesPage() {
  const [sites, setSites] = useState<SiteData[]>([])
  const [assign, setAssign] = useState<Record<string, SiteAssign>>({})
  const [workers, setWorkers] = useState<WorkerMinimal[]>([])
  const [subcons, setSubcons] = useState<SubconMinimal[]>([])
  const [defaultRates, setDefaultRates] = useState<{ tobiRate: number; dokoRate: number }>({ tobiRate: 38000, dokoRate: 30000 })
  const [mforeman, setMforeman] = useState<Record<string, MforemanEntry>>({})
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState<SiteFilter>('all')
  const [showModal, setShowModal] = useState(false)
  // 編集モーダルのタブ（2026-08-31）。6セクション・入力22個で縦に長すぎたため分割。
  // 人員マスタと同じ考え方（危険な単価まわりを普段の編集から隔離する）。
  const [modalTab, setModalTab] = useState<'basic' | 'schedule' | 'rate' | 'other'>('basic')
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Modal-only state
  const [formRates, setFormRates] = useState<RatePeriod[]>([])
  const [formSubconRates, setFormSubconRates] = useState<Record<string, { rate: string; otRate: string }>>({})
  const [formDeputies, setFormDeputies] = useState<{ ym: string; wid: string }[]>([])
  const [formWorkSchedule, setFormWorkSchedule] = useState<SiteWorkScheduleConfig>(DEFAULT_WORK_SCHEDULE)
  const [formCommute, setFormCommute] = useState<CommuteState>(EMPTY_COMMUTE)
  // 運転手当を出さない現場（代表・事業責任者だけが変更できる・2026-09-30）
  const [formNoDrive, setFormNoDrive] = useState(false)
  // 就業カレンダー（2026-09-30）: normal=工期から必要／spot=スポット（今は作らない）／from=この月から必要（常駐開始）
  const [formCalMode, setFormCalMode] = useState<'normal' | 'spot' | 'from'>('normal')
  const [formCalFrom, setFormCalFrom] = useState('')
  const [canSetNoDrive, setCanSetNoDrive] = useState(false)
  const [canEditMaster, setCanEditMaster] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw, user } = JSON.parse(stored)
      setPassword(pw)
      setCanSetNoDrive(can(user, 'sites.noDriveAllowance'))
      setCanEditMaster(can(user, 'masters.edit'))
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
        if (data.defaultRates) setDefaultRates(data.defaultRates)
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchSites() }, [fetchSites])

  /** 保存用の「カレンダーが必要になる月」（'' = 通常） */
  const calFromForSave = () => formCalMode === 'spot' ? '999912'
    : formCalMode === 'from' && /^\d{4}-\d{2}$/.test(formCalFrom) ? formCalFrom.replace('-', '') : ''

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setFormRates([])
    setFormSubconRates({})
    setFormDeputies([])
    setFormWorkSchedule(DEFAULT_WORK_SCHEDULE)
    setFormCommute(EMPTY_COMMUTE)
    setFormNoDrive(false)
    setFormCalMode('normal'); setFormCalFrom('')
    setShowDeleteConfirm(false)
    setModalTab('basic')
    setShowModal(true)
  }

  const openEdit = (s: SiteData) => {
    setEditId(s.id)
    setForm({
      name: s.name,
      siteType: s.siteType || 'direct',
      client: s.client || '',
      workType: s.workType || '',
      gcId: s.gcId || '',
      primeId: s.primeId || '',
      // 旧データ（請負体制が未入力）は、種別と取引先名から推定して初期値にする
      ownerId: s.ownerId || (s.siteType === 'support'
        ? (subcons.find(c => normCompany(c.name) === normCompany(s.client || ''))?.id || '')
        : SELF_COMPANY_ID),
      start: s.start,
      end: s.end,
      foreman: String(s.foreman),
      archived: s.archived,
      tobiRate: String(s.tobiRate || ''),
      dokoRate: String(s.dokoRate || ''),
    })
    // Load workSchedule (未設定ならデフォルト)
    setFormWorkSchedule(s.workSchedule || DEFAULT_WORK_SCHEDULE)
    setFormCommute(s.commute ? { address: s.commute.address || '', samples: s.commute.samples || [], judgedMin: s.commute.judgedMin, frozenAt: s.commute.frozenAt } : EMPTY_COMMUTE)
    setFormNoDrive(!!s.noDriveAllowance)
    {
      const cf = s.calendarFromYm || ''
      if (!cf) { setFormCalMode('normal'); setFormCalFrom('') }
      else if (cf === '999912') { setFormCalMode('spot'); setFormCalFrom('') }
      else { setFormCalMode('from'); setFormCalFrom(`${cf.slice(0, 4)}-${cf.slice(4, 6)}`) }
    }
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
    setModalTab('basic')
    setShowModal(true)
  }

  // 工種サイト（2026-09-15）
  const editingSite = editId ? sites.find(x => x.id === editId) : undefined
  const isChildEdit = !!editingSite?.parentId
  // 応援現場は取りまとめ役を「責任者」と呼ぶ（2026-09-30 代表）。担当の二次が自社以外なら応援現場
  const formLeader = siteLeaderLabel(form.ownerId ? form.ownerId !== 'self' : editingSite?.siteType === 'support')
  const parentOfEditing = isChildEdit ? sites.find(x => x.id === editingSite!.parentId) : undefined
  const childrenOfEditing = editId && !isChildEdit ? sites.filter(x => x.parentId === editId) : []
  const addWorkType = async () => {
    if (!editId) return
    const wt = window.prompt('追加する工種名（例：鉄骨、仮設）')
    if (!wt || !wt.trim()) return
    const res = await fetch('/api/sites', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'addWorkType', parentId: editId, workType: wt.trim() }) })
    const data = await res.json().catch(() => null)
    if (!res.ok) { alert(data?.error || '追加に失敗しました'); return }
    await fetchSites()
    alert(`工種「${wt.trim()}」を追加しました。単価タブの受取単価は親現場の単価をコピーしてあります。工種の行から開いて単価を直してください。`)
  }

  // 単価タブの表示切替用。請負体制から導いた種別（未入力の旧データは保存済みの種別）
  const derivedSiteType = isChildEdit
    ? (parentOfEditing?.siteType === 'support' ? 'support' : 'direct')
    : form.ownerId
      ? resolveSiteParties({ gcId: form.gcId, primeId: form.primeId, ownerId: form.ownerId }, subcons).siteType
      : (form.siteType === 'support' ? 'support' : 'direct')

  /** 現場の編集画面から、一覧に無い会社をその場で取引先マスタに追加する */
  const addCompanyInline = async () => {
    const name = window.prompt('追加する会社名（例：鹿島建設株式会社）')
    if (!name || !name.trim()) return
    const roleText = window.prompt('役割を番号で入力（複数はカンマ区切り）\n1: 元請　2: 一次　3: 同業（二次）　4: 外注（専門業者）', '3')
    if (!roleText) return
    const map: Record<string, CompanyRole> = { '1': 'gc', '2': 'prime', '3': 'peer', '4': 'subcon' }
    const roles = Array.from(new Set(roleText.split(/[,、\s]+/).map(x => map[x.trim()]).filter(Boolean)))
    if (!roles.length) { alert('役割の番号が読み取れませんでした'); return }
    const res = await fetch('/api/subcons', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'add', name: name.trim(), roles, type: '鳶業者' }) })
    const data = await res.json().catch(() => null)
    if (!res.ok) { alert(data?.error || '追加に失敗しました'); return }
    const added = data?.subcon as SubconMinimal | undefined
    if (added) {
      setSubcons(prev => [...prev, { ...added, roles }])
      alert(`「${added.name}」を取引先マスタに追加しました（${roles.map(r => COMPANY_ROLES.find(x => x.key === r)?.label).join('・')}）`)
    }
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('現場名を入力してください'); return }
    const editingNow = editId ? sites.find(x => x.id === editId) : undefined
    if (!editingNow?.parentId && !form.ownerId) { alert('担当の二次（自社または同業者）を選んでください'); return }
    if (editingNow?.parentId && !form.workType.trim()) { alert('工種名を入力してください'); return }
    // 「この月から作る」で月が空欄のまま保存すると、黙って「通常」になっていた（2026-09-30 点検）
    if (!editingNow?.parentId && formCalMode === 'from' && !/^\d{4}-\d{2}$/.test(formCalFrom)) {
      alert('就業カレンダーを作り始める月を選んでください'); return
    }
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

      // 現場マスタの編集権限が無く「運転手当なし」だけ変えられる人（事業責任者）は、その指定だけを保存する（2026-09-30 点検）
      if (editId && !canEditMaster && canSetNoDrive) {
        const r = await fetch('/api/sites', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'setNoDriveAllowance', id: editId, value: formNoDrive }) })
        if (!r.ok) {
          const err = await r.json().catch(() => null)
          alert(`保存に失敗しました。${err?.error ? `\n${err.error}` : ''}`)
          return
        }
        setShowModal(false)
        fetchSites()
        return
      }

      const body = editId
        ? {
            action: 'update',
            id: editId,
            name: form.name,
            workType: form.workType,
            gcId: form.gcId,
            primeId: form.primeId,
            ownerId: form.ownerId,
            start: form.start,
            end: form.end,
            foreman: form.foreman,
            archived: form.archived,
            tobiRate: latestTobiRate,
            dokoRate: latestDokoRate,
            rates: formRates,
            subconRates,
            workSchedule: formWorkSchedule,
            commute: formCommute,
            noDriveAllowance: formNoDrive,
            calendarFromYm: calFromForSave(),
          }
        : {
            action: 'add',
            name: form.name,
            gcId: form.gcId,
            primeId: form.primeId,
            ownerId: form.ownerId,
            start: form.start,
            end: form.end,
            foreman: form.foreman,
            tobiRate: latestTobiRate,
            dokoRate: latestDokoRate,
            calendarFromYm: calFromForSave(),
          }
      // 2026-09-15: 保存の失敗を画面に出す（以前は応答を見ておらず、失敗しても何も起きないように見えた）
      const saveRes = await fetch('/api/sites', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => null)
        alert(`保存に失敗しました。${err?.error ? `\n${err.error}` : ''}`)
        return
      }

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
      const res = await fetch('/api/sites', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'delete', id: editId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        alert(err?.error || '削除に失敗しました')
        return
      }
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
  const foremanWorkers = workers.filter(w => !w.retired && (w.jobType === '職長' || w.jobType === '役員'))

  const isActive = (s: SiteData): boolean => {
    if (s.archived) return false
    if (!s.end) return true
    return new Date(s.end) >= new Date(todayJstIso())
  }

  const filtered = showArchived ? sites : sites.filter(s => !s.archived)

  const sortedParents = [...filtered].filter(s => !s.parentId || !filtered.some(p => p.id === s.parentId)).sort((a, b) => {
    const aActive = isActive(a)
    const bActive = isActive(b)
    if (aActive !== bActive) return aActive ? -1 : 1
    return (b.start || '').localeCompare(a.start || '')
  })
  // 工種サイトは親現場の直後に並べる（2026-09-15）
  const sorted = sortedParents.flatMap(p => [p, ...filtered.filter(c => c.parentId === p.id)])

  const activeCount = sites.filter(s => isActive(s)).length
  const archivedCount = sites.filter(s => s.archived).length

  // Get the latest rate from the rates array, fallback to default rates
  const getLatestRate = (s: SiteData): { tobiRate: number; dokoRate: number; isDefault: boolean } => {
    if (s.rates && s.rates.length > 0) {
      const sorted = [...s.rates].sort((a, b) => b.from.localeCompare(a.from))
      return { tobiRate: sorted[0].tobiRate, dokoRate: sorted[0].dokoRate, isDefault: false }
    }
    if (s.tobiRate || s.dokoRate) {
      return { tobiRate: s.tobiRate, dokoRate: s.dokoRate, isDefault: false }
    }
    // デフォルト単価にフォールバック
    return { tobiRate: defaultRates.tobiRate || 38000, dokoRate: defaultRates.dokoRate || 30000, isDefault: true }
  }

  // Rate period helpers
  const addRatePeriod = () => {
    setFormRates([...formRates, { from: todayJstIso(), tobiRate: 36000, dokoRate: 28000 }])
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

  // 今やること（2026-10-01 改修）
  const today = todayJstIso()
  const soonLimit = addDaysIso(today, 90)
  const endKey = (e: string) => (e.length === 7 ? `${e}-31` : e)
  const live = sites.filter(s => !s.archived)
  const endingSites = live.filter(s => !s.parentId && s.end && endKey(s.end) <= soonLimit)
  const noForeman = live.filter(s => !s.parentId && isActive(s) && !s.foreman)
  const defaultRateSites = live.filter(s => isActive(s) && s.siteType !== 'support' && getLatestRate(s).isDefault)
  const filterIds: Record<Exclude<SiteFilter, 'all'>, Set<string>> = {
    ending: new Set(endingSites.map(s => s.id)), foreman: new Set(noForeman.map(s => s.id)), rate: new Set(defaultRateSites.map(s => s.id)),
  }
  const toggleFilter = (f: Exclude<SiteFilter, 'all'>) => { setShowArchived(false); setListFilter(listFilter === f ? 'all' : f) }
  const q = query.trim().replace(/[\s　]/g, '').toLowerCase()
  const shownSites = sorted
    .filter(s => (showArchived ? s.archived : !s.archived))
    .filter(s => listFilter === 'all' || filterIds[listFilter].has(s.id))
    .filter(s => !q || `${s.name}${s.workType || ''}`.replace(/[\s　]/g, '').toLowerCase().includes(q))
  const names = (arr: SiteData[]) => arr.slice(0, 2).map(s => s.name.length > 14 ? s.name.slice(0, 14) + '…' : s.name).join('・') + (arr.length > 2 ? ` ほか${arr.length - 2}件` : '')
  const periodText = (s: SiteData) => s.start && s.end ? `${s.start} 〜 ${s.end}` : s.start ? `${s.start} 〜` : s.end ? `〜 ${s.end}` : '—'

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="マスタ・管理"
        title="現場マスタ"
        sub="現場ごとの請負体制・工期・職長・単価。出面・カレンダー・請求・原価のもとになります"
        actions={
          <button onClick={openAdd} className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[15px] font-bold hover:bg-hibi-light inline-flex items-center gap-1.5">
            <span className="text-lg leading-none">＋</span>現場を追加
          </button>
        }
      />

      {/* ① 今やること */}
      {!loading && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <TodoCard icon="clock" tone={endingSites.length > 0 ? 'warn' : 'ok'} title="工期の終わりが近い・過ぎた"
            big={endingSites.length > 0 ? `${endingSites.length}件` : 'ありません'}
            sub={endingSites.length > 0 ? `${names(endingSites)}（90日以内）。終わったら「終了」にすると、出面などの選択欄から消えます` : '90日以内に工期が終わる現場はありません'}
            action={endingSites.length > 0 ? '見る' : undefined} active={listFilter === 'ending'}
            onClick={endingSites.length > 0 ? () => toggleFilter('ending') : undefined} />
          <TodoCard icon="user" tone={noForeman.length > 0 ? 'urgent' : 'ok'} title="職長が決まっていない"
            big={noForeman.length > 0 ? `${noForeman.length}件` : 'ありません'}
            sub={noForeman.length > 0 ? `${names(noForeman)}。職長がいないと、出面の職長承認ができません` : 'どの現場にも職長が登録されています'}
            action={noForeman.length > 0 ? '見る' : undefined} active={listFilter === 'foreman'}
            onClick={noForeman.length > 0 ? () => toggleFilter('foreman') : undefined} />
          <TodoCard icon="yen" tone={defaultRateSites.length > 0 ? 'info' : 'ok'} title="単価が既定値のまま"
            big={defaultRateSites.length > 0 ? `${defaultRateSites.length}件` : 'ありません'}
            sub={defaultRateSites.length > 0 ? `${names(defaultRateSites)}。契約単価が決まったら「単価」に入れてください` : 'どの現場にも単価が入っています'}
            action={defaultRateSites.length > 0 ? '見る' : undefined} active={listFilter === 'rate'}
            onClick={defaultRateSites.length > 0 ? () => toggleFilter('rate') : undefined} />
        </section>
      )}

      {/* ② 一覧 */}
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
          <h2 className="text-[17px] font-bold text-gray-900 dark:text-white">現場</h2>
          <Segment value={showArchived ? 'archived' : 'live'} onChange={v => { setShowArchived(v === 'archived'); setListFilter('all') }} items={[
            ['live', `使っている ${sites.length - archivedCount}`], ['archived', `終了 ${archivedCount}`],
          ]} />
          {listFilter !== 'all' && (
            <button onClick={() => setListFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[13px] font-bold">
              {SITE_FILTER_LABEL[listFilter]}だけ表示中 ×
            </button>
          )}
          <SearchBox value={query} onChange={setQuery} placeholder="現場名で探す" />
        </div>
        <div className={`hidden lg:grid ${SITE_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
          <span>現場</span><span>工期</span><span>職長</span><span className="text-right">単価（鳶／土工）</span><span className="text-right">人数（自社＋外注）</span><span>状態</span>
        </div>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">読み込み中...</div>
        ) : shownSites.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">当てはまる現場はありません</div>
        ) : shownSites.map(s => {
          const siteAssign = assign[s.id]
          const workerCount = siteAssign ? siteAssign.workers.length : 0
          const subconCount = siteAssign ? siteAssign.subcons.length : 0
          const active = isActive(s)
          const rate = getLatestRate(s)
          const nm = (id?: string) => (id ? subcons.find(c => c.id === id)?.name : undefined)
          const chain = [nm(s.gcId), nm(s.primeId), s.ownerId === SELF_COMPANY_ID ? '自社' : nm(s.ownerId)].filter(Boolean)
          const ending = filterIds.ending.has(s.id)
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => openEdit(s)}
              onKeyDown={e => { if (e.key === 'Enter') openEdit(s) }}
              className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 ${SITE_COLS} gap-x-3 gap-y-1 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums ${s.archived ? 'opacity-60' : ''}`}>
              <span className={`col-span-2 lg:col-span-1 min-w-0 ${s.parentId ? 'pl-5' : ''}`}>
                <span className="block text-[15px] font-bold text-gray-900 dark:text-gray-100">
                  {s.parentId ? <span className="text-indigo-700 dark:text-indigo-300">└ 工種: {s.workType}</span> : s.name}
                </span>
                {!s.parentId && (chain.length > 0 || s.client) && (
                  <span className="block text-xs text-hibi-sub dark:text-gray-400 truncate">
                    {chain.length > 0 ? `${chain.join(' → ')}${s.client ? `（請求先: ${s.client}）` : ''}` : s.client}
                  </span>
                )}
              </span>
              <span className={`text-[13px] ${ending ? 'text-amber-700 dark:text-amber-400 font-bold' : ''}`}>{periodText(s)}</span>
              <span className="text-sm">{s.parentId ? <span className="text-hibi-sub">親現場と同じ</span> : s.foreman ? getWorkerName(s.foreman) : <Chip tone="red">まだ</Chip>}</span>
              <span className="lg:text-right text-sm">
                <span className={`font-bold ${rate.isDefault ? 'text-gray-400' : ''}`}>{fmtYen(rate.tobiRate)} ／ {fmtYen(rate.dokoRate)}</span>
                <span className="block text-[11px] text-hibi-sub dark:text-gray-400">{s.siteType === 'support' ? '直接受け取り 100%' : rate.isDefault ? '既定値（85%で計算）' : '85%で計算'}</span>
              </span>
              <span className="lg:text-right text-sm">{workerCount} ＋ {subconCount}</span>
              <span className="flex flex-wrap gap-1">
                {s.archived ? <Chip tone="gray">終了</Chip> : active ? <Chip tone="green">稼働中</Chip> : <Chip tone="amber">工期が過ぎた</Chip>}
                {!s.parentId && s.siteType === 'support' && <Chip tone="gray">応援</Chip>}
                {!s.parentId && s.calendarFromYm && <Chip tone="cyan">{s.calendarFromYm === '999912' ? 'スポット' : `カレンダー ${Number(s.calendarFromYm.slice(4, 6))}月〜`}</Chip>}
                {s.parentId && <Chip tone="gray">工種</Chip>}
                {rate.isDefault && !s.archived && s.siteType !== 'support' && <Chip tone="blue">既定の単価</Chip>}
              </span>
            </div>
          )
        })}
      </section>

      {/* 現場の編集（右から開く・2026-10-01 改修。旧: 中央のモーダル） */}
      {showModal && (
        <SidePanel label={editId ? `${form.name} の編集` : '現場を追加'} onClose={() => setShowModal(false)} width="max-w-[760px]">
          <div className="flex flex-col min-h-full">
            <div className="px-6 py-5 border-b border-hibi-line dark:border-gray-700 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-[22px] font-bold text-gray-900 dark:text-white">{editId ? (form.name || '（名前なし）') : '現場を追加'}</h2>
                {editingSite && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[13px] text-hibi-sub dark:text-gray-400">
                    {form.archived ? <Chip tone="gray">終了（保存すると選択欄から消えます）</Chip> : isActive(editingSite) ? <Chip tone="green">稼働中</Chip> : <Chip tone="amber">工期が過ぎた</Chip>}
                    <span>工期 {periodText(editingSite)}</span>
                    {!editingSite.parentId && <span>／ 職長 {getWorkerName(editingSite.foreman)}</span>}
                  </div>
                )}
              </div>
              {editId && !form.archived && (
                <button type="button" onClick={() => { setForm({ ...form, archived: true }); setModalTab('basic') }}
                  className="h-9 px-3.5 rounded-[9px] border border-red-300 dark:border-red-800 bg-white dark:bg-gray-800 text-red-700 dark:text-red-400 text-[13px] font-bold hover:bg-red-50 dark:hover:bg-red-900/20">終了にする</button>
              )}
              <CloseButton onClick={() => setShowModal(false)} />
            </div>

            {/* タブ（2026-08-31）。保存ボタンはタブの外なので、どのタブで直しても1回で保存できる */}
            <div className="px-6 flex gap-5 border-b border-hibi-line dark:border-gray-700">
              {([
                { key: 'basic', label: '基本' },
                ...(isChildEdit ? [] : [{ key: 'schedule', label: '勤務時間' } as const]),
                { key: 'rate', label: '単価' },
                { key: 'other', label: 'その他' },
              ] as const).map(t => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setModalTab(t.key)}
                  className={`py-2.5 text-sm -mb-px border-b-[3px] transition ${
                    modalTab === t.key
                      ? 'border-hibi-navy text-hibi-navy dark:border-blue-400 dark:text-blue-300 font-bold'
                      : 'border-transparent text-hibi-sub dark:text-gray-400 hover:text-hibi-navy'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="px-6 py-5 flex-1 space-y-4">
              {modalTab === 'basic' && (<div className="space-y-4">
              {/* 工種サイトの編集（2026-09-15） */}
              {isChildEdit && (
                <div className="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 p-3 space-y-2">
                  <div className="text-xs text-indigo-800 dark:text-indigo-200">
                    <b>{parentOfEditing?.name}</b> の工種（出面の入力先）です。就業カレンダー・署名・職長・勤務時間・工期・請負体制は親現場と共通で、親現場の画面で変更します。
                    単価タブで、この工種の受取単価と外注の借りる単価を設定してください。
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">工種名 *</label>
                    <input value={form.workType} onChange={e => setForm({ ...form, workType: e.target.value })} placeholder="鉄骨"
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                  </div>
                </div>
              )}
              {!isChildEdit && (<>
              {/* Basic info */}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">現場名 *</label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="例：〇〇ビル新築工事"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                />
              </div>

              {/* 請負体制（2026-09-15）。元請 → 一次 → 担当の二次。担当が自社かどうかで自社現場／応援現場と請求先が決まる */}
              <div className="rounded-lg border border-gray-200 dark:border-gray-600 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-600 dark:text-gray-300">請負体制</span>
                  <button type="button" onClick={() => addCompanyInline()}
                    className="text-[11px] text-hibi-navy dark:text-blue-300 underline">＋ 一覧に無い会社を追加</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <PartySelect label="元請" value={form.gcId} role="gc" companies={subcons}
                    onChange={v => setForm({ ...form, gcId: v })} />
                  <PartySelect label="一次" value={form.primeId} role="prime" companies={subcons}
                    onChange={v => setForm({ ...form, primeId: v })} />
                  <PartySelect label="担当の二次 *" value={form.ownerId} role="peer" companies={subcons} includeSelf
                    onChange={v => setForm({ ...form, ownerId: v })} />
                </div>
                {(() => {
                  const r = resolveSiteParties({ gcId: form.gcId, primeId: form.primeId, ownerId: form.ownerId }, subcons)
                  if (!form.ownerId) return <p className="text-[11px] text-amber-600">担当の二次を選んでください</p>
                  return (
                    <p className="text-[11px] text-gray-600 dark:text-gray-300">
                      {r.siteType === 'support'
                        ? <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-bold">応援現場</span>
                        : <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-bold">自社現場</span>}
                      <span className="ml-2">請求先: <b>{r.billToName || '（一次を選ぶと決まります）'}</b></span>
                      <span className="ml-2 text-gray-400">{r.siteType === 'support' ? '単価タブの受取単価を100%受け取る' : '常用単価の85%を受け取る'}</span>
                    </p>
                  )
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">工期開始</label>
                  <input
                    type="date"
                    value={form.start}
                    onChange={e => setForm({ ...form, start: e.target.value })}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">工期終了</label>
                  <input
                    type="date"
                    value={form.end}
                    onChange={e => setForm({ ...form, end: e.target.value })}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
              </div>

              {/* ── 就業カレンダー（スポット現場の取っ掛かり・2026-09-30）── */}
              {!isChildEdit && (
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-1.5">
                  <div className="text-xs text-gray-500 dark:text-gray-400">就業カレンダー</div>
                  {([
                    ['normal', '工期の始まりから作る（通常）'],
                    ['spot', 'スポット（数日だけ入る。常駐が決まるまで作らない）'],
                    ['from', 'この月から作る（常駐開始）'],
                  ] as const).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="calMode" checked={formCalMode === v} onChange={() => setFormCalMode(v)} />
                      {label}
                      {v === 'from' && formCalMode === 'from' && (
                        <input type="month" value={formCalFrom} onChange={e => setFormCalFrom(e.target.value)}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-2 py-1 text-sm" />
                      )}
                    </label>
                  ))}
                  <p className="text-[11px] text-gray-400 leading-relaxed">
                    スポット・常駐前の月は、カレンダー画面・翌月カレンダーの注意・通知ベルに出ません（催促しません）。出面はいつもどおり入力できます。
                    常駐が決まったら「この月から作る」にして、カレンダーを作ってください。
                  </p>
                </div>
              )}

              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{formLeader}</label>
                <select
                  value={form.foreman}
                  onChange={e => setForm({ ...form, foreman: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                >
                  <option value="0">未設定</option>
                  {activeWorkers.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>

              {/* 工種（出面の入力先）。単価が工事の種類で変わる現場だけ作る（2026-09-15） */}
              {editId && (
                <div className="rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-gray-600 dark:text-gray-300">工種（出面の入力先）</span>
                    <button type="button" onClick={addWorkType} className="text-[11px] text-hibi-navy dark:text-blue-300 underline">＋ 工種を追加</button>
                  </div>
                  {childrenOfEditing.length === 0 ? (
                    <p className="text-[11px] text-gray-400">
                      工事の種類（鉄骨・仮設など）で単価が変わる現場だけ作ります。作ると出面の現場選択に「{form.name}（鉄骨）」のような入力先が並びます。
                      カレンダー・署名・職長はこの現場と共通です。
                    </p>
                  ) : (
                    <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">工種を選ばない日の呼び方</label>
                      <input value={form.workType} onChange={e => setForm({ ...form, workType: e.target.value })} placeholder="例: 仮設工事"
                        className="flex-1 rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs bg-white dark:bg-gray-700" />
                    </div>
                    <p className="text-[11px] text-gray-400">出面のタグと請求書の行に、この名前で出ます（空なら「親現場」）。</p>
                    <div className="flex flex-wrap gap-1.5">
                      {childrenOfEditing.map(c => (
                        <span key={c.id} className={`text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200 ${c.archived ? 'opacity-50' : ''}`}>
                          {c.workType}{c.archived ? '（アーカイブ）' : ''}
                        </span>
                      ))}
                      <span className="text-[11px] text-gray-400 self-center">単価は一覧の工種の行から開いて設定</span>
                    </div>
                    </div>
                  )}
                </div>
              )}
              </>)}

              {editId && (
                <div className="pt-1">
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.archived}
                      onChange={e => setForm({ ...form, archived: e.target.checked })}
                      className="rounded border-gray-300 text-hibi-navy focus:ring-hibi-navy"
                    />
                    終了にする（出面などの選択欄から消す。データは残ります）
                  </label>
                </div>
              )}

              </div>)}

              {modalTab === 'schedule' && (<div className="space-y-4">
              {/* ── 勤務時間設定 ── */}
              {editId && (
                <div className="border-2 border-blue-300 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold text-blue-700">⏰ 勤務時間設定</h4>
                  <p className="text-xs text-gray-500">
                    現場ごとの始業・終業時刻と休憩構成。スマホ画面のデフォルト値として使われます。
                  </p>

                  {/* 始業・終業 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">始業時刻</label>
                      <input
                        type="time"
                        value={formWorkSchedule.startTime}
                        onChange={e => setFormWorkSchedule({ ...formWorkSchedule, startTime: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">終業時刻</label>
                      <input
                        type="time"
                        value={formWorkSchedule.endTime}
                        onChange={e => setFormWorkSchedule({ ...formWorkSchedule, endTime: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* 休憩構成 */}
                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-medium text-gray-700">休憩構成</div>
                    {([
                      { key: 'morningBreak',   label: '午前休憩' },
                      { key: 'lunchBreak',     label: '昼休憩' },
                      { key: 'afternoonBreak', label: '午後休憩' },
                    ] as const).map(b => {
                      const cfg = formWorkSchedule[b.key]
                      return (
                        <div key={b.key} className="bg-blue-50 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                checked={cfg.enabled}
                                onChange={e => setFormWorkSchedule({
                                  ...formWorkSchedule,
                                  [b.key]: { ...cfg, enabled: e.target.checked },
                                })}
                                className="rounded text-blue-600"
                              />
                              <span className="font-medium">{b.label}を運用する</span>
                            </label>
                          </div>
                          {cfg.enabled && (
                            <div className="grid grid-cols-2 gap-2 ml-6">
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-0.5">時間（分）</label>
                                <input
                                  type="number"
                                  min={0}
                                  step={5}
                                  value={cfg.minutes}
                                  onChange={e => setFormWorkSchedule({
                                    ...formWorkSchedule,
                                    [b.key]: { ...cfg, minutes: Number(e.target.value) || 0 },
                                  })}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                />
                              </div>
                              <div className="flex items-end">
                                <label className="flex items-center gap-2 text-xs cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={cfg.mandatory}
                                    onChange={e => setFormWorkSchedule({
                                      ...formWorkSchedule,
                                      [b.key]: { ...cfg, mandatory: e.target.checked },
                                    })}
                                    className="rounded text-blue-600"
                                  />
                                  必ず取得（変更不可）
                                </label>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* 実働時間プレビュー */}
                  {formWorkSchedule.startTime && formWorkSchedule.endTime && (() => {
                    const [sH, sM] = formWorkSchedule.startTime.split(':').map(Number)
                    const [eH, eM] = formWorkSchedule.endTime.split(':').map(Number)
                    let mins = (eH * 60 + eM) - (sH * 60 + sM)
                    let breakMins = 0
                    if (formWorkSchedule.morningBreak.enabled && formWorkSchedule.morningBreak.mandatory) breakMins += formWorkSchedule.morningBreak.minutes
                    if (formWorkSchedule.lunchBreak.enabled && formWorkSchedule.lunchBreak.mandatory) breakMins += formWorkSchedule.lunchBreak.minutes
                    if (formWorkSchedule.afternoonBreak.enabled && formWorkSchedule.afternoonBreak.mandatory) breakMins += formWorkSchedule.afternoonBreak.minutes
                    mins -= breakMins
                    if (isNaN(mins) || mins < 0) return null
                    const hours = mins / 60
                    return (
                      <div className="text-xs text-gray-600 bg-white rounded p-2 border border-blue-200">
                        💡 必須休憩のみ取得した場合の所定労働時間: <strong>{Math.floor(hours)}時間{Math.round((hours % 1) * 60)}分</strong>
                      </div>
                    )
                  })()}
                </div>
              )}

              </div>)}

              {modalTab === 'rate' && (<div className="space-y-4">
              {/* ── 常用単価（税抜）／ 応援現場は受取単価 ── */}
              <div className="border-2 border-orange-300 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-bold text-orange-700">
                  {derivedSiteType === 'support' ? '受取単価（税抜・直接支払い）' : '常用単価（税抜）'}
                </h4>
                {derivedSiteType === 'support' ? (
                  <div className="text-xs text-purple-700 bg-purple-50 dark:bg-purple-900/20 dark:text-purple-300 rounded-md px-3 py-2">
                    応援現場は元請けを介さず直接の支払いになるため、<strong>実際に受け取る1人工の金額</strong>（例: 28,000円・30,000円）をそのまま入力してください。
                    85%の計算はしません。原価・収益の請求単価基準や概算売上もこの額で計算します。
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">元請け経由の現場。当社の受取は常用単価の85%として計算します。</div>
                )}

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
                    {derivedSiteType === 'support'
                      ? <>最新受取（100%）: 鳶 ¥{latestFormRate.tobiRate.toLocaleString()} / 土工 ¥{latestFormRate.dokoRate.toLocaleString()}</>
                      : <>最新85%: 鳶 ¥{Math.round(latestFormRate.tobiRate * 0.85).toLocaleString()} / 土工 ¥{Math.round(latestFormRate.dokoRate * 0.85).toLocaleString()}</>}
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

              </div>)}

              {modalTab === 'other' && (<div className="space-y-4">
              {/* ── 運転手当の対象（2026-09-30）── */}
              {!isChildEdit && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/10 p-3">
                  <label className={`flex items-start gap-2 text-sm ${canSetNoDrive ? 'cursor-pointer' : 'opacity-70'}`}>
                    <input type="checkbox" className="mt-0.5" checked={formNoDrive} disabled={!canSetNoDrive}
                      onChange={e => setFormNoDrive(e.target.checked)} />
                    <span>
                      <b>この現場は運転手当なし</b>（ごく近い現場など）
                      <span className="block text-[11px] text-gray-500 mt-0.5">
                        チェックすると、出面の「運」ボタンが出なくなり、運転手当（片道 ¥{DRIVE_ALLOWANCE_YEN.toLocaleString()}）が付きません。工種にも同じ設定が効きます。
                        {!canSetNoDrive && ' 変更できるのは代表・事業責任者だけです。'}
                      </span>
                    </span>
                  </label>
                </div>
              )}
              {/* ── 通勤時間（遠方現場日当・運転手当の判定） ── */}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">🚗 通勤時間（手当の判定）</h4>
                  {formCommute.judgedMin !== undefined ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 font-bold">
                      凍結済み {formCommute.judgedMin}分
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-bold">測定中</span>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
                  朝5:30発（清瀬→現場）と夕17:30発（現場→清瀬）の所要時間を最初の10営業日で測り、
                  平均の片道換算を「判定値」として凍結します。判定値から遠方現場日当（80分超500円／120分超1,500円・現在は保留）が決まります。
                  運転手当は判定値とは関係なく片道 ¥{DRIVE_ALLOWANCE_YEN.toLocaleString()}（上の「運転手当なし」の現場を除く）。
                  <br />
                  <b>電車通勤の現場（車で通う人がいない現場）は住所を入力しないでください</b>
                  ——測定対象外のままとなり、日当は発生しません。
                </p>

                {formCommute.judgedMin !== undefined ? (
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-xs space-y-1">
                    <div>判定値 <b className="text-base tabular-nums">{formCommute.judgedMin}分</b>（{formCommute.frozenAt?.slice(0, 10)} 凍結）</div>
                    <div className="text-gray-600 dark:text-gray-300">
                      遠方現場日当: <b>{SITE_ALLOWANCE_FROM_YM === null ? '制度を再検討中のため保留（0円）'
                        : dailyAllowanceYen(formCommute.judgedMin) > 0 ? `¥${dailyAllowanceYen(formCommute.judgedMin).toLocaleString()}/日` : '対象外'}</b>
                    </div>
                    <div className="text-[10px] text-gray-500">
                      ※ 運転手当は全現場一律 ¥{DRIVE_ALLOWANCE_YEN.toLocaleString()}/片道 で、判定値とは関係ありません。
                    </div>
                    <div className="text-[10px] text-gray-400">凍結後は変更できません（非課税の根拠となる客観基準のため）。経路変更等の事由がある場合のみ、記録のうえ再測定してください。</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">現場住所（自動測定の目的地）</label>
                      <input type="text" value={formCommute.address}
                        onChange={e => setFormCommute({ ...formCommute, address: e.target.value })}
                        placeholder="例: 群馬県富岡市…"
                        className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
                    </div>

                    {formCommute.samples.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="text-gray-500">
                            <th className="text-left py-1">測定日</th><th className="text-right">朝(分)</th><th className="text-right">夕(分)</th><th className="text-center">方法</th><th />
                          </tr></thead>
                          <tbody>
                            {formCommute.samples.map((sm, i) => (
                              <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                                <td className="py-1 tabular-nums">{sm.date}</td>
                                <td className="text-right">
                                  <input type="number" value={sm.am ?? ''} min={1}
                                    onChange={e => setFormCommute({ ...formCommute, samples: formCommute.samples.map((x, j) => j === i ? { ...x, am: e.target.value ? Number(e.target.value) : undefined } : x) })}
                                    className="w-16 text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 rounded px-1 py-0.5 tabular-nums" />
                                </td>
                                <td className="text-right">
                                  <input type="number" value={sm.pm ?? ''} min={1}
                                    onChange={e => setFormCommute({ ...formCommute, samples: formCommute.samples.map((x, j) => j === i ? { ...x, pm: e.target.value ? Number(e.target.value) : undefined } : x) })}
                                    className="w-16 text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 rounded px-1 py-0.5 tabular-nums" />
                                </td>
                                <td className="text-center text-gray-400">{sm.source === 'auto' ? '自動' : '手入力'}</td>
                                <td className="text-right">
                                  <button type="button" onClick={() => setFormCommute({ ...formCommute, samples: formCommute.samples.filter((_, j) => j !== i) })}
                                    className="text-gray-300 hover:text-red-400">×</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {(() => {
                      const j = judgeFromSamples(formCommute.samples)
                      return (
                        <div className="flex flex-wrap items-center gap-3">
                          <button type="button"
                            onClick={() => setFormCommute({ ...formCommute, samples: [...formCommute.samples, { date: todayJstIso(), source: 'manual' as const }] })}
                            className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
                            + 今日の測定を追加
                          </button>
                          {j.completeDays > 0 && (
                            <span className="text-[11px] text-gray-500 tabular-nums">
                              朝夕そろった日 {j.completeDays}/{COMMUTE_SAMPLE_TARGET}日
                              {j.judged !== null && <>／ 現時点の平均 <b>{j.judged}分</b></>}
                            </span>
                          )}
                          {j.completeDays >= COMMUTE_SAMPLE_TARGET && j.judged !== null && (
                            <button type="button"
                              onClick={() => {
                                const dailyMsg = SITE_ALLOWANCE_FROM_YM === null
                                  ? '遠方現場日当は制度を再検討中のため現在は支給されません（0円）'
                                  : (dailyAllowanceYen(j.judged!) > 0 ? `日当: ¥${dailyAllowanceYen(j.judged!).toLocaleString()}/日` : '日当: 対象外')
                                if (confirm(`判定値を ${j.judged}分 で凍結します。\n\n${dailyMsg}\n\n※ 運転手当は全現場一律 ¥${DRIVE_ALLOWANCE_YEN.toLocaleString()}/片道で、判定値とは関係ありません。\n\n凍結後は変更できません。よろしいですか？`)) {
                                  setFormCommute({ ...formCommute, judgedMin: j.judged!, frozenAt: new Date().toISOString() })
                                }
                              }}
                              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-bold hover:opacity-90">
                              判定値 {j.judged}分 で凍結する
                            </button>
                          )}
                        </div>
                      )
                    })()}
                    {formCommute.samples.length > 0 && (
                      <p className="text-[10px] text-gray-400">朝・夕の欄に Google マップの実測分数を入れてください（保存ボタンで保存されます）。自動測定を有効にすると毎営業日この表に追記されます。</p>
                    )}
                  </div>
                )}
              </div>

              {/* ── 代理職長（月単位） ── 工種サイトは親現場と共通なので出さない */}
              {editId && !isChildEdit && (
                <div className="border border-gray-300 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold text-hibi-navy">代理{formLeader}（月単位）</h4>

                  {formDeputies.length === 0 ? (
                    <div className="text-xs text-gray-400">代理{formLeader}が設定されていません</div>
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
              </div>)}
            </div>

            {/* Delete confirmation */}
            {showDeleteConfirm && (
              <div className="mx-6 mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
                <p className="text-sm text-red-800 dark:text-red-200 font-bold mb-3">
                  「{form.name}」を削除しますか？この操作は取り消せません。終わった現場は「終了にする」で残しておけます。
                </p>
                <div className="flex gap-2">
                  <button onClick={handleDelete} disabled={saving}
                    className="h-10 px-4 rounded-[10px] bg-red-700 text-white text-sm font-bold hover:bg-red-800 disabled:opacity-50">
                    {saving ? '削除中...' : '削除する'}
                  </button>
                  <button onClick={() => setShowDeleteConfirm(false)}
                    className="h-10 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold">
                    やめる
                  </button>
                </div>
              </div>
            )}

            <div className="sticky bottom-0 px-6 py-3.5 border-t border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center gap-2.5">
              {editId && (
                <button type="button" onClick={() => setShowDeleteConfirm(true)}
                  className="text-xs text-hibi-sub dark:text-gray-400 hover:text-red-700 underline">現場を削除する</button>
              )}
              <button onClick={() => setShowModal(false)}
                className="ml-auto h-11 px-5 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-gray-700 dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                閉じる
              </button>
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

/** 会社名の表記ゆれを吸収して比較する（株式会社・（株）・空白の違い） */
function normCompany(name: string): string {
  return String(name).replace(/[\s　]|株式会社|（株）|\(株\)|有限会社|（有）/g, '')
}

/** 請負体制のプルダウン（役割で候補を絞る。選択中の会社は役割が外れていても表示を残す） */
function PartySelect({ label, value, role, companies, includeSelf, onChange }: {
  label: string
  value: string
  role: CompanyRole
  companies: { id: string; name: string; roles?: string[] }[]
  includeSelf?: boolean
  onChange: (v: string) => void
}) {
  const options = companies.filter(c => hasRole(c, role) || c.id === value)
  return (
    <div>
      <label className="text-[11px] text-gray-500 dark:text-gray-400 block mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none">
        <option value="">{includeSelf ? '選択してください' : '未設定'}</option>
        {includeSelf && <option value={SELF_COMPANY_ID}>{SELF_COMPANY_LABEL}</option>}
        {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  )
}

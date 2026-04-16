'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { fmtYen, fmtNum, fmtPct } from '@/lib/format'
import { getYmOptions as getYmOptionsFromLib } from '@/lib/compute'

// ────────────────────────────────────────
//  Types
// ────────────────────────────────────────

interface WorkerMonthly {
  id: number
  name: string
  org: string
  visa: string
  job: string
  rate: number
  hourlyRate?: number
  otMul: number
  salary?: number
  sites: string[]
  workDays: number
  actualWorkDays: number
  compDays: number
  workAll: number
  halfDays?: number
  otHours: number
  plDays: number
  plUsed: number
  restDays: number
  siteOffDays: number
  cost: number
  otCost: number
  totalCost: number
  absence: number
  absentCost: number
  netPay: number
  // Salary calc fields (variable working hours system)
  prescribedHours?: number
  actualWorkHours?: number
  legalOtHours?: number
  dailyOtHours?: number
  basePay?: number
  otAllowance?: number
  absentDeduction?: number
  salaryNetPay?: number
  // 3層構造 fields
  fixedBasePay?: number
  additionalAllowance?: number
  legalLimit?: number
  // 出向情報
  isDispatched?: boolean
  dispatchTo?: string
  dispatchDeduction?: number
}

interface SubconMonthly {
  id: string
  name: string
  type: string
  rate: number
  otRate: number
  sites: string[]
  workDays: number
  otCount: number
  cost: number
}

// ────────────────────────────────────────
//  Export Types & Cards
// ────────────────────────────────────────

type ExportType = 'hibi' | 'hfu' | 'perSite' | 'subcon' | 'bukake' | 'monthly' | 'pl'

interface ExportCard {
  icon: string
  title: string
  description: string
  format: 'Excel出力' | 'PDF出力'
  type: ExportType
  needsYm: boolean
  needsOrg?: boolean
}

const EXPORT_CARDS: ExportCard[] = [
  {
    icon: '📊',
    title: '日比建設向け 出面一覧',
    description: '日比建設所属の全社員・現場別の出面データをExcel形式で出力します。月次の勤怠集計に利用できます。',
    format: 'Excel出力',
    type: 'hibi',
    needsYm: true,
  },
  {
    icon: '📊',
    title: 'HFU向け 出面一覧',
    description: 'HFU所属の実習生・特定技能生の出面データをExcel形式で出力します。管理団体への報告に利用できます。',
    format: 'Excel出力',
    type: 'hfu',
    needsYm: true,
  },
  {
    icon: '🏗',
    title: '現場別 出面一覧',
    description: '現場ごとにシートを分け、日比建設・HFUのセクション別で出面データを出力します。社内給与計算用。',
    format: 'Excel出力',
    type: 'perSite',
    needsYm: true,
  },
  {
    icon: '📄',
    title: '外注先向け 出面確認書',
    description: '外注先ごとの出面確認書をExcel形式で出力します。外注先への送付・確認用です。',
    format: 'Excel出力',
    type: 'subcon',
    needsYm: true,
  },
  {
    icon: '📐',
    title: '歩掛管理表',
    description: '現場別の歩掛（人工数・鳶換算）をExcel形式で出力します。原価管理・見積もりに活用できます。',
    format: 'Excel出力',
    type: 'bukake',
    needsYm: true,
  },
  {
    icon: '📈',
    title: '月次レポート',
    description: '月次の売上・原価・粗利をグラフ付きで出力します。経営会議や報告書に利用できます。',
    format: 'PDF出力',
    type: 'monthly',
    needsYm: true,
  },
  {
    icon: '🌴',
    title: '有給管理台帳',
    description: '有給付与・消化・残日数をExcel形式で出力。会社別に出力可能。',
    format: 'Excel出力',
    type: 'pl',
    needsYm: false,
    needsOrg: true,
  },
]

interface MonthlyReportData {
  workers: {
    name: string; org: string; workDays: number; otHours: number;
    plDays: number; totalCost: number; job: string
  }[]
  subcons: {
    name: string; type: string; workDays: number; otCount: number; cost: number
  }[]
  sites: {
    name: string; workDays: number; subWorkDays: number;
    cost: number; subCost: number; billing: number; profit: number; profitRate: number
  }[]
  totals: {
    workDays: number; subWorkDays: number; cost: number;
    subCost: number; billing: number; profit: number; otHours: number
  }
  siteNames: Record<string, string>
  ym: string
}

type TopTab = 'summary' | 'export'

interface MonthlyData {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  locked: boolean
  lockedHibi: boolean
  lockedHfu: boolean
  workDays: number
  prescribedDays?: number
  hasCalendarData?: boolean
  siteWorkDays?: Record<string, number>
  siteNames?: Record<string, string>
  totals: {
    workDays: number
    subWorkDays: number
    cost: number
    subCost: number
    billing: number
    profit: number
    otHours: number
  }
}

// ────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────

const ORG_LABELS: Record<string, string> = { hibi: '日比建設', hfu: 'HFU' }
const TYPE_LABELS: Record<string, string> = { tobi: 'とび', doko: '土工' }

function getYmOptions(count: number): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    result.push({
      ym: `${y}${String(m).padStart(2, '0')}`,
      label: `${y}年${m}月`,
    })
  }
  return result
}

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

type WorkerSortKey = 'name' | 'org' | 'workDays' | 'plDays' | 'otHours' | 'rate' | 'totalCost'
type SubconSortKey = 'name' | 'type' | 'workDays' | 'otCount' | 'rate' | 'cost'

// ────────────────────────────────────────
//  Tabs
// ────────────────────────────────────────

const TABS = [
  { key: 'all', label: '全体' },
  { key: 'hibi', label: '日比建設' },
  { key: 'hfu', label: 'HFU' },
  { key: 'subcon', label: '外注' },
] as const

type TabKey = typeof TABS[number]['key']

// ────────────────────────────────────────
//  Component
// ────────────────────────────────────────

export default function MonthlyPage() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(currentYm)
  const [tab, setTab] = useState<TabKey>('all')
  const [data, setData] = useState<MonthlyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lockToggling, setLockToggling] = useState(false)

  // 所定日数
  const [prescribedDays, setPrescribedDays] = useState<string>('')
  const [savingWorkDays, setSavingWorkDays] = useState(false)

  // Top-level tab
  const [topTab, setTopTab] = useState<TopTab>('summary')

  // Export states
  const [exportSelectedYm, setExportSelectedYm] = useState<Record<string, string>>({})
  const [exportDownloading, setExportDownloading] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [exportSelectedOrg, setExportSelectedOrg] = useState<Record<string, string>>({ pl: 'all' })
  const exportYmOptions = useMemo(() => getYmOptionsFromLib(12), [])

  // Worker sort
  const [workerSortKey, setWorkerSortKey] = useState<WorkerSortKey>('name')
  const [workerSortAsc, setWorkerSortAsc] = useState(true)

  // Subcon sort
  const [subconSortKey, setSubconSortKey] = useState<SubconSortKey>('name')
  const [subconSortAsc, setSubconSortAsc] = useState(true)

  const ymOptions = useMemo(() => getYmOptions(12), [])

  // Read auth + init export ym defaults
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        setPassword(pw)
      } catch { /* ignore */ }
    }

    const defaults: Record<string, string> = {}
    for (const card of EXPORT_CARDS) {
      if (card.needsYm) {
        defaults[card.type] = exportYmOptions[0]?.ym || ''
      }
    }
    setExportSelectedYm(defaults)
  }, [exportYmOptions])

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!password || !ym) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/monthly?ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        const msg = await res.text()
        setError(msg || 'データ取得に失敗しました')
        setData(null)
        return
      }
      const json: MonthlyData = await res.json()
      setData(json)
      setPrescribedDays(json.workDays ? String(json.workDays) : '')
    } catch (e) {
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Lock toggle ──

  const handleToggleLock = useCallback(async (org: 'hibi' | 'hfu') => {
    if (!password || !data) return
    const isCurrentlyLocked = org === 'hibi' ? data.lockedHibi : data.lockedHfu
    const newLocked = !isCurrentlyLocked
    const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
    const msg = newLocked ? `${ym} の${orgLabel}を月締めしますか？` : `${ym} の${orgLabel}の月締めを解除しますか？`
    if (!confirm(msg)) return
    setLockToggling(true)
    try {
      await fetch('/api/monthly/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ ym, locked: newLocked, org }),
      })
      fetchData()
    } catch {
      alert('エラーが発生しました')
    } finally {
      setLockToggling(false)
    }
  }, [password, data, ym, fetchData])

  const handleExcelExport = useCallback(async () => {
    if (!password || !ym) return
    try {
      const pd = Number(prescribedDays) || 0
      const orgFilter = tab === 'hibi' ? 'hibi' : tab === 'hfu' ? 'hfu' : tab === 'subcon' ? 'subcon' : 'all'
      const res = await fetch(
        `/api/export?type=monthlyExcel&ym=${ym}&prescribedDays=${pd}&org=${orgFilter}`,
        { headers: { 'x-admin-password': password } },
      )
      if (!res.ok) {
        alert('Excel出力に失敗しました')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const tabLabel = orgFilter === 'hfu' ? '_HFU' : orgFilter === 'hibi' ? '_日比建設' : orgFilter === 'subcon' ? '_外注' : ''
      a.download = `月次集計${tabLabel}_${ym}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      alert('Excel出力に失敗しました')
    }
  }, [password, ym, prescribedDays, tab])

  // ── 所定日数の保存 ──

  const handleSaveWorkDays = useCallback(async () => {
    if (!password) return
    setSavingWorkDays(true)
    try {
      await fetch('/api/monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'setWorkDays', ym, value: Number(prescribedDays) || 0 }),
      })
      fetchData()
    } catch {
      alert('保存に失敗しました')
    } finally {
      setSavingWorkDays(false)
    }
  }, [password, ym, prescribedDays, fetchData])

  // ── 前月コピー ──

  const handleCopyPrevMonth = useCallback(async () => {
    if (!password) return
    if (!confirm('前月のデータをコピーしますか？既存データは上書きされます')) return
    try {
      const res = await fetch('/api/monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'copyPrevMonth', ym }),
      })
      if (!res.ok) {
        const json = await res.json()
        alert(json.error || 'コピーに失敗しました')
        return
      }
      const json = await res.json()
      alert(`${json.copiedEntries}件のデータをコピーしました`)
      fetchData()
    } catch {
      alert('コピーに失敗しました')
    }
  }, [password, ym, fetchData])

  // ── Export download handler ──

  const handleExportDownload = useCallback(async (card: ExportCard) => {
    if (!password) {
      setExportError('管理者パスワードが設定されていません')
      return
    }

    const eym = exportSelectedYm[card.type]
    if (card.needsYm && !eym) {
      setExportError('対象月を選択してください')
      return
    }

    setExportError('')
    setExportDownloading(card.type)

    try {
      if (card.type === 'monthly') {
        const params = new URLSearchParams({ type: 'monthly', ym: eym })
        const res = await fetch(`/api/export?${params}`, {
          headers: { 'x-admin-password': password },
        })

        if (!res.ok) {
          const msg = await res.text()
          setExportError(msg || 'データ取得に失敗しました')
          return
        }

        const reportData: MonthlyReportData = await res.json()
        openMonthlyPrintPage(reportData)
      } else {
        const params = new URLSearchParams({ type: card.type })
        if (card.needsYm && eym) params.set('ym', eym)
        if (card.needsOrg) params.set('org', exportSelectedOrg[card.type] || 'all')

        const res = await fetch(`/api/export?${params}`, {
          headers: { 'x-admin-password': password },
        })

        if (!res.ok) {
          const errText = await res.text()
          setExportError(errText || 'ダウンロードに失敗しました')
          return
        }

        const disposition = res.headers.get('Content-Disposition') || ''
        const filenameMatch = disposition.match(/filename="(.+)"/)
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `export_${card.type}.xlsx`

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('Export error:', err)
      setExportError('エクスポートに失敗しました')
    } finally {
      setExportDownloading(null)
    }
  }, [password, exportSelectedYm, exportSelectedOrg])

  // Check if current month has data
  const hasCurrentData = useMemo(() => {
    if (!data) return false
    return data.workers.length > 0 || data.subcons.length > 0
  }, [data])

  // ── Worker filtering & sorting ──

  const filteredWorkers = useMemo(() => {
    if (!data) return []
    if (tab === 'hibi') return data.workers.filter(w => w.org === 'hibi')
    if (tab === 'hfu') return data.workers.filter(w => w.org === 'hfu')
    return data.workers
  }, [data, tab])

  const sortedWorkers = useMemo(() => {
    const list = [...filteredWorkers]
    list.sort((a, b) => {
      let cmp = 0
      switch (workerSortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'org': cmp = a.org.localeCompare(b.org); break
        case 'workDays': cmp = a.workDays - b.workDays; break
        case 'plDays': cmp = a.plDays - b.plDays; break
        case 'otHours': cmp = a.otHours - b.otHours; break
        case 'rate': cmp = a.rate - b.rate; break
        case 'totalCost': cmp = a.totalCost - b.totalCost; break
      }
      return workerSortAsc ? cmp : -cmp
    })
    return list
  }, [filteredWorkers, workerSortKey, workerSortAsc])

  const workerTotals = useMemo(() => {
    const dispatchDeduction = filteredWorkers.reduce((s, w) => s + (w.dispatchDeduction || 0), 0)
    const totalCostRaw = filteredWorkers.reduce((s, w) => s + w.totalCost, 0)
    return {
      workDays: filteredWorkers.reduce((s, w) => s + w.workDays, 0),
      workAll: filteredWorkers.reduce((s, w) => s + (w.workAll || w.workDays), 0),
      plDays: filteredWorkers.reduce((s, w) => s + w.plDays, 0),
      otHours: filteredWorkers.reduce((s, w) => s + w.otHours, 0),
      totalCost: totalCostRaw - dispatchDeduction,  // 出向控除済み
      totalCostRaw,                                   // 出向控除前
      dispatchDeduction,
    }
  }, [filteredWorkers])

  const toggleWorkerSort = (key: WorkerSortKey) => {
    if (workerSortKey === key) setWorkerSortAsc(!workerSortAsc)
    else { setWorkerSortKey(key); setWorkerSortAsc(true) }
  }

  // ── Subcon sorting ──

  const sortedSubcons = useMemo(() => {
    if (!data) return []
    const list = [...data.subcons]
    list.sort((a, b) => {
      let cmp = 0
      switch (subconSortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'type': cmp = a.type.localeCompare(b.type); break
        case 'workDays': cmp = a.workDays - b.workDays; break
        case 'otCount': cmp = a.otCount - b.otCount; break
        case 'rate': cmp = a.rate - b.rate; break
        case 'cost': cmp = a.cost - b.cost; break
      }
      return subconSortAsc ? cmp : -cmp
    })
    return list
  }, [data, subconSortKey, subconSortAsc])

  const subconTotals = useMemo(() => {
    if (!data) return { workDays: 0, otCount: 0, cost: 0 }
    return {
      workDays: data.subcons.reduce((s, sc) => s + sc.workDays, 0),
      otCount: data.subcons.reduce((s, sc) => s + sc.otCount, 0),
      cost: data.subcons.reduce((s, sc) => s + sc.cost, 0),
    }
  }, [data])

  const toggleSubconSort = (key: SubconSortKey) => {
    if (subconSortKey === key) setSubconSortAsc(!subconSortAsc)
    else { setSubconSortKey(key); setSubconSortAsc(true) }
  }

  // ── Sort indicator ──

  function sortArrow(active: boolean, asc: boolean) {
    if (!active) return ''
    return asc ? ' ↑' : ' ↓'
  }

  // ── Org badge ──

  function orgBadge(org: string) {
    const isHfu = org === 'hfu'
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full ${
        isHfu ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
      }`}>
        {isHfu ? 'HFU' : '日比'}
      </span>
    )
  }

  // ── Absence calculation ──

  const isHfuTab = tab === 'hfu'
  const prescribedDaysNum = Number(prescribedDays) || 0
  const showAbsenceColumns = isHfuTab && prescribedDaysNum > 0
  // Show salary columns for all tabs (visible for all workers)
  const showSalaryColumns = true

  function calcAbsentDays(w: WorkerMonthly): number {
    // Use server-computed value if available, otherwise calculate locally
    if (w.absence !== undefined) return w.absence
    const absent = prescribedDaysNum - (w.actualWorkDays || 0) - w.plUsed
    return Math.max(0, Math.round(absent * 10) / 10)
  }

  function calcAbsentDeduction(w: WorkerMonthly): number {
    if (w.absentCost !== undefined) return w.absentCost
    const absentDays = calcAbsentDays(w)
    return Math.round(absentDays * w.rate)
  }

  function calcNetPay(w: WorkerMonthly): number {
    if (w.netPay !== undefined) return w.netPay
    return w.totalCost - calcAbsentDeduction(w)
  }

  // ── Render ──

  const isWorkerTab = tab !== 'subcon'

  // Dynamic column count for empty state
  const workerColCount = 8 + (showAbsenceColumns ? 3 : 0) + 5  // +5: 基本給, 追加所定, 残業, 欠勤控除, 支給額

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Top-level pill tabs */}
      <div className="flex items-center gap-1 bg-gray-200 dark:bg-gray-700 rounded-full p-1 w-fit">
        <button
          onClick={() => setTopTab('summary')}
          className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${
            topTab === 'summary'
              ? 'bg-white dark:bg-gray-800 text-hibi-navy dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          📋 月次集計
        </button>
        <button
          onClick={() => setTopTab('export')}
          className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${
            topTab === 'export'
              ? 'bg-white dark:bg-gray-800 text-hibi-navy dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          📑 帳票出力
        </button>
      </div>

      {/* ═══════════════ 帳票出力 Tab ═══════════════ */}
      {topTab === 'export' && (
        <div className="space-y-6">
          <div>
            <h1 className="text-xl font-bold text-hibi-navy dark:text-white">帳票出力</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">各種帳票をExcel/PDF形式でダウンロードできます</p>
          </div>

          {exportError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
              {exportError}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {EXPORT_CARDS.map((card) => {
              const isDownloading = exportDownloading === card.type

              return (
                <div key={card.type} className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-5 flex flex-col">
                  <div className="text-3xl mb-3">{card.icon}</div>
                  <h3 className="font-bold text-hibi-navy dark:text-white text-sm mb-1">{card.title}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 flex-1">{card.description}</p>

                  {card.needsYm && (
                    <div className="mb-3">
                      <select
                        value={exportSelectedYm[card.type] || ''}
                        onChange={(e) => setExportSelectedYm(prev => ({ ...prev, [card.type]: e.target.value }))}
                        className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
                      >
                        {exportYmOptions.map(opt => (
                          <option key={opt.ym} value={opt.ym}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {card.needsOrg && (
                    <div className="mb-3">
                      <select
                        value={exportSelectedOrg[card.type] || 'all'}
                        onChange={(e) => setExportSelectedOrg(prev => ({ ...prev, [card.type]: e.target.value }))}
                        className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-hibi-navy"
                      >
                        <option value="all">全社</option>
                        <option value="hibi">日比建設</option>
                        <option value="hfu">HFU</option>
                      </select>
                    </div>
                  )}

                  <button
                    onClick={() => handleExportDownload(card)}
                    disabled={isDownloading}
                    className={`w-full rounded-lg py-2 text-sm font-medium transition flex items-center justify-center gap-2
                      ${isDownloading
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                        : 'bg-hibi-navy text-white hover:bg-hibi-light'
                      }`}
                  >
                    {isDownloading ? (
                      <>
                        <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                        <span>ダウンロード中...</span>
                      </>
                    ) : (
                      <>
                        <span>{'📥'}</span>
                        <span>{card.format}</span>
                      </>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ═══════════════ 月次集計 Tab ═══════════════ */}
      {topTab === 'summary' && <>
      {/* Header & controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-hibi-navy dark:text-white">月次集計</h1>
            {data && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                出勤延べ {fmtNum(data.totals.workDays)}人日 / 外注 {fmtNum(data.totals.subWorkDays)}人工 / 残業 {fmtNum(data.totals.otHours)}h
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {data?.lockedHibi && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-bold rounded-full">
                🔒 日比 締め済
              </span>
            )}
            {data?.lockedHfu && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-bold rounded-full">
                🔒 HFU 締め済
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyPrevMonth}
            disabled={hasCurrentData}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition disabled:opacity-40 disabled:cursor-not-allowed"
            title={hasCurrentData ? '既にデータが存在します' : '前月の出勤データをコピー'}
          >
            📋 前月コピー
          </button>
          <button
            onClick={() => handleToggleLock('hibi')}
            disabled={lockToggling || !data}
            className={`px-2.5 py-2 rounded-lg text-xs font-medium transition ${
              data?.lockedHibi
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-red-100 text-red-700 hover:bg-red-200'
            } disabled:opacity-50`}
          >
            {data?.lockedHibi ? '🔓 日比 解除' : '🔒 日比 締め'}
          </button>
          <button
            onClick={() => handleToggleLock('hfu')}
            disabled={lockToggling || !data}
            className={`px-2.5 py-2 rounded-lg text-xs font-medium transition ${
              data?.lockedHfu
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-red-100 text-red-700 hover:bg-red-200'
            } disabled:opacity-50`}
          >
            {data?.lockedHfu ? '🔓 HFU 解除' : '🔒 HFU 締め'}
          </button>
          <button
            onClick={handleExcelExport}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition"
          >
            📊 Excel出力
          </button>
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none"
          >
            {ymOptions.map(o => (
              <option key={o.ym} value={o.ym}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key
                ? 'bg-hibi-navy text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}

        {/* 所定日数: カレンダーデータがある月は自動取得、ない月は手入力 */}
        {isWorkerTab && data?.hasCalendarData && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium whitespace-nowrap">📅 所定日数: カレンダーから自動取得</span>
          </div>
        )}
        {isWorkerTab && !data?.hasCalendarData && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">所定日数:</label>
            <input
              type="number"
              value={prescribedDays}
              onChange={e => setPrescribedDays(e.target.value)}
              placeholder="—"
              min={0}
              max={31}
              step={1}
              className="w-16 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm text-center focus:ring-2 focus:ring-hibi-navy focus:outline-none"
            />
            <button
              onClick={handleSaveWorkDays}
              disabled={savingWorkDays}
              className="px-2 py-1 text-xs rounded bg-hibi-navy text-white hover:bg-blue-800 transition disabled:opacity-50"
            >
              {savingWorkDays ? '...' : '保存'}
            </button>
          </div>
        )}
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-8 text-center text-gray-400 dark:text-gray-500">
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Worker Table (全体 / 日比建設 / HFU) */}
      {!loading && data && isWorkerTab && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm min-w-[1400px]">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleWorkerSort('name')}
                >
                  名前{sortArrow(workerSortKey === 'name', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleWorkerSort('org')}
                >
                  所属{sortArrow(workerSortKey === 'org', workerSortAsc)}
                </th>
                <th className="px-3 py-3 whitespace-nowrap">現場</th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('workDays')}
                >
                  出勤日数{sortArrow(workerSortKey === 'workDays', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('plDays')}
                >
                  有給{sortArrow(workerSortKey === 'plDays', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('otHours')}
                >
                  残業(h){sortArrow(workerSortKey === 'otHours', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('rate')}
                >
                  日額単価{sortArrow(workerSortKey === 'rate', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('totalCost')}
                >
                  概算労務費{sortArrow(workerSortKey === 'totalCost', workerSortAsc)}
                </th>
                {showAbsenceColumns && (
                  <>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700">欠勤日数</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700">欠勤控除</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700">差引支給</th>
                  </>
                )}
                {showSalaryColumns && (
                  <>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700">基本給</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700">追加所定</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700">残業手当</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700">欠勤控除</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700">支給額合計</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedWorkers.length === 0 ? (
                <tr>
                  <td colSpan={workerColCount} className="px-3 py-8 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              ) : (
                sortedWorkers.map(w => {
                  const compDays = w.compDays || 0
                  const hasComp = compDays > 0
                  const absentDays = showAbsenceColumns ? calcAbsentDays(w) : 0
                  const absentDeduction = showAbsenceColumns ? calcAbsentDeduction(w) : 0
                  const netPay = showAbsenceColumns ? calcNetPay(w) : 0
                  return (
                    <tr key={w.id} className={`border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30 ${w.isDispatched ? 'bg-purple-50/30' : ''}`}>
                      <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                        {w.name}
                        {w.isDispatched && (
                          <span
                            className="ml-1.5 text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-bold align-middle"
                            title={`出向先: ${w.dispatchTo || ''}`}
                          >
                            🔁 出向中
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{orgBadge(w.org)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {w.sites.map((s, i) => {
                            const colors = [
                              'bg-blue-100 text-blue-700',
                              'bg-teal-100 text-teal-700',
                              'bg-indigo-100 text-indigo-700',
                              'bg-pink-100 text-pink-700',
                              'bg-amber-100 text-amber-700',
                            ]
                            return (
                              <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${colors[i % colors.length]}`}>
                                {(() => { const nm = data?.siteNames?.[s] || s; return nm.slice(0, 2) })()}
                              </span>
                            )
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <div>{w.workAll % 1 !== 0 ? w.workAll.toFixed(1) : w.workAll}</div>
                        {hasComp && (
                          <div className="text-[10px] text-gray-400">うち補{(compDays * 0.6).toFixed(1)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {w.plDays > 0 ? w.plDays : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {w.otHours > 0 ? fmtNum(w.otHours) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                        {fmtYen(w.rate)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                        {w.isDispatched ? (
                          <div>
                            <div className="text-purple-600 line-through text-xs text-gray-400">{fmtYen(Math.round(w.totalCost))}</div>
                            <div className="text-purple-700 font-bold">出向控除</div>
                            <div className="text-[10px] text-purple-500">-{fmtYen(Math.round(w.dispatchDeduction || w.totalCost))}</div>
                          </div>
                        ) : (
                          fmtYen(Math.round(w.totalCost))
                        )}
                      </td>
                      {showAbsenceColumns && (
                        <>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-red-50/50 ${absentDays > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                            {absentDays > 0 ? absentDays : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-red-50/50 ${absentDeduction > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {absentDeduction > 0 ? `-${fmtYen(absentDeduction)}` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums bg-red-50/50 font-medium">
                            {fmtYen(netPay)}
                          </td>
                        </>
                      )}
                      {showSalaryColumns && (
                        <>
                          <td className="px-3 py-2.5 text-right tabular-nums bg-green-50/50 text-gray-600">
                            {w.fixedBasePay != null && w.fixedBasePay > 0 ? fmtYen(w.fixedBasePay) : w.basePay != null && w.basePay > 0 ? fmtYen(w.basePay) : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.additionalAllowance || 0) > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                            {w.visa !== 'none' && (w.additionalAllowance || 0) > 0 ? fmtYen(w.additionalAllowance!) : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.otAllowance || 0) > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                            {(w.otAllowance || 0) > 0 ? fmtYen(w.otAllowance!) : '—'}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.absentDeduction || 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {w.visa !== 'none' && (w.absentDeduction || 0) > 0 ? `-${fmtYen(w.absentDeduction!)}` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums bg-green-50/50 font-medium">
                            {w.salaryNetPay != null && w.salaryNetPay > 0 ? fmtYen(w.salaryNetPay) : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })
              )}
            </tbody>
            {sortedWorkers.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold text-hibi-navy">
                  <td className="px-3 py-3">合計 ({filteredWorkers.length}名)</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3 text-right tabular-nums">{workerTotals.workAll % 1 !== 0 ? workerTotals.workAll.toFixed(1) : workerTotals.workAll}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtNum(workerTotals.plDays)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtNum(workerTotals.otHours)}</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {workerTotals.dispatchDeduction > 0 ? (
                      <div>
                        <div>{fmtYen(Math.round(workerTotals.totalCost))}</div>
                        <div className="text-[10px] text-purple-600 font-normal">
                          出向控除 -{fmtYen(Math.round(workerTotals.dispatchDeduction))}
                        </div>
                      </div>
                    ) : (
                      fmtYen(Math.round(workerTotals.totalCost))
                    )}
                  </td>
                  {showAbsenceColumns && (
                    <>
                      <td className="px-3 py-3 text-right tabular-nums bg-red-50/50">
                        {(() => {
                          const totalAbsent = filteredWorkers.reduce((s, w) => s + calcAbsentDays(w), 0)
                          return totalAbsent > 0 ? Math.round(totalAbsent * 10) / 10 : '—'
                        })()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-red-50/50 text-red-600">
                        {(() => {
                          const totalDeduction = filteredWorkers.reduce((s, w) => s + calcAbsentDeduction(w), 0)
                          return totalDeduction > 0 ? `-${fmtYen(totalDeduction)}` : '—'
                        })()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-red-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + calcNetPay(w), 0))}
                      </td>
                    </>
                  )}
                  {showSalaryColumns && (
                    <>
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalAddAllow = filteredWorkers.reduce((s, w) => s + (w.additionalAllowance || 0), 0)
                          return totalAddAllow > 0 ? fmtYen(totalAddAllow) : '—'
                        })()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalOtAllow = filteredWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0)
                          return totalOtAllow > 0 ? fmtYen(totalOtAllow) : '—'
                        })()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50 text-red-600">
                        {(() => {
                          const totalAbsDed = filteredWorkers.reduce((s, w) => s + (w.absentDeduction || 0), 0)
                          return totalAbsDed > 0 ? `-${fmtYen(totalAbsDed)}` : '—'
                        })()}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {fmtYen(filteredWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0))}
                      </td>
                    </>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Subcon Table (外注) */}
      {!loading && data && !isWorkerTab && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleSubconSort('name')}
                >
                  外注先{sortArrow(subconSortKey === 'name', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('rate')}
                >

                  人工単価{sortArrow(subconSortKey === 'rate', subconSortAsc)}
                </th>
                <th className="px-3 py-3 whitespace-nowrap text-right">残業単価</th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('workDays')}
                >
                  人工数{sortArrow(subconSortKey === 'workDays', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('otCount')}
                >
                  残業人数{sortArrow(subconSortKey === 'otCount', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('cost')}
                >
                  合計金額{sortArrow(subconSortKey === 'cost', subconSortAsc)}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedSubcons.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              ) : (
                sortedSubcons.map(sc => (
                  <tr key={sc.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                      {sc.name}
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${sc.type === 'tobi' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                        {TYPE_LABELS[sc.type] || sc.type}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                      {fmtYen(sc.rate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                      {sc.otRate > 0 ? fmtYen(sc.otRate) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(sc.workDays)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {sc.otCount > 0 ? fmtNum(sc.otCount) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                      {fmtYen(Math.round(sc.cost))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {sortedSubcons.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold text-hibi-navy">
                  <td className="px-3 py-3">合計 ({data!.subcons.length}社)</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtNum(subconTotals.workDays)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtNum(subconTotals.otCount)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {fmtYen(Math.round(subconTotals.cost))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      </>}
    </div>
  )
}

// ────────────────────────────────────────
//  月次レポート印刷用ページ
// ────────────────────────────────────────

function openMonthlyPrintPage(data: MonthlyReportData) {
  const ymLabel = (() => {
    const y = parseInt(data.ym.slice(0, 4))
    const m = parseInt(data.ym.slice(4, 6))
    return `${y}年${m}月`
  })()

  const formatYen = (v: number) => `\u00A5${v.toLocaleString()}`

  const siteRows = data.sites.map(s => `
    <tr>
      <td>${s.name}</td>
      <td class="num">${s.workDays}</td>
      <td class="num">${s.subWorkDays}</td>
      <td class="num">${formatYen(s.cost)}</td>
      <td class="num">${formatYen(s.subCost)}</td>
      <td class="num">${formatYen(s.billing)}</td>
      <td class="num">${formatYen(s.profit)}</td>
      <td class="num">${s.profitRate.toFixed(1)}%</td>
    </tr>
  `).join('')

  const workerRows = data.workers.map(w => `
    <tr>
      <td>${w.name}</td>
      <td>${w.org}</td>
      <td>${w.job}</td>
      <td class="num">${w.workDays}</td>
      <td class="num">${w.otHours}</td>
      <td class="num">${w.plDays}</td>
      <td class="num">${formatYen(w.totalCost)}</td>
    </tr>
  `).join('')

  const subconRows = data.subcons.map(sc => `
    <tr>
      <td>${sc.name}</td>
      <td>${sc.type}</td>
      <td class="num">${sc.workDays}</td>
      <td class="num">${sc.otCount}</td>
      <td class="num">${formatYen(sc.cost)}</td>
    </tr>
  `).join('')

  const t = data.totals

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>月次レポート ${ymLabel}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
  body { font-family: 'Hiragino Sans', 'Meiryo', sans-serif; margin: 20px; color: #1a1a2e; font-size: 12px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin-top: 24px; margin-bottom: 8px; border-bottom: 2px solid #1a1a2e; padding-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .summary-card { background: #f0f4ff; border-radius: 8px; padding: 12px 16px; min-width: 140px; }
  .summary-card .label { font-size: 11px; color: #666; }
  .summary-card .value { font-size: 18px; font-weight: bold; color: #1a1a2e; }
  .summary-card.profit { background: #e8f5e9; }
  .summary-card.loss { background: #ffebee; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1a1a2e; color: white; padding: 6px 8px; text-align: left; font-size: 11px; }
  td { border-bottom: 1px solid #ddd; padding: 5px 8px; font-size: 11px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 2px solid #1a1a2e; font-weight: bold; }
  .print-btn { position: fixed; top: 16px; right: 16px; background: #1a1a2e; color: white; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; cursor: pointer; z-index: 100; }
  .print-btn:hover { background: #2d2d5e; }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">印刷 / PDF保存</button>

  <h1>月次レポート</h1>
  <div class="subtitle">${ymLabel}</div>

  <div class="summary">
    <div class="summary-card">
      <div class="label">売上</div>
      <div class="value">${formatYen(t.billing)}</div>
    </div>
    <div class="summary-card">
      <div class="label">総原価</div>
      <div class="value">${formatYen(t.cost + t.subCost)}</div>
    </div>
    <div class="summary-card ${t.profit >= 0 ? 'profit' : 'loss'}">
      <div class="label">粗利</div>
      <div class="value">${formatYen(t.profit)}</div>
    </div>
    <div class="summary-card">
      <div class="label">自社人工</div>
      <div class="value">${t.workDays}人工</div>
    </div>
    <div class="summary-card">
      <div class="label">外注人工</div>
      <div class="value">${t.subWorkDays}人工</div>
    </div>
    <div class="summary-card">
      <div class="label">残業</div>
      <div class="value">${t.otHours}h</div>
    </div>
  </div>

  <h2>現場別サマリー</h2>
  <table>
    <thead>
      <tr>
        <th>現場名</th><th>自社人工</th><th>外注人工</th>
        <th>自社原価</th><th>外注原価</th><th>請求額</th><th>粗利</th><th>粗利率</th>
      </tr>
    </thead>
    <tbody>
      ${siteRows}
      <tr>
        <td>合計</td>
        <td class="num">${t.workDays}</td>
        <td class="num">${t.subWorkDays}</td>
        <td class="num">${formatYen(t.cost)}</td>
        <td class="num">${formatYen(t.subCost)}</td>
        <td class="num">${formatYen(t.billing)}</td>
        <td class="num">${formatYen(t.profit)}</td>
        <td class="num">${t.billing > 0 ? ((t.profit / t.billing) * 100).toFixed(1) + '%' : '-'}</td>
      </tr>
    </tbody>
  </table>

  <h2>社員別集計</h2>
  <table>
    <thead>
      <tr>
        <th>名前</th><th>所属</th><th>職種</th>
        <th>出勤日数</th><th>残業(h)</th><th>有給</th><th>原価</th>
      </tr>
    </thead>
    <tbody>
      ${workerRows}
    </tbody>
  </table>

  <h2>外注先別集計</h2>
  <table>
    <thead>
      <tr>
        <th>外注先名</th><th>区分</th><th>人工数</th><th>残業人数</th><th>原価</th>
      </tr>
    </thead>
    <tbody>
      ${subconRows}
    </tbody>
  </table>
</body>
</html>`

  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  }
}

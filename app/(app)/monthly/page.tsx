'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { fmtYen, fmtNum, fmtPct } from '@/lib/format'
import { getYmOptions as getYmOptionsFromLib } from '@/lib/compute'
import PayrollAuditModal from '@/components/monthly/PayrollAuditModal'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'

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
  compBaseDeduction?: number  // 補償日 通常分控除（旧ルール固定給・会社都合休）
  salaryNetPay?: number
  // 3層構造 fields
  fixedBasePay?: number
  additionalAllowance?: number
  legalLimit?: number
  // 有給手当（日本人=日給×有給日数）／有給日給（ベトナム人=20日枠超×時給×7h）
  paidLeaveDays?: number
  paidLeaveAllowance?: number
  // 2026-06-XX 追加: 所定外労働手当（法定内・割増なし、新ルール時のみ）
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  // 法令準拠の詳細支給項目（5月以降）
  legalHolidayHours?: number
  legalHolidayAllowance?: number
  nightHours?: number
  nightAllowance?: number
  compAllowance?: number
  regularWorkDays?: number
  // 出向情報
  isDispatched?: boolean
  dispatchTo?: string
  dispatchDeduction?: number
  // 旧ルール継続フラグ
  useOldRules?: boolean
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
  | 'auditPdf' | 'plannedShift' | 'actualHours'  // 2026-06-XX 追加: 社労士提出用

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
  // 2026-06-XX 追加: 社労士提出用 (会社別。タブ下のクイックアクセスにも同じ機能あり)
  {
    icon: '🔍',
    title: '社労士確認用 PDF',
    description: 'ベトナム人スタッフの給与計算根拠を PDF で出力。各スタッフ 1ページずつ。社労士チェック・労基署対応用。',
    format: 'PDF出力',
    type: 'auditPdf',
    needsYm: true,
    needsOrg: true,
  },
  {
    icon: '📅',
    title: '勤務予定シフト表（社労士提出用）',
    description: 'ベトナム人スタッフの勤務予定シフトを Excel で出力。各スタッフ 1シート。労働時間・休憩・所定日数の事前計画。',
    format: 'Excel出力',
    type: 'plannedShift',
    needsYm: true,
    needsOrg: true,
  },
  {
    icon: '⏱',
    title: '実労働時間明細（社労士提出用）',
    description: 'ベトナム人スタッフの実際の始業・終業・残業を Excel で出力。各スタッフ 1シート。',
    format: 'Excel出力',
    type: 'actualHours',
    needsYm: true,
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
  baseDays?: number
  hasOldRulesWorkers?: boolean
  // 2026-06-12 (監査 Sprint2-D): 締め後に支給額が変わった場合の差分情報
  snapshotDiffs?: {
    org: string
    lockedAt?: string
    count: number
    items: { id: number; name: string; snapshot: number; current: number }[]
  }[]
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

// 表示用の「時間外労働(h)」を返す。
// - 新ルール（変形労働）ベトナム人: 計算値 = 所定外労働 + 法定外残業（3層判定後）
//   ※ 生の o 欄合計(otHours)は、st/et 入力月では実態とズレるため使わない
//   （例: 笹塚は o=0 だが法定外残業あり / 富岡は o過多だが実態は所定外）
// - 日本人(日額制) / 旧ルール: 従来どおり出面の残業欄合計(otHours)
function displayOtHours(w: WorkerMonthly): number {
  if (w.useOldRules) return w.otHours
  if (w.nonStatutoryOTHours !== undefined || w.legalOtHours !== undefined) {
    return Math.round(((w.nonStatutoryOTHours || 0) + (w.legalOtHours || 0)) * 10) / 10
  }
  return w.otHours
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
  // 2026-06-XX 追加 (UI #3): 自動検算で違反のあったスタッフだけ絞り込むフィルタ
  const [showAnomalyOnly, setShowAnomalyOnly] = useState(false)
  const [data, setData] = useState<MonthlyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lockToggling, setLockToggling] = useState(false)

  // 所定日数
  const [prescribedDays, setPrescribedDays] = useState<string>('')

  // 2026-06-XX 追加: 旧ルール想定の「日曜以外の日数」を月から自動算出
  //   旧ルール (フン等) の所定日数は「原則 日曜のみ休み」が基準。
  //   例: 5月 = 31日 − 日曜5日 = 26日 (基準値)。GW/夏季/年末年始 などは
  //   ユーザーが手動で減算する想定。
  //   未設定月のフォールバック値および UI ヒント表示に使用。
  const calcDefaultPrescribedDays = useCallback((ymStr: string): number => {
    if (!ymStr || !/^\d{6}$/.test(ymStr)) return 0
    const y = parseInt(ymStr.slice(0, 4))
    const m = parseInt(ymStr.slice(4, 6))
    const daysInMonth = new Date(y, m, 0).getDate()
    let sundays = 0
    for (let d = 1; d <= daysInMonth; d++) {
      if (new Date(y, m - 1, d).getDay() === 0) sundays++
    }
    return daysInMonth - sundays
  }, [])
  // 計算根拠モーダル用
  const [auditingWorker, setAuditingWorker] = useState<WorkerMonthly | null>(null)
  const [savingWorkDays, setSavingWorkDays] = useState(false)

  // Top-level tab
  const [topTab, setTopTab] = useState<TopTab>('summary')
  // 2026-06-XX 追加: 社労士提出用資料セクションの開閉
  const [showSyaroshiSection, setShowSyaroshiSection] = useState(false)

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
      // 2026-06-XX: 未設定 (0/null) 月は「日曜以外の日数」を自動初期値に
      //   旧ルール継続者の所定日数は通常この値が基準（特別休暇分を手動で減算）
      const defaultDays = calcDefaultPrescribedDays(ym)
      setPrescribedDays(json.workDays ? String(json.workDays) : String(defaultDays))
    } catch (e) {
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [password, ym, calcDefaultPrescribedDays])

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
      const res = await fetch('/api/monthly/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ ym, locked: newLocked, org }),
      })
      // 2026-06-13: 締め前チェック（月未了・職長未承認）の 409 メッセージを表示
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '締め処理に失敗しました' }))
        alert(`締めできません:\n\n${err.error || res.statusText}`)
        return
      }
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
      // 2026-06-12 修正 (監査C3): 所定日数は送らない。サーバが保存値 main.workDays[ym] を
      // 使うため、画面の未保存入力値で Excel だけ違う金額になる事故を防ぐ。
      const orgFilter = tab === 'hibi' ? 'hibi' : tab === 'hfu' ? 'hfu' : tab === 'subcon' ? 'subcon' : 'all'
      const res = await fetch(
        `/api/export?type=monthlyExcel&ym=${ym}&org=${orgFilter}`,
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
  }, [password, ym, tab])

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
      } else if (card.type === 'auditPdf') {
        // 2026-06-XX 追加: 社労士確認 PDF は新タブで /monthly/audit-print を開く
        //   ファイルダウンロードではなくブラウザの「PDFとして保存」を使う
        const orgSel = exportSelectedOrg[card.type] || 'hibi'
        const orgParam = orgSel === 'all' ? 'hibi' : orgSel  // all指定なら hibi に fallback (PDF は1組織ずつ)
        window.open(`/monthly/audit-print?ym=${eym}&org=${orgParam}`, '_blank')
        return  // 新タブ遷移後はダウンロード完了扱い
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

  // 2026-06-XX 修正 (UI #3): 2段階フィルタ
  //   Step 1: tabFilteredWorkers = タブ (全体/日比/HFU) でフィルタ
  //   Step 2: validation を tabFiltered で計算 (filteredWorkers 経由だと循環依存)
  //   Step 3: filteredWorkers = 異常フラグで更にフィルタ
  const tabFilteredWorkers = useMemo(() => {
    if (!data) return []
    if (tab === 'hibi') return data.workers.filter(w => w.org === 'hibi')
    if (tab === 'hfu') return data.workers.filter(w => w.org === 'hfu')
    return data.workers
  }, [data, tab])

  // tab フィルタ後の validation 結果（異常フィルタの ID source）
  // 2026-06-15 修正: 自動検算は「新ルール（変形労働制・2026年5月〜）」専用。
  //   4月以前は compute が全員を旧ルールで計算するため、新ルール検算を当てると
  //   構成要素不一致・所定外労働¥0 等の誤検知が大量に出る（給与計算自体は正しい）。
  //   → ym < '202605'（旧ルール月）は検算対象外にして空結果を返す。
  const validationOnTab = useMemo(() => {
    const targets = ym >= '202605' ? tabFilteredWorkers : []
    return validatePayrolls(targets as unknown as PayrollSnapshot[])
  }, [tabFilteredWorkers, ym])

  const filteredWorkers = useMemo(() => {
    if (!showAnomalyOnly) return tabFilteredWorkers
    const idsSet = new Set(validationOnTab.affectedWorkerIds)
    return tabFilteredWorkers.filter(w => idsSet.has(w.id))
  }, [tabFilteredWorkers, showAnomalyOnly, validationOnTab])

  const sortedWorkers = useMemo(() => {
    const list = [...filteredWorkers]
    list.sort((a, b) => {
      let cmp = 0
      switch (workerSortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'org': cmp = a.org.localeCompare(b.org); break
        case 'workDays': cmp = a.workDays - b.workDays; break
        case 'plDays': cmp = a.plDays - b.plDays; break
        case 'otHours': cmp = displayOtHours(a) - displayOtHours(b); break
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
      otHours: Math.round(filteredWorkers.reduce((s, w) => s + displayOtHours(w), 0) * 10) / 10,
      totalCost: totalCostRaw - dispatchDeduction,  // 出向控除済み
      totalCostRaw,                                   // 出向控除前
      dispatchDeduction,
    }
  }, [filteredWorkers])

  // 給与計算の自動検算（2026-06-XX 追加: 不変条件で過去バグ3種を検出）
  //   新ルール外国人スタッフのみが対象（旧ルール・日本人・月給制は対象外）
  //   バナー表示は tabFiltered ベースで判定（異常フィルタの ON/OFF で件数が変わらないように）
  const validationResult = validationOnTab

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

  // 2026-06-12 修正 (監査): 画面側の金額フォールバック計算を削除。
  //   computeMonthly は absence/absentCost/netPay を常に初期化するため到達しないデッドコードだったが、
  //   「出力層は金額を再計算しない」原則に反し、API 形状変更時に compute とズレた金額が
  //   静かに表示されるリスクがあった。サーバ値のみを表示する。
  function calcAbsentDays(w: WorkerMonthly): number {
    return w.absence ?? 0
  }

  function calcAbsentDeduction(w: WorkerMonthly): number {
    return w.absentCost ?? 0
  }

  function calcNetPay(w: WorkerMonthly): number {
    return w.netPay ?? 0
  }

  // ── Render ──

  const isWorkerTab = tab !== 'subcon'

  // Dynamic column count for empty state
  // 給与列: 旧ルール=5列, 新ルール=9列（+所定外労働/法休手当/深夜手当/休業手当）
  // 2026-06-XX 修正 (I-2): 新ルール時の所定外労働手当列を追加
  // 2026-06-15 追加: 補償日控除（会社都合休の通常分・旧ルール固定給者）は、該当者がいる時だけ列を出す
  const showCompBaseDeduction = filteredWorkers.some(w => (w.compBaseDeduction || 0) > 0)
  const salaryColCount = (ym >= '202605' ? 9 : 5) + (showCompBaseDeduction ? 1 : 0)
  const workerColCount = 8 + (showAbsenceColumns ? 3 : 0) + salaryColCount

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
                <div key={card.type} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-5 flex flex-col">
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
                出勤延べ {fmtNum(data.totals.workDays)}人日 / 外注 {fmtNum(data.totals.subWorkDays)}人工 / 残業 {fmtNum(Math.round(data.workers.reduce((s, w) => s + displayOtHours(w), 0) * 10) / 10)}h
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
            title="月次集計テーブルを Excel 出力（タブ別シート構成・自動検算結果込み）。給与計算のメイン帳票"
          >
            📊 月次集計 Excel
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

        {/* 所定日数: カレンダーデータがある月は自動取得、ない月は手入力。
            2026-06-12 (監査 Sprint2): 旧ルール継続者（フン）が在籍する月は、カレンダーが
            あっても全社所定の入力欄を常時表示する（フンの欠勤控除は main.workDays[ym] を
            使うため毎月の設定が必要。旧: 欄が消えて Firestore 直編集が必要だった） */}
        {isWorkerTab && data?.hasCalendarData && !data?.hasOldRulesWorkers && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium whitespace-nowrap">📅 所定日数: カレンダーから自動取得</span>
          </div>
        )}
        {isWorkerTab && (!data?.hasCalendarData || data?.hasOldRulesWorkers) && (
          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-300 dark:border-gray-600 flex-wrap">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap" title={data?.hasCalendarData ? '新ルールのスタッフは現場カレンダーから自動取得。この欄は旧ルール継続者（フン等）の所定日数（日曜以外−祝日）' : undefined}>
              {data?.hasCalendarData ? '所定日数(旧ルール用):' : '所定日数:'}
            </label>
            {data?.hasOldRulesWorkers && (Number(prescribedDays) || 0) === 0 && (
              <span className="text-xs text-red-600 dark:text-red-400 font-bold whitespace-nowrap">⚠ 未設定（フンさんの欠勤控除が計算できません）</span>
            )}
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
            {/* 2026-06-XX 追加: 日曜以外の基準値ヒント + クイックリセット */}
            {(() => {
              const baseDays = calcDefaultPrescribedDays(ym)
              const current = Number(prescribedDays) || 0
              const diff = current - baseDays
              return (
                <span
                  className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap cursor-pointer hover:text-hibi-navy"
                  title="クリックで基準値（日曜以外の日数）にリセット。特別休暇分はここから手動で減算してください"
                  onClick={() => setPrescribedDays(String(baseDays))}
                >
                  📅 基準値: {baseDays}日 (日曜以外)
                  {diff < 0 && <span className="ml-1 text-amber-600">{diff}日</span>}
                </span>
              )
            })()}
          </div>
        )}

        {/* 2026-06-XX 追加 (UI #3): 異常スタッフのみフィルタ */}
        {isWorkerTab && validationOnTab.affectedWorkerIds.length > 0 && (
          <button
            onClick={() => setShowAnomalyOnly(s => !s)}
            className={`ml-4 pl-4 border-l border-gray-300 dark:border-gray-600 flex items-center gap-2 transition ${
              showAnomalyOnly
                ? 'text-red-700 dark:text-red-300 font-bold'
                : 'text-gray-500 dark:text-gray-400 hover:text-red-600'
            }`}
            title={showAnomalyOnly
              ? 'クリックして全員表示に戻す'
              : 'クリックして検算で違反のあるスタッフだけ表示'}
          >
            <span className="text-base">{showAnomalyOnly ? '🔴' : '⚪'}</span>
            <span className="text-xs whitespace-nowrap">
              {showAnomalyOnly ? '異常者のみ表示中' : `異常者のみ (${validationOnTab.affectedWorkerIds.length}名)`}
            </span>
          </button>
        )}
      </div>

      {/* 2026-06-XX 整理: 社労士提出用資料を 1セクションに統合 (折りたたみ式) */}
      {/*   旧: 紫バナー (PDF) と 緑バナー (Excel) が並んでて画面を圧迫
           新: 「📥 社労士提出用資料」1セクション、デフォルト折りたたみ
                 開くと日比/HFU別に PDF + Excel × 2 を配置 */}
      {isWorkerTab && data && (
        <div className="mt-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setShowSyaroshiSection(s => !s)}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-indigo-100/50 dark:hover:bg-indigo-900/30 transition"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">📥</span>
              <span className="text-xs font-bold text-indigo-800 dark:text-indigo-300">
                社労士提出用資料（ベトナム人スタッフのみ）
              </span>
              <span className="text-[10px] text-indigo-600 dark:text-indigo-400">
                計算根拠 PDF / 勤務予定シフト / 実労働時間明細
              </span>
            </div>
            <span className="text-xs text-indigo-600 dark:text-indigo-400">
              {showSyaroshiSection ? '▲ 閉じる' : '▼ 開く'}
            </span>
          </button>
          {showSyaroshiSection && (() => {
            const ymClean = ym.replace('-', '')
            const downloadExcel = async (type: 'plannedShift' | 'actualHours', org: 'hibi' | 'hfu', filename: string) => {
              const stored = localStorage.getItem('hibi_auth')
              const pw = stored ? JSON.parse(stored).password : ''
              const res = await fetch(`/api/export?type=${type}&ym=${ymClean}&org=${org}`, {
                headers: { 'x-admin-password': pw },
              })
              if (!res.ok) {
                alert('ダウンロードに失敗しました')
                return
              }
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = filename
              a.click()
              URL.revokeObjectURL(url)
            }
            const renderCompanyRow = (orgKey: 'hibi' | 'hfu', orgLabel: string, colorClass: string) => (
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className={`text-xs font-semibold min-w-[72px] ${colorClass}`}>{orgLabel}:</span>
                <button
                  onClick={() => window.open(`/monthly/audit-print?ym=${ymClean}&org=${orgKey}`, '_blank')}
                  className="px-2.5 py-1 text-[11px] rounded bg-purple-600 text-white hover:bg-purple-700 transition font-medium"
                  title="計算根拠 PDF を新タブで開く（Cmd+P → PDF保存）"
                >
                  🔍 計算根拠 PDF
                </button>
                <button
                  onClick={() => downloadExcel('plannedShift', orgKey, `勤務予定シフト_${orgLabel}_${ymClean}.xlsx`)}
                  className="px-2.5 py-1 text-[11px] rounded bg-teal-600 text-white hover:bg-teal-700 transition font-medium"
                  title="勤務予定シフト表 (Excel)"
                >
                  📅 勤務予定シフト
                </button>
                <button
                  onClick={() => downloadExcel('actualHours', orgKey, `実労働時間明細_${orgLabel}_${ymClean}.xlsx`)}
                  className="px-2.5 py-1 text-[11px] rounded bg-emerald-600 text-white hover:bg-emerald-700 transition font-medium"
                  title="実労働時間明細 (Excel)"
                >
                  ⏱ 実労働時間明細
                </button>
              </div>
            )
            return (
              <div className="px-3 pb-3 border-t border-indigo-200/50 dark:border-indigo-700/50">
                {renderCompanyRow('hibi', '日比建設', 'text-teal-900 dark:text-teal-200')}
                {renderCompanyRow('hfu', 'HFU', 'text-pink-900 dark:text-pink-200')}
                <div className="text-[10px] text-indigo-700 dark:text-indigo-400 mt-1 pl-1">
                  💡 会社ごとに社労士が異なるため別々に出力。PDF はブラウザの「PDFとして保存」、Excel は自動ダウンロード
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Loading / Error */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-8 text-center text-gray-400 dark:text-gray-500">
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* 2026-06-12 (監査 Sprint2-D): 締め後に支給額が変わった場合の警告バナー。
          締め時に保存したスナップショットと現行計算を突合し、単価変更・出面修正等で
          「支払った金額」と画面の金額がズレたことを検知する */}
      {!loading && data && isWorkerTab && (data.snapshotDiffs?.length || 0) > 0 && (
        <div className="rounded-xl p-4 border bg-red-50 dark:bg-red-900/20 border-red-400 dark:border-red-700">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🚨</span>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-red-800 dark:text-red-300">
                締め（給与確定）後に支給額が変わっています
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                締め時点のスナップショットと現在の計算結果が一致しません。締め後に単価・出面・有給等が変更された可能性があります。
                変更が誤りなら元に戻し、正当な修正なら「締め解除 → 内容確認 → 再締め」でスナップショットを更新してください。
              </div>
              {data.snapshotDiffs!.map(diff => (
                <div key={diff.org} className="mt-2">
                  <div className="text-xs font-bold text-red-700 dark:text-red-400">
                    {diff.org === 'hibi' ? '日比建設' : 'HFU'}（締め: {diff.lockedAt ? diff.lockedAt.slice(0, 16).replace('T', ' ') : '—'} / 差分 {diff.count}名）
                  </div>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {diff.items.map(item => (
                      <li key={item.id} className="text-gray-800 dark:text-gray-200">
                        <span className="font-semibold">{item.name}</span>:
                        <span className="font-mono ml-1">締め時 {fmtYen(item.snapshot)} → 現在 {fmtYen(item.current)}</span>
                        <span className={`ml-1 font-mono font-bold ${item.current > item.snapshot ? 'text-red-600' : 'text-blue-600'}`}>
                          ({item.current > item.snapshot ? '+' : ''}{fmtYen(item.current - item.snapshot)})
                        </span>
                      </li>
                    ))}
                    {diff.count > diff.items.length && (
                      <li className="text-xs text-gray-500">…他 {diff.count - diff.items.length} 名</li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 給与計算の自動検算バナー（2026-06-XX 追加） */}
      {!loading && data && isWorkerTab && validationResult.total > 0 && (
        <div className={`rounded-xl p-4 border ${
          validationResult.critical > 0
            ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'
            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-700'
        }`}>
          <div className="flex items-start gap-3">
            <span className="text-2xl">{validationResult.critical > 0 ? '⚠️' : '🔔'}</span>
            <div className="flex-1 min-w-0">
              <div className={`font-bold ${
                validationResult.critical > 0
                  ? 'text-red-800 dark:text-red-300'
                  : 'text-yellow-800 dark:text-yellow-300'
              }`}>
                給与計算に{validationResult.critical > 0 ? '異常' : '注意点'}があります（{validationResult.affectedWorkerIds.length}名 / 検出{validationResult.total}件）
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                労基法・実労働時間ベースの自動検算で {validationResult.critical > 0 && <span className="font-semibold text-red-700 dark:text-red-400">critical {validationResult.critical}件</span>}
                {validationResult.critical > 0 && validationResult.warning > 0 && ' / '}
                {validationResult.warning > 0 && <span className="font-semibold text-yellow-700 dark:text-yellow-400">warning {validationResult.warning}件</span>}
                {' '}を検出しました。該当スタッフの行クリックで「計算根拠」モーダルを開いて詳細を確認してください。
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {validationResult.issues.slice(0, 5).map((iss, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={iss.severity === 'critical' ? 'text-red-600' : 'text-yellow-600'}>
                      {iss.severity === 'critical' ? '❌' : '⚠'}
                    </span>
                    <span className="text-gray-800 dark:text-gray-200">
                      <span className="font-semibold">{iss.workerName}</span>: {iss.message}
                      {iss.expected !== undefined && iss.actual !== undefined && (
                        <span className="text-gray-500"> (想定 {fmtYen(iss.expected)} / 実額 {fmtYen(iss.actual)})</span>
                      )}
                    </span>
                  </li>
                ))}
                {validationResult.issues.length > 5 && (
                  <li className="text-xs text-gray-500 dark:text-gray-400 pl-6">
                    …他 {validationResult.issues.length - 5} 件
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 2026-06-12 (監査 Sprint2-C): 異常0件でも検算の実施状況を常時表示。
          旧: 異常時のみバナー → 「検算対象外（日本人・フン・完全月給）も含めて全員OK」と
          誤認するリスクがあった。対象/対象外の人数を明示する */}
      {!loading && data && isWorkerTab && validationResult.total === 0 && (() => {
        const targets = tabFilteredWorkers.filter(w =>
          w.visa && w.visa !== 'none' && (w.hourlyRate || 0) > 0 && !(w.salary && w.salary > 0) && !w.useOldRules)
        const exempt = tabFilteredWorkers.length - targets.length
        return (
          <div className="rounded-xl px-4 py-3 border bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700 flex items-center gap-3 text-sm">
            <span className="text-xl">✅</span>
            <div className="text-green-800 dark:text-green-300">
              <span className="font-bold">自動検算OK</span>
              <span className="ml-2">対象 {targets.length}名（ベトナム人・新ルール時給制）に異常なし。</span>
              {exempt > 0 && (
                <span className="ml-1 text-green-700/80 dark:text-green-400/80">
                  対象外 {exempt}名（日本人・完全月給・旧ルール継続）は自動検算の対象外のため、計算根拠モーダルで目視確認してください。
                </span>
              )}
            </div>
          </div>
        )
      })()}

      {/* Worker Table (全体 / 日比建設 / HFU) */}
      {!loading && data && isWorkerTab && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[1400px]">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap sticky left-0 z-20 bg-gray-50 dark:bg-gray-700 border-r border-gray-200 dark:border-gray-600 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]"
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
                  title="新ルール(ベトナム人): 所定外労働+法定外残業の計算値（3層判定後）。日本人・旧ルール: 出面の残業欄合計"
                >
                  残業(h){sortArrow(workerSortKey === 'otHours', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('rate')}
                  title="日給月給=日額 / 完全月給・固定月給=月給 / ベトナム人=時給ベース（行に応じて表示）"
                >
                  単価/月給{sortArrow(workerSortKey === 'rate', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('totalCost')}
                >
                  <span title="実際の支給額ベースの労務費（ベトナム人・完全月給は支給額、日本人日給月給は日額×日数）">労務費</span>{sortArrow(workerSortKey === 'totalCost', workerSortAsc)}
                </th>
                {showAbsenceColumns && (
                  <>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">欠勤日数</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">欠勤控除</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">差引支給</th>
                  </>
                )}
                {showSalaryColumns && (
                  <>
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">基本給</th>
                    {/* 4月以前は「休業補償」、5月以降は「追加所定」 */}
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                      {ym >= '202605' ? '追加所定' : '休業補償'}
                    </th>
                    {/* 2026-06-XX 追加 (I-2): 所定外労働手当列を新ルール時に表示 */}
                    {ym >= '202605' && (
                      <th
                        className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                        title="月所定140h超〜法定上限内の労働 × 通常賃金（労基法24条）"
                      >
                        所定外労働
                      </th>
                    )}
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                      {ym >= '202605' ? '法定外残業' : '残業手当'}
                    </th>
                    {ym >= '202605' && (
                      <>
                        <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="日曜出勤 1.35倍 (8h超は1.60倍)">法休手当</th>
                        <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="22:00-5:00 +0.25倍">深夜手当</th>
                        <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="補償日 60%">休業手当</th>
                      </>
                    )}
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">欠勤控除</th>
                    {showCompBaseDeduction && (
                      <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300" title="会社都合休(補償日)の通常分。固定給は満額前提のため一旦控除し、60%を休業補償で還元（正味 日給の40%控除）">補償日控除</th>
                    )}
                    <th className="px-3 py-3 whitespace-nowrap text-right bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">支給額合計</th>
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
                      {/*
                        名前列は横スクロール時に固定（sticky left-0）。
                        sticky cell は透過できないので solid な背景色が必要。
                        even/hover の交互色は失われるが、出向中(紫)はインライン badge も
                        あるため視認性は維持される。
                      */}
                      <td className={`px-3 py-2.5 font-medium whitespace-nowrap sticky left-0 z-10 border-r border-gray-200 dark:border-gray-700 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)] ${
                        w.isDispatched
                          ? 'bg-purple-50 dark:bg-purple-900/40'
                          : 'bg-white dark:bg-gray-800'
                      }`}>
                        <button
                          onClick={() => setAuditingWorker(w)}
                          className="hover:underline hover:text-hibi-navy text-left"
                          title={(() => {
                            // 2026-06-XX 追加 (UI #4): ホバーで支給額内訳を即表示
                            //   モーダルを開かなくても合計の構成が把握できる
                            const lines: string[] = ['📋 給与内訳（クリックで詳細）']
                            lines.push('')
                            if ((w.fixedBasePay || w.basePay || 0) > 0)
                              lines.push(`基本給:        ¥${(w.fixedBasePay || w.basePay || 0).toLocaleString()}`)
                            if ((w.additionalAllowance || 0) > 0)
                              lines.push(`追加所定:      ¥${(w.additionalAllowance || 0).toLocaleString()}`)
                            if ((w.paidLeaveAllowance || 0) > 0)
                              lines.push(`有給手当:      ¥${(w.paidLeaveAllowance || 0).toLocaleString()}`)
                            if ((w.nonStatutoryOTAllowance || 0) > 0)
                              lines.push(`所定外労働:    ¥${(w.nonStatutoryOTAllowance || 0).toLocaleString()}`)
                            if ((w.otAllowance || 0) > 0)
                              lines.push(`法定外残業:    ¥${(w.otAllowance || 0).toLocaleString()}`)
                            if ((w.legalHolidayAllowance || 0) > 0)
                              lines.push(`法定休日:      ¥${(w.legalHolidayAllowance || 0).toLocaleString()}`)
                            if ((w.nightAllowance || 0) > 0)
                              lines.push(`深夜:          ¥${(w.nightAllowance || 0).toLocaleString()}`)
                            if ((w.compAllowance || 0) > 0)
                              lines.push(`休業手当:      ¥${(w.compAllowance || 0).toLocaleString()}`)
                            if ((w.absentDeduction || 0) > 0)
                              lines.push(`欠勤控除:     −¥${(w.absentDeduction || 0).toLocaleString()}`)
                            if ((w.compBaseDeduction || 0) > 0)
                              lines.push(`補償日控除:   −¥${(w.compBaseDeduction || 0).toLocaleString()}（会社都合休の通常分・60%は休業手当で還元）`)
                            lines.push('─────────────')
                            lines.push(`支給額:        ¥${(w.salaryNetPay || 0).toLocaleString()}`)
                            return lines.join('\n')
                          })()}
                        >
                          {w.name}
                          <span className="ml-1 text-[10px] text-blue-500 opacity-0 group-hover:opacity-100">🔍</span>
                        </button>
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
                        {displayOtHours(w) > 0 ? fmtNum(displayOtHours(w)) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                        {(w.salary || 0) > 0 ? (
                          <span title="完全月給（出勤日数に関わらず固定）">
                            {fmtYen(w.salary || 0)}
                            <span className="ml-1 text-[10px] text-purple-600 dark:text-purple-300">月給</span>
                          </span>
                        ) : (
                          fmtYen(w.rate)
                        )}
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
                          {/* 2026-06-XX 追加 (I-2): 所定外労働手当 列（新ルール時のみ） */}
                          {ym >= '202605' && (
                            <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.nonStatutoryOTAllowance || 0) > 0 ? 'text-cyan-600' : 'text-gray-400'}`}
                              title={`所定外労働 ${w.nonStatutoryOTHours || 0}h × 通常賃金（割増なし）`}>
                              {w.visa !== 'none' && (w.nonStatutoryOTAllowance || 0) > 0 ? fmtYen(w.nonStatutoryOTAllowance!) : '—'}
                            </td>
                          )}
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.otAllowance || 0) > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                            {(w.otAllowance || 0) > 0 ? fmtYen(w.otAllowance!) : '—'}
                          </td>
                          {ym >= '202605' && (
                            <>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.legalHolidayAllowance || 0) > 0 ? 'text-pink-600' : 'text-gray-400'}`}>
                                {w.visa !== 'none' && (w.legalHolidayAllowance || 0) > 0 ? fmtYen(w.legalHolidayAllowance!) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.nightAllowance || 0) > 0 ? 'text-purple-600' : 'text-gray-400'}`}>
                                {w.visa !== 'none' && (w.nightAllowance || 0) > 0 ? fmtYen(w.nightAllowance!) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.compAllowance || 0) > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                                {w.visa !== 'none' && (w.compAllowance || 0) > 0 ? fmtYen(w.compAllowance!) : '—'}
                              </td>
                            </>
                          )}
                          <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.absentDeduction || 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                            {w.visa !== 'none' && (w.absentDeduction || 0) > 0 ? `-${fmtYen(w.absentDeduction!)}` : '—'}
                          </td>
                          {showCompBaseDeduction && (
                            <td className={`px-3 py-2.5 text-right tabular-nums bg-green-50/50 ${(w.compBaseDeduction || 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}
                              title="補償日の通常分控除。60%は休業補償で還元（正味 日給の40%控除＝60%支給）">
                              {(w.compBaseDeduction || 0) > 0 ? `-${fmtYen(w.compBaseDeduction!)}` : '—'}
                            </td>
                          )}
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
                <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold text-hibi-navy dark:text-white">
                  <td className="px-3 py-3 sticky left-0 z-10 bg-gray-50 dark:bg-gray-700 border-r border-gray-200 dark:border-gray-600 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]">合計 ({filteredWorkers.length}名)</td>
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
                      {/* 2026-06-XX 追加 (I-2): 所定外労働手当 合計列 */}
                      {ym >= '202605' && (
                        <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                          {(() => {
                            const total = filteredWorkers.reduce((s, w) => s + (w.nonStatutoryOTAllowance || 0), 0)
                            return total > 0 ? fmtYen(total) : '—'
                          })()}
                        </td>
                      )}
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                        {(() => {
                          const totalOtAllow = filteredWorkers.reduce((s, w) => s + (w.otAllowance || 0), 0)
                          return totalOtAllow > 0 ? fmtYen(totalOtAllow) : '—'
                        })()}
                      </td>
                      {ym >= '202605' && (
                        <>
                          <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.legalHolidayAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.nightAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums bg-green-50/50">
                            {(() => {
                              const total = filteredWorkers.reduce((s, w) => s + (w.compAllowance || 0), 0)
                              return total > 0 ? fmtYen(total) : '—'
                            })()}
                          </td>
                        </>
                      )}
                      <td className="px-3 py-3 text-right tabular-nums bg-green-50/50 text-red-600">
                        {(() => {
                          const totalAbsDed = filteredWorkers.reduce((s, w) => s + (w.absentDeduction || 0), 0)
                          return totalAbsDed > 0 ? `-${fmtYen(totalAbsDed)}` : '—'
                        })()}
                      </td>
                      {showCompBaseDeduction && (
                        <td className="px-3 py-3 text-right tabular-nums bg-green-50/50 text-red-600">
                          {(() => {
                            const total = filteredWorkers.reduce((s, w) => s + (w.compBaseDeduction || 0), 0)
                            return total > 0 ? `-${fmtYen(total)}` : '—'
                          })()}
                        </td>
                      )}
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
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm overflow-x-auto">
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
                <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold text-hibi-navy dark:text-white">
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

      {/* 給与計算根拠モーダル（透明化・監査用） */}
      {auditingWorker && (
        <PayrollAuditModal
          worker={auditingWorker}
          ym={ym}
          prescribedDays={data?.prescribedDays ?? (Number(prescribedDays) || 0)}
          baseDays={data?.baseDays ?? 20}
          onClose={() => setAuditingWorker(null)}
        />
      )}
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

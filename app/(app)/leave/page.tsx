'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { fmtPct } from '@/lib/format'

interface PLWorker {
  id: number; name: string; org: string; visa: string; hireDate: string
  grantDays: number; carryOver: number; adjustment: number; periodUsed: number; used: number
  total: number; remaining: number; rate: number; grantMonth?: number
  grantDate: string; expiryDate: string; expiryStatus: 'ok' | 'warning' | 'expired'; inferredFromDefault?: boolean
  legalPL: number; fiveDayShortfall: number
  monthlyUsage: Record<string, number>
  // 監査情報
  grantedAt?: string
  grantedBy?: number | string
  method?: string
  lastEditedAt?: string
  lastEditedBy?: number | string
  adjustmentHistory?: Array<{ at: string; by: number | string; field: string; before: string; after: string }>
  // Phase 5: 時季指定
  designatedLeaves?: Array<{ date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string }>
  // Phase 6: 買取
  buyoutDays?: number
  buyoutHistory?: Array<{ at: string; by: number | string; days: number; amount?: number; reason?: string }>
  // Phase 8: FIFO内訳
  carryOverRemaining?: number
  carryOverExpiryDate?: string
  carryOverExpiryStatus?: 'ok' | 'warning' | 'expired'
  carryOverSourceGrantDate?: string
  grantRemaining?: number
  grantExpiryDate?: string
  grantExpiryStatus?: 'ok' | 'warning' | 'expired'
}

/** hireDate + 6ヶ月 → 発生月を計算 */
function calcGrantMonthFromHire(hireDate: string): number | null {
  if (!hireDate) return null
  const d = new Date(hireDate)
  if (isNaN(d.getTime())) return null
  const grantDate = new Date(d.getFullYear(), d.getMonth() + 6, 1)
  return grantDate.getMonth() + 1 // 1-12
}

type OrgFilter = 'all' | 'hibi' | 'hfu'

/** 法定有給付与日数を計算（フロントエンド版） */
function calcLegalPL(hireDate: string, grantDate: string): { days: number; years: number; months: number; label: string } {
  if (!hireDate || !grantDate) return { days: 0, years: 0, months: 0, label: '' }
  const hire = new Date(hireDate)
  const grant = new Date(grantDate)
  if (isNaN(hire.getTime()) || isNaN(grant.getTime())) return { days: 0, years: 0, months: 0, label: '' }

  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grant.getFullYear() - hire.getFullYear()) * 12
    + (grant.getMonth() - hire.getMonth())
    + (grant.getDate() >= hire.getDate() ? 0 : -1)
  const years = Math.floor(diffMonths / 12)
  const months = diffMonths % 12

  let days = 0
  if (diffMonths < 6) days = 0
  else if (diffMonths < 18) days = 10
  else if (diffMonths < 30) days = 11
  else if (diffMonths < 42) days = 12
  else if (diffMonths < 54) days = 14
  else if (diffMonths < 66) days = 16
  else if (diffMonths < 78) days = 18
  else days = 20

  const label = `入社日 ${hireDate} → ${years}年${months}ヶ月 → 法定${days}日`
  return { days, years, months, label }
}

/** 消化率のバー色を決定 */
function rateBarColor(rate: number): string {
  if (rate <= 50) return 'from-green-400 to-green-500'
  if (rate <= 80) return 'from-yellow-400 to-yellow-500'
  return 'from-red-400 to-red-500'
}

/** 日本の祝日（簡易版 - 固定日のみ） */
function getJPHolidays(year: number): Set<string> {
  const holidays = new Set<string>()
  const add = (m: number, d: number) => {
    holidays.add(`${year}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`)
  }
  add(1, 1)   // 元日
  add(2, 11)  // 建国記念の日
  add(2, 23)  // 天皇誕生日
  add(4, 29)  // 昭和の日
  add(5, 3)   // 憲法記念日
  add(5, 4)   // みどりの日
  add(5, 5)   // こどもの日
  add(8, 11)  // 山の日
  add(11, 3)  // 文化の日
  add(11, 23) // 勤労感謝の日
  // 成人の日（1月第2月曜）
  for (let d = 8; d <= 14; d++) { if (new Date(year, 0, d).getDay() === 1) { add(1, d); break } }
  // 春分の日（概算）
  add(3, year % 4 === 0 ? 20 : 21)
  // 海の日（7月第3月曜）
  let count = 0
  for (let d = 1; d <= 31; d++) { if (new Date(year, 6, d).getDay() === 1) { count++; if (count === 3) { add(7, d); break } } }
  // 敬老の日（9月第3月曜）
  count = 0
  for (let d = 1; d <= 30; d++) { if (new Date(year, 8, d).getDay() === 1) { count++; if (count === 3) { add(9, d); break } } }
  // 秋分の日（概算）
  add(9, year % 4 === 0 ? 22 : 23)
  // スポーツの日（10月第2月曜）
  count = 0
  for (let d = 1; d <= 31; d++) { if (new Date(year, 9, d).getDay() === 1) { count++; if (count === 2) { add(10, d); break } } }
  return holidays
}

export default function LeavePage() {
  const [password, setPassword] = useState('')
  const [workers, setWorkers] = useState<PLWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editWorker, setEditWorker] = useState<PLWorker | null>(null)
  const [editForm, setEditForm] = useState({ grantDays: '', carryOver: '', adjustment: '', grantDate: '' })
  const [saving, setSaving] = useState(false)
  const [orgFilter, setOrgFilter] = useState<OrgFilter>('all')
  const [showGrantModal, setShowGrantModal] = useState(false)
  const [grantForm, setGrantForm] = useState({ workerId: '', grantDays: '10', grantMonth: '', grantDate: '' })
  const [legalPLInfo, setLegalPLInfo] = useState<{ days: number; years: number; months: number; label: string } | null>(null)
  const [plCalendar, setPlCalendar] = useState<Record<string, number[]>>({})
  const [workerNames, setWorkerNames] = useState<Record<number, string>>({})
  const [calendarTooltip, setCalendarTooltip] = useState<{ dateKey: string; x: number; y: number } | null>(null)
  const [editingGrantMonth, setEditingGrantMonth] = useState<number | null>(null) // workerId being edited
  const [grantMonthSaving, setGrantMonthSaving] = useState(false)
  const [autoGranted, setAutoGranted] = useState<{ name: string; days: number; grantDate: string }[]>([])
  const [autoGrantDismissed, setAutoGrantDismissed] = useState(false)
  // タブ管理
  const [activeTab, setActiveTab] = useState<'list' | 'requests' | 'monthly' | 'calendar' | 'homeleave'>('list')

  // 帰国情報（旧 home-leave ページから統合）
  type HomeLeave = { id: string; workerId: number; workerName: string; startDate: string; endDate: string; reason: string; note?: string; createdAt: string }
  const [homeLeaves, setHomeLeaves] = useState<HomeLeave[]>([])
  const [hlSaving, setHlSaving] = useState(false)
  const [hlFormOpen, setHlFormOpen] = useState(false)
  const [hlShowPast, setHlShowPast] = useState(false)
  const [hlFormWorkerId, setHlFormWorkerId] = useState<number | ''>('')
  const [hlFormStart, setHlFormStart] = useState('')
  const [hlFormEnd, setHlFormEnd] = useState('')
  const [hlFormReason, setHlFormReason] = useState<string>('一時帰国')
  const [hlFormNote, setHlFormNote] = useState('')
  const [hlEditingId, setHlEditingId] = useState<string | null>(null)
  const [hlEditStart, setHlEditStart] = useState('')
  const [hlEditEnd, setHlEditEnd] = useState('')
  const [hlEditReason, setHlEditReason] = useState('')
  const [hlEditNote, setHlEditNote] = useState('')
  const [hlDeleteConfirm, setHlDeleteConfirm] = useState<string | null>(null)

  // 半自動付与（未付与検知）
  type PendingGrant = { workerId: number; name: string; visa: string; hireDate: string; tenureText: string; nextGrantDate: string; fy: string; legalDays: number; reason: string; needsAttention?: boolean; attentionNote?: string }
  const [pendingGrants, setPendingGrants] = useState<PendingGrant[]>([])
  const [pendingModal, setPendingModal] = useState(false)
  const [pendingForm, setPendingForm] = useState<Record<number, { grantDate: string; grantDays: string; include: boolean }>>({})
  const [pendingExecuting, setPendingExecuting] = useState(false)

  // 時季指定（Phase 5）/ 管理者手動P入力（案B）
  const [designateWorker, setDesignateWorker] = useState<PLWorker | null>(null)
  const [designateKind, setDesignateKind] = useState<'designation' | 'manual-entry'>('designation')
  const [designateDates, setDesignateDates] = useState<string[]>([])
  const [designateSiteId, setDesignateSiteId] = useState<string>('')
  const [designateNote, setDesignateNote] = useState<string>('')
  const [designateOverwriteHomeLeave, setDesignateOverwriteHomeLeave] = useState(false)
  const [designateSubmitting, setDesignateSubmitting] = useState(false)

  // 買取記録（Phase 6）
  const [buyoutWorker, setBuyoutWorker] = useState<PLWorker | null>(null)
  const [buyoutForm, setBuyoutForm] = useState({ days: '', amount: '', reason: 'year-end' as 'year-end' | 'retirement' | 'other' })
  const [buyoutSubmitting, setBuyoutSubmitting] = useState(false)
  // 申請管理
  const [leaveRequests, setLeaveRequests] = useState<{ id: string; workerId: number; workerName: string; date: string; siteId: string; reason: string; status: string; requestedAt: string; foremanApprovedAt?: string; foremanApprovedBy?: number; reviewedAt?: string; rejectedReason?: string }[]>([])
  const [sites, setSites] = useState<{ id: string; name: string }[]>([])
  const [processingReq, setProcessingReq] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [reqFilter, setReqFilter] = useState<'all' | 'pending' | 'foreman_approved' | 'approved' | 'rejected'>('all')

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  // ?tab=homeleave などURLパラメータでタブ初期表示を制御
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab')
    if (tab === 'list' || tab === 'requests' || tab === 'monthly' || tab === 'calendar' || tab === 'homeleave') {
      setActiveTab(tab)
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const [res, reqRes, siteRes, pendRes, hlRes] = await Promise.all([
        fetch(`/api/leave?calendar=true`, { headers: { 'x-admin-password': password } }),
        fetch('/api/leave-request', { headers: { 'x-admin-password': password } }),
        fetch('/api/sites', { headers: { 'x-admin-password': password } }),
        fetch('/api/leave', {
          method: 'POST',
          headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getPendingGrants' }),
        }),
        fetch('/api/home-leave', { headers: { 'x-admin-password': password } }),
      ])
      if (hlRes.ok) {
        const d = await hlRes.json()
        setHomeLeaves(d.homeLeaves || [])
      }
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
        setPlCalendar(data.plCalendar || {})
        setWorkerNames(data.workerNames || {})
      } else {
        setError('データの取得に失敗しました')
      }
      if (reqRes.ok) {
        const d = await reqRes.json()
        setLeaveRequests(d.requests || [])
      }
      if (siteRes.ok) {
        const d = await siteRes.json()
        setSites(d.sites || [])
      }
      if (pendRes.ok) {
        const d = await pendRes.json()
        const list = (d.pending || []) as PendingGrant[]
        setPendingGrants(list)
        // フォーム初期値: 注意フラグが立っているワーカーは「デフォルト外す」（管理者に確認を促す）
        const form: Record<number, { grantDate: string; grantDays: string; include: boolean }> = {}
        list.forEach(p => {
          form[p.workerId] = {
            grantDate: p.nextGrantDate,
            grantDays: String(p.legalDays || 10),
            include: !p.needsAttention,
          }
        })
        setPendingForm(form)
      }
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  // Update legal PL and auto-fill grant month when worker selected in grant modal
  useEffect(() => {
    if (grantForm.workerId) {
      const w = workers.find(w => w.id === Number(grantForm.workerId))
      if (w?.hireDate) {
        const grantDate = grantForm.grantDate || new Date().toISOString().split('T')[0]
        const info = calcLegalPL(w.hireDate, grantDate)
        setLegalPLInfo(info)
        // Auto-fill grant days from legal calculation
        setGrantForm(prev => {
          const updates: Partial<typeof prev> = { grantDays: String(info.days) }
          // Auto-fill grant month from worker's grantMonth or calculated from hireDate
          if (!prev.grantMonth) {
            const autoMonth = w.grantMonth || calcGrantMonthFromHire(w.hireDate)
            if (autoMonth) updates.grantMonth = String(autoMonth)
          }
          return { ...prev, ...updates }
        })
      } else {
        setLegalPLInfo(null)
      }
    } else {
      setLegalPLInfo(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantForm.workerId, grantForm.grantDate])

  const filteredWorkers = orgFilter === 'all'
    ? workers
    : workers.filter(w => orgFilter === 'hfu' ? w.org === 'hfu' : w.org !== 'hfu')

  const eligible = filteredWorkers.length
  const totalRemaining = filteredWorkers.reduce((s, w) => s + w.remaining, 0)
  const totalUsed = filteredWorkers.reduce((s, w) => s + w.used, 0)
  const totalTotal = filteredWorkers.reduce((s, w) => s + w.total, 0)
  const alertCount = filteredWorkers.filter(w => w.remaining <= 3).length
  const fiveDayAlertCount = filteredWorkers.filter(w => w.fiveDayShortfall > 0).length
  const companyRate = totalTotal > 0 ? (totalUsed / totalTotal * 100) : 0

  const handleGrant = async () => {
    if (!grantForm.workerId) { alert('対象者を選択してください'); return }
    setSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'grant',
          workerId: Number(grantForm.workerId),
          fy: grantForm.grantDate ? grantForm.grantDate.slice(0, 4) : String(new Date().getFullYear()),
          grantDays: grantForm.grantDays,
          grantMonth: grantForm.grantMonth,
          grantDate: grantForm.grantDate,
        }),
      })
      setShowGrantModal(false)
      setGrantForm({ workerId: '', grantDays: '10', grantMonth: '', grantDate: '' })
      setLegalPLInfo(null)
      fetchData()
    } finally { setSaving(false) }
  }

  const handleGrantMonthUpdate = async (workerId: number, newMonth: string) => {
    setGrantMonthSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateGrantMonth',
          workerId,
          grantMonth: newMonth || null,
        }),
      })
      setEditingGrantMonth(null)
      fetchData()
    } finally { setGrantMonthSaving(false) }
  }

  const handleCarryOver = async () => {
    if (!confirm('繰越再計算を実行しますか？\n\n※通常は付与時に自動計算されるため、このボタンは基本不要です。\n旧データで繰越値が古いままになっている場合の修復用です。\n\n全スタッフの最新付与レコードに対して、前期残日数から繰越を再計算します。')) return
    setSaving(true)
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'carryOver', fy: String(new Date().getFullYear()) }),
      })
      fetchData()
    } finally { setSaving(false) }
  }

  const handleProcessExpiry = async () => {
    if (!confirm('時効処理を実行しますか？\n\n付与日から2年を過ぎた有給を「失効」として記録します。\n通常は月1回Vercel Cronで自動実行されますが、ここから手動実行も可能です。')) return
    setSaving(true)
    try {
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'processExpiry' }),
      })
      if (res.ok) {
        const data = await res.json()
        const msg = data.processed === 0
          ? '✅ 時効処理を実行しました\n\n該当する失効レコードはありませんでした。'
          : `✅ 時効処理を実行しました\n\n${data.processed}件を失効として記録:\n${(data.expired || []).slice(0, 10).map((e: {workerName:string;fy:string;grantDate:string;expiredDays:number}) => `  - ${e.workerName} FY${e.fy} (${e.grantDate}~): ${e.expiredDays}日失効`).join('\n')}${data.expired.length > 10 ? `\n  ... ほか${data.expired.length - 10}件` : ''}`
        alert(msg)
        fetchData()
      } else {
        alert('時効処理に失敗しました')
      }
    } finally { setSaving(false) }
  }

  const handleMigrate = async (autoFix: boolean = false) => {
    const confirmMsg = autoFix
      ? 'データ正規化（+ fy/grantDate不整合の自動修正）を実行しますか？\n\nfy と grantDate の年が一致しないレコードについて、grantDate の年に fy を合わせて修正します。'
      : 'データ正規化を実行しますか？\n\n以下を一括修復します:\n・旧フィールド(grant/carry/adj)を新フィールドに昇格\n・fy型ブレをString統一\n・grantDate欠落の自動補完\n・同一fy重複レコードの集約\n・期限切れレコードの自動アーカイブ\n\n冪等な処理なので何度実行しても安全です。\n\nfy/grantDate年ズレは警告のみです。'
    if (!confirm(confirmMsg)) return
    setSaving(true)
    try {
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate', autoFixMismatches: autoFix }),
      })
      if (res.ok) {
        const data = await res.json()
        const s = data.stats
        const msg =
          `✅ データ正規化完了${autoFix ? '（自動修正モード）' : ''}\n\n` +
          `処理ワーカー数: ${s.workersProcessed}\n` +
          `処理レコード数: ${s.recordsProcessed}\n` +
          `旧フィールド昇格: ${s.legacyFieldsUpgraded}\n` +
          `fy型正規化: ${s.fyNormalized}\n` +
          `grantDate補完: ${s.grantDatesInferred}\n` +
          `重複レコード集約: ${s.duplicatesMerged}\n` +
          `期限切れアーカイブ: ${s.recordsArchived}\n\n` +
          (s.mismatches.length > 0 ? `${autoFix ? '🔧 fy自動修正' : '⚠️ fy/grantDate年ズレ'}: ${s.mismatches.length}件\n${s.mismatches.slice(0,5).map((m: {name:string;fy:string;grantDate:string}) => `  - ${m.name}: fy=${m.fy}, grantDate=${m.grantDate}`).join('\n')}${s.mismatches.length > 5 ? `\n  ... ほか${s.mismatches.length - 5}件` : ''}\n\n` : '') +
          (s.warnings.length > 0 ? `⚠️ 警告: ${s.warnings.length}件\n${s.warnings.slice(0,5).map((w: {name:string;note:string}) => `  - ${w.name}: ${w.note}`).join('\n')}${s.warnings.length > 5 ? `\n  ... ほか${s.warnings.length - 5}件` : ''}\n` : '')
        alert(msg)
        fetchData()
      } else {
        alert('データ正規化に失敗しました')
      }
    } finally { setSaving(false) }
  }

  // PLカレンダーは直近1年を表示

  // ── PL Calendar data ── 直近1年を表示
  const calendarYear = new Date().getFullYear()
  const calendarMonths = useMemo(() => {
    const months: { year: number; month: number; label: string }[] = []
    for (let m = 1; m <= 12; m++) months.push({ year: calendarYear, month: m, label: `${calendarYear}年${m}月` })
    return months
  }, [calendarYear])

  const holidays = useMemo(() => {
    const set = new Set<string>()
    getJPHolidays(calendarYear).forEach(h => set.add(h))
    return set
  }, [calendarYear])

  if (loading) return <div className="flex items-center justify-center py-20"><div className="text-gray-400">読み込み中...</div></div>
  if (error) return <div className="max-w-5xl mx-auto py-10"><div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center text-red-700">{error}</div></div>

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">有給管理</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">有給休暇の付与・消化状況</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGrantModal(true)}
            className="bg-green-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-green-700 transition">
            + 有給付与
          </button>
          <button onClick={handleCarryOver} disabled={saving}
            className="bg-gray-400 text-white px-3 py-2 rounded-lg text-sm hover:bg-gray-500 transition disabled:opacity-50"
            title="通常は付与時に自動計算されます。過去データの修復・再計算用">
            ⟲ 繰越再計算
          </button>
          <button onClick={() => handleMigrate(false)} disabled={saving}
            className="bg-purple-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-purple-700 transition disabled:opacity-50"
            title="旧データ移行整理: grantDate補完・fy型統一・重複集約・アーカイブ">
            🔧 データ正規化
          </button>
          <button onClick={() => handleMigrate(true)} disabled={saving}
            className="bg-purple-700 text-white px-3 py-2 rounded-lg text-sm hover:bg-purple-800 transition disabled:opacity-50"
            title="fy/grantDate年ズレも自動修正（grantDateの年にfyを合わせる）">
            🔧 自動修正
          </button>
          <button onClick={handleProcessExpiry} disabled={saving}
            className="bg-gray-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-gray-700 transition disabled:opacity-50"
            title="時効(2年)を迎えた有給を失効として記録（通常は月1回Cronで自動実行）">
            ⏳ 時効処理
          </button>
          <button onClick={async () => {
            const res = await fetch('/api/leave/export-ledger', {
              headers: { 'x-admin-password': password },
            })
            if (!res.ok) { alert('管理簿の出力に失敗しました'); return }
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `有給管理簿_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`
            a.click()
            URL.revokeObjectURL(url)
          }} disabled={saving}
            className="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 transition disabled:opacity-50"
            title="労基法施行規則24条の7準拠の有給管理簿をExcelで出力">
            📊 管理簿出力
          </button>
        </div>
      </div>

      {/* 繰越時効間近アラート (Phase 8) */}
      {(() => {
        const expiringCarryOver = workers.filter(w =>
          (w.carryOverRemaining ?? 0) > 0 && w.carryOverExpiryStatus === 'warning'
        )
        if (expiringCarryOver.length === 0) return null
        return (
          <div className="w-full bg-gradient-to-r from-orange-50 to-yellow-50 dark:from-orange-900/30 dark:to-yellow-900/30 border border-orange-300 dark:border-orange-700 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="text-2xl">⏰</div>
              <div>
                <div className="text-sm font-bold text-orange-900 dark:text-orange-200">
                  繰越分の時効が近づいています: {expiringCarryOver.length}名
                </div>
                <div className="text-xs text-orange-700 dark:text-orange-300 mt-0.5">
                  繰越分は先に消費される設計です。時効までに取得させることを推奨。
                </div>
              </div>
            </div>
            <div className="space-y-1 mt-3">
              {expiringCarryOver.map(w => (
                <div key={w.id} className="flex items-center justify-between gap-2 text-xs bg-white/80 dark:bg-gray-800/80 rounded px-2 py-1.5">
                  <div>
                    <span className="font-medium">{w.name}</span>
                    <span className="text-gray-500 ml-2">繰越残 {w.carryOverRemaining}日 / 時効 {w.carryOverExpiryDate}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* 年5日未達アラートバナー (Phase 5) */}
      {(() => {
        const shortfallWorkers = workers.filter(w => w.fiveDayShortfall > 0)
        if (shortfallWorkers.length === 0) return null
        return (
          <div className="w-full bg-gradient-to-r from-red-50 to-pink-50 dark:from-red-900/30 dark:to-pink-900/30 border border-red-300 dark:border-red-700 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="text-2xl">⚠️</div>
              <div>
                <div className="text-sm font-bold text-red-900 dark:text-red-200">
                  年5日取得義務 未達: {shortfallWorkers.length}名
                </div>
                <div className="text-xs text-red-700 dark:text-red-300 mt-0.5">
                  法定義務として会社が時季指定する必要があります。
                </div>
              </div>
            </div>
            <div className="space-y-1 mt-3">
              {shortfallWorkers.map(w => (
                <div key={w.id} className="flex items-center justify-between gap-2 text-xs bg-white/80 dark:bg-gray-800/80 rounded px-2 py-1.5">
                  <div>
                    <span className="font-medium">{w.name}</span>
                    <span className="text-gray-500 ml-2">消化 {w.periodUsed}日 / 義務5日 → あと {w.fiveDayShortfall}日</span>
                    <span className="text-gray-400 ml-2">期限: {w.expiryDate}</span>
                  </div>
                  <button onClick={() => {
                    setDesignateWorker(w)
                    setDesignateKind('designation')
                    setDesignateDates([])
                    setDesignateSiteId(sites[0]?.id || '')
                    setDesignateNote('年5日取得義務対応')
                    setDesignateOverwriteHomeLeave(false)
                  }} className="bg-red-500 text-white px-2.5 py-1 rounded text-[10px] font-bold hover:bg-red-600">
                    時季指定する
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* 未付与検知バナー */}
      {pendingGrants.length > 0 && (
        <button onClick={() => setPendingModal(true)}
          className="w-full bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/30 border border-amber-300 dark:border-amber-700 rounded-xl p-4 flex items-center justify-between hover:from-amber-100 hover:to-orange-100 dark:hover:from-amber-900/50 dark:hover:to-orange-900/50 transition text-left">
          <div className="flex items-center gap-3">
            <div className="text-2xl">🌴</div>
            <div>
              <div className="text-sm font-bold text-amber-900 dark:text-amber-200">
                {pendingGrants.length}名 に有給付与の時期が来ています
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                {pendingGrants.slice(0, 3).map(p => p.name).join('、')}
                {pendingGrants.length > 3 ? ` ほか${pendingGrants.length - 3}名` : ''}
              </div>
            </div>
          </div>
          <div className="text-xs font-bold bg-amber-600 text-white px-3 py-1.5 rounded-md">
            内容を確認する →
          </div>
        </button>
      )}

      {/* Main tabs */}
      {(() => {
        const pendingCount = leaveRequests.filter(r => r.status === 'pending').length
        return (
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
            {([
              { key: 'list' as const, label: '一覧' },
              { key: 'requests' as const, label: '申請', badge: pendingCount },
              { key: 'monthly' as const, label: '月別' },
              { key: 'calendar' as const, label: 'カレンダー' },
              { key: 'homeleave' as const, label: '✈️ 帰国情報' },
            ]).map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition flex items-center gap-1 ${
                  activeTab === tab.key ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}>
                {tab.label}
                {tab.badge ? <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5">{tab.badge}</span> : null}
              </button>
            ))}
          </div>
        )
      })()}

      {/* Org filter (一覧タブのみ) */}
      {activeTab === 'list' && (
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
          {([['all', '全員'], ['hibi', '日比建設'], ['hfu', 'HFU']] as [OrgFilter, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setOrgFilter(key)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
                orgFilter === key ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── 申請タブ ── */}
      {activeTab === 'requests' && (() => {
        const filtered = reqFilter === 'all' ? leaveRequests
          : leaveRequests.filter(r => r.status === reqFilter)
        const getSiteName = (siteId: string) => sites.find(s => s.id === siteId)?.name || siteId
        const fmtDate = (d: string) => { const [, m, day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}` }
        const fmtTs = (ts: string) => { const d = new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
        const handleForemanApprove = async (id: string) => {
          setProcessingReq(id)
          try {
            const stored = localStorage.getItem('hibi_auth')
            const { user } = stored ? JSON.parse(stored) : { user: null }
            await fetch('/api/leave-request', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
              body: JSON.stringify({ action: 'foreman_approve', requestId: id, foremanId: user?.workerId || 0 }),
            })
            fetchData()
          } catch {} finally { setProcessingReq(null) }
        }
        const handleApprove = async (id: string) => {
          setProcessingReq(id)
          try {
            const stored = localStorage.getItem('hibi_auth')
            const { user } = stored ? JSON.parse(stored) : { user: null }
            await fetch('/api/leave-request', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
              body: JSON.stringify({ action: 'approve', requestId: id, approvedBy: user?.workerId || 0 }),
            })
            fetchData()
          } catch {} finally { setProcessingReq(null) }
        }
        const handleReject = async (id: string) => {
          setProcessingReq(id)
          try {
            const stored = localStorage.getItem('hibi_auth')
            const { user } = stored ? JSON.parse(stored) : { user: null }
            await fetch('/api/leave-request', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
              body: JSON.stringify({ action: 'reject', requestId: id, rejectedBy: user?.workerId || 0, reason: rejectReason }),
            })
            setRejectingId(null); setRejectReason(''); fetchData()
          } catch {} finally { setProcessingReq(null) }
        }
        return (
          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              {(['all','pending','foreman_approved','approved','rejected'] as const).map(key => (
                <button key={key} onClick={() => setReqFilter(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${reqFilter === key ? 'bg-hibi-navy text-white' : 'bg-white dark:bg-gray-800 text-gray-500 hover:bg-gray-100'}`}>
                  {key === 'all' ? 'すべて' : key === 'pending' ? '職長待ち' : key === 'foreman_approved' ? '最終承認待ち' : key === 'approved' ? '承認済み' : '却下'}
                  {key === 'pending' && leaveRequests.filter(r => r.status === 'pending').length > 0 && (
                    <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5">{leaveRequests.filter(r => r.status === 'pending').length}</span>
                  )}
                  {key === 'foreman_approved' && leaveRequests.filter(r => r.status === 'foreman_approved').length > 0 && (
                    <span className="ml-1 bg-orange-500 text-white text-[10px] rounded-full px-1.5">{leaveRequests.filter(r => r.status === 'foreman_approved').length}</span>
                  )}
                </button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center text-gray-400">申請はありません</div>
            ) : (
              <div className="space-y-3">
                {filtered.map(req => (
                  <div key={req.id} className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border p-4 ${req.status === 'pending' ? 'border-yellow-300' : req.status === 'foreman_approved' ? 'border-blue-300' : 'border-gray-200 dark:border-gray-700'}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-bold text-hibi-navy dark:text-white">{req.workerName}</span>
                          <span className="text-gray-600 dark:text-gray-300 font-medium">{fmtDate(req.date)}</span>
                          <span className="text-xs text-gray-400">{getSiteName(req.siteId)}</span>
                        </div>
                        {req.reason && <div className="text-xs text-gray-500 mb-1">理由: {req.reason}</div>}
                        <div className="text-[10px] text-gray-400">
                          申請: {fmtTs(req.requestedAt)}
                          {req.foremanApprovedAt && ` / 職長承認: ${fmtTs(req.foremanApprovedAt)}`}
                          {req.reviewedAt ? ` / 最終承認: ${fmtTs(req.reviewedAt)}` : ''}
                        </div>
                        {req.status === 'rejected' && req.rejectedReason && <div className="text-[10px] text-red-500 mt-1">却下理由: {req.rejectedReason}</div>}
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        {req.status === 'pending' && (
                          <>
                            <button onClick={() => handleForemanApprove(req.id)} disabled={processingReq === req.id}
                              className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">職長承認</button>
                            <button onClick={() => rejectingId === req.id ? handleReject(req.id) : (setRejectingId(req.id), setRejectReason(''))}
                              disabled={processingReq === req.id}
                              className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                          </>
                        )}
                        {req.status === 'foreman_approved' && (
                          <>
                            <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">職長済</span>
                            <button onClick={() => handleApprove(req.id)} disabled={processingReq === req.id}
                              className="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">最終承認</button>
                            <button onClick={() => rejectingId === req.id ? handleReject(req.id) : (setRejectingId(req.id), setRejectReason(''))}
                              disabled={processingReq === req.id}
                              className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                          </>
                        )}
                        {req.status === 'approved' && <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold">承認済</span>}
                        {req.status === 'rejected' && <span className="px-2 py-1 bg-red-100 text-red-600 rounded-full text-xs font-bold">却下</span>}
                      </div>
                    </div>
                    {rejectingId === req.id && (
                      <div className="mt-3 flex items-center gap-2 border-t pt-3">
                        <input type="text" value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="却下理由（任意）"
                          className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-1.5 text-sm" />
                        <button onClick={() => handleReject(req.id)} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-bold">却下する</button>
                        <button onClick={() => setRejectingId(null)} className="px-2 py-1.5 bg-gray-200 text-gray-600 rounded-lg text-xs">取消</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── 一覧タブ ── */}
      {activeTab === 'list' && (<>

      {/* Auto-granted banner */}
      {autoGranted.length > 0 && !autoGrantDismissed && (
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-300 dark:border-green-700 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-green-600 text-lg">&#10003;</span>
            <span className="text-green-800 dark:text-green-200 text-sm font-medium">
              自動付与: {autoGranted.map(g => `${g.name} ${g.days}日`).join('、')}
            </span>
          </div>
          <button onClick={() => setAutoGrantDismissed(true)}
            className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-200 text-sm">
            &#x2715;
          </button>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-hibi-navy">{eligible}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">対象人数</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{totalRemaining}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">有給残日数</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{totalUsed}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">消化日数</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className={`text-2xl font-bold ${alertCount > 0 ? 'text-red-500' : 'text-green-600'}`}>{alertCount}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">残3日以下</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
          <div className={`text-2xl font-bold ${fiveDayAlertCount > 0 ? 'text-red-500' : 'text-green-600'}`}>{fiveDayAlertCount}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">年5日未達</div>
        </div>
      </div>

      {/* 年5日取得義務 警告 */}
      {fiveDayAlertCount > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
          <div className="text-sm font-bold text-red-700 dark:text-red-400 mb-2">
            年5日取得義務（労基法第39条第7項）
          </div>
          <div className="text-xs text-red-600 dark:text-red-400 mb-2">
            年10日以上付与された労働者は、付与日から1年以内に5日以上取得させる義務があります。
          </div>
          <div className="flex flex-wrap gap-2">
            {filteredWorkers.filter(w => w.fiveDayShortfall > 0).map(w => (
              <span key={w.id} className="text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-2 py-1 rounded-full">
                {w.name}（あと{w.fiveDayShortfall}日）
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Company-wide consumption rate bar */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">全社消化率</span>
          <span className="text-sm font-bold text-gray-700 dark:text-gray-300">{fmtPct(companyRate)}（{totalUsed}/{totalTotal}日）</span>
        </div>
        <div className="w-full h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${rateBarColor(companyRate)} transition-all`}
            style={{ width: `${Math.min(100, companyRate)}%` }}
          />
        </div>
      </div>

      {/* Table */}
      {/* === リデザイン: 8列構成・固定行高・ステータスドット === */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide">
              <th className="px-3 py-3 font-semibold" style={{ width: '2%' }}></th>
              <th className="px-3 py-3 font-semibold">スタッフ</th>
              <th className="px-3 py-3 font-semibold">有給の内訳</th>
              <th className="px-3 py-3 font-semibold">消化</th>
              <th className="px-3 py-3 font-semibold text-right">残日数</th>
              <th className="px-3 py-3 font-semibold">警告</th>
              <th className="px-3 py-3 font-semibold text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">読み込み中...</td></tr>
            ) : filteredWorkers.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">対象者がいません</td></tr>
            ) : filteredWorkers.map(w => {
              const rate = w.total > 0 ? (w.used / w.total * 100) : 0
              const hasCarryOver = (w.carryOverRemaining ?? 0) > 0 && !!w.carryOverExpiryDate
              // ── 総合ステータス判定 (🟢 ok / 🟡 注意 / 🔴 警告) ──
              let statusColor = 'bg-emerald-500'
              let statusLabel = '正常'
              if (w.expiryStatus === 'expired' || w.carryOverExpiryStatus === 'expired' || w.fiveDayShortfall > 0) {
                statusColor = 'bg-red-500'
                statusLabel = '要対応'
              } else if (w.remaining <= 3 || w.carryOverExpiryStatus === 'warning' || w.expiryStatus === 'warning') {
                statusColor = 'bg-amber-500'
                statusLabel = '注意'
              }
              const visaLabel = !w.visa || w.visa === 'none' ? '' :
                w.visa === 'jisshu1' ? '実習1号' :
                w.visa === 'jisshu2' ? '実習2号' :
                w.visa === 'jisshu3' ? '実習3号' :
                w.visa === 'tokutei1' ? '特定1号' :
                w.visa === 'tokutei2' ? '特定2号' :
                w.visa === 'tokutei3' ? '特定3号' :
                w.visa
              return (
                <tr key={w.id}
                  className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer transition"
                  onClick={() => { setEditWorker(w); setEditForm({ grantDays: String(w.grantDays), carryOver: String(w.carryOver), adjustment: String(w.adjustment), grantDate: w.grantDate || '' }) }}
                >
                  {/* Status dot */}
                  <td className="pl-3 pr-0">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor}`} title={statusLabel}></span>
                  </td>
                  {/* スタッフ: 固定幅カラムで各要素を縦方向に揃える */}
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        {/* 名前: 固定幅160px */}
                        <div className="w-[160px] flex-shrink-0 truncate" title={w.name}>
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{w.name}</span>
                        </div>
                        {/* 所属バッジ: 固定幅48px */}
                        <div className="w-[44px] flex-shrink-0">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${w.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                            {w.org === 'hfu' ? 'HFU' : '日比'}
                          </span>
                        </div>
                        {/* ビザ: 固定幅72px */}
                        <div className="w-[72px] flex-shrink-0">
                          {visaLabel && (
                            <span className="text-[10px] text-gray-500">{visaLabel}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {w.grantDate ? `付与日 ${w.grantDate}` : '付与日未設定'}
                        {w.inferredFromDefault && <span className="ml-1 text-blue-500">💡推定</span>}
                      </div>
                    </div>
                  </td>
                  {/* 有給の内訳: バケット毎に [ラベル | 日数 | 時効] を1行で表示 (FIFO 順: 繰越 → 当期) */}
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      {/* 繰越バケット（あれば表示） */}
                      {hasCarryOver && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`px-1.5 py-0.5 rounded font-medium text-[10px] whitespace-nowrap ${
                            w.carryOverExpiryStatus === 'expired' ? 'bg-red-100 text-red-700'
                            : w.carryOverExpiryStatus === 'warning' ? 'bg-orange-100 text-orange-700'
                            : 'bg-blue-100 text-blue-700'
                          }`}>
                            {w.carryOverExpiryStatus === 'warning' && '⏰ '}繰越
                          </span>
                          <span className="tabular-nums font-medium text-gray-700 dark:text-gray-200 min-w-[32px] text-right">
                            {w.carryOverRemaining}<span className="text-[10px] text-gray-400 ml-0.5">日</span>
                          </span>
                          <span className={`text-[10px] tabular-nums ${
                            w.carryOverExpiryStatus === 'warning' ? 'text-orange-600 font-semibold' : 'text-gray-400'
                          }`}>
                            〜{w.carryOverExpiryDate}
                          </span>
                        </div>
                      )}
                      {/* 当期バケット */}
                      {w.grantDays > 0 && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`px-1.5 py-0.5 rounded font-medium text-[10px] whitespace-nowrap ${
                            w.expiryStatus === 'expired' ? 'bg-red-100 text-red-700'
                            : w.expiryStatus === 'warning' ? 'bg-orange-100 text-orange-700'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                          }`}>
                            当期
                          </span>
                          <span className="tabular-nums font-medium text-gray-700 dark:text-gray-200 min-w-[32px] text-right">
                            {w.grantRemaining ?? w.grantDays}<span className="text-[10px] text-gray-400 ml-0.5">日</span>
                          </span>
                          <span className={`text-[10px] tabular-nums ${
                            w.expiryStatus === 'expired' ? 'text-red-600 font-semibold'
                            : w.expiryStatus === 'warning' ? 'text-orange-600 font-semibold'
                            : 'text-gray-400'
                          }`}>
                            〜{w.expiryStatus === 'expired' ? '期限切れ' : w.expiryDate}
                          </span>
                        </div>
                      )}
                      {/* 調整がある場合のみ副次情報として */}
                      {w.adjustment > 0 && (
                        <div className="text-[10px] text-gray-400">
                          調整 {w.adjustment}日
                        </div>
                      )}
                    </div>
                  </td>
                  {/* 消化: バー + 数値 */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${rateBarColor(rate)} transition-all`}
                          style={{ width: `${Math.min(100, rate)}%` }}
                        />
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap tabular-nums">
                        <span className="font-medium">{w.used}</span><span className="text-gray-400">/{w.total}</span>
                      </div>
                    </div>
                  </td>
                  {/* 残日数: 大きく表示 */}
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={`text-2xl font-bold ${w.remaining <= 3 ? 'text-red-500' : w.remaining <= 5 ? 'text-amber-500' : 'text-gray-800 dark:text-gray-100'}`}>
                      {w.remaining}
                    </span>
                    <span className="text-[10px] text-gray-400 ml-0.5">日</span>
                  </td>
                  {/* 警告: 年5日未達 等 */}
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {w.fiveDayShortfall > 0 && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold" title="年5日取得義務未達">
                          5日未達
                        </span>
                      )}
                      {w.expiryStatus === 'expired' && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
                          期限切れ
                        </span>
                      )}
                      {w.carryOverExpiryStatus === 'warning' && (
                        <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-bold" title="繰越分の時効間近">
                          繰越3ヶ月
                        </span>
                      )}
                    </div>
                  </td>
                  {/* 操作 */}
                  <td className="px-3 py-2 text-right">
                    <button onClick={e => {
                      e.stopPropagation()
                      setEditWorker(w); setEditForm({ grantDays: String(w.grantDays), carryOver: String(w.carryOver), adjustment: String(w.adjustment), grantDate: w.grantDate || '' })
                    }} className="text-hibi-navy dark:text-blue-400 text-xs hover:underline px-2 py-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30">編集</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-4 pl-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>正常</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block"></span>注意（残≤5日/時効3ヶ月以内）</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>要対応（期限切れ/年5日未達）</span>
        <span className="ml-auto text-gray-400">行をクリックで編集</span>
      </div>

      </>)}

      {/* ── 月別タブ ── */}
      {activeTab === 'monthly' && (() => {
        // 全ワーカーのmonthlyUsageからユニークな月を収集
        const allMonths = new Set<string>()
        filteredWorkers.forEach(w => {
          if (w.monthlyUsage) Object.keys(w.monthlyUsage).forEach(m => allMonths.add(m))
        })
        const months = [...allMonths].sort()
        const workersWithUsage = filteredWorkers.filter(w => w.monthlyUsage && Object.keys(w.monthlyUsage).length > 0)
        if (months.length === 0 || workersWithUsage.length === 0) return null

        return (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
            <h2 className="text-base font-bold text-hibi-navy dark:text-white mb-3">月別 有給取得日数</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700">
                    <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b sticky left-0 bg-gray-50 dark:bg-gray-700 z-10">名前</th>
                    {months.map(m => (
                      <th key={m} className="px-2 py-2 text-center font-medium text-gray-600 dark:text-gray-300 border-b whitespace-nowrap">
                        {m.slice(0, 4)}/{m.slice(4)}月
                      </th>
                    ))}
                    <th className="px-3 py-2 text-center font-bold text-gray-700 dark:text-gray-200 border-b border-l-2 border-gray-300">計</th>
                  </tr>
                </thead>
                <tbody>
                  {workersWithUsage.map(w => {
                    const total = Object.values(w.monthlyUsage).reduce((s, n) => s + n, 0)
                    return (
                      <tr key={w.id} className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-3 py-2 font-medium whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800 z-10">{w.name}</td>
                        {months.map(m => {
                          const val = w.monthlyUsage[m] || 0
                          return (
                            <td key={m} className={`px-2 py-2 text-center tabular-nums ${val > 0 ? 'font-bold text-green-700' : 'text-gray-300'}`}>
                              {val > 0 ? val : '-'}
                            </td>
                          )
                        })}
                        <td className="px-3 py-2 text-center font-bold tabular-nums border-l-2 border-gray-300 text-hibi-navy">{total}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}

      {/* ── カレンダータブ ── */}
      {activeTab === 'calendar' && (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
        <h2 className="text-base font-bold text-hibi-navy dark:text-white mb-3">PLカレンダー</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {calendarMonths.map(({ year, month, label }) => {
            const daysInMonth = new Date(year, month, 0).getDate()
            const firstDow = new Date(year, month - 1, 1).getDay() // 0=Sun
            const ym = `${year}${String(month).padStart(2, '0')}`

            return (
              <div key={ym} className="border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                <div className="text-xs font-bold text-center text-gray-700 dark:text-gray-300 mb-1">{label}</div>
                {/* Day of week header */}
                <div className="grid grid-cols-7 gap-px text-center">
                  {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (
                    <div key={d} className={`text-[9px] font-medium h-4 leading-4 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}`}>{d}</div>
                  ))}
                  {/* Empty cells before first day */}
                  {Array.from({ length: firstDow }).map((_, i) => (
                    <div key={`e${i}`} className="h-6" />
                  ))}
                  {/* Day cells */}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1
                    const dateKey = `${ym}${String(day).padStart(2, '0')}`
                    const dow = new Date(year, month - 1, day).getDay()
                    const isHoliday = holidays.has(dateKey)
                    const plWorkers = plCalendar[dateKey] || []
                    const hasPL = plWorkers.length > 0

                    let bgClass = ''
                    if (hasPL) bgClass = 'bg-yellow-200'
                    else if (dow === 0 || isHoliday) bgClass = 'bg-red-50'
                    else if (dow === 6) bgClass = 'bg-blue-50'

                    const textClass = isHoliday ? 'text-red-500' : dow === 0 ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-gray-700'

                    return (
                      <div
                        key={day}
                        className={`h-6 w-full flex items-center justify-center relative cursor-default rounded-sm ${bgClass}`}
                        onMouseEnter={(e) => {
                          if (hasPL) {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setCalendarTooltip({ dateKey, x: rect.left + rect.width / 2, y: rect.top })
                          }
                        }}
                        onMouseLeave={() => setCalendarTooltip(null)}
                        onClick={() => {
                          if (hasPL) {
                            setCalendarTooltip(prev =>
                              prev?.dateKey === dateKey ? null : { dateKey, x: 0, y: 0 }
                            )
                          }
                        }}
                      >
                        <span className={`text-[10px] leading-none ${textClass}`}>{day}</span>
                        {hasPL && (
                          <span className="absolute -top-0.5 -right-0.5 bg-orange-500 text-white text-[7px] rounded-full w-3 h-3 flex items-center justify-center font-bold leading-none">
                            {plWorkers.length}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      )}

      {/* Calendar tooltip */}
      {calendarTooltip && plCalendar[calendarTooltip.dateKey] && (
        <div
          className="fixed z-50 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none"
          style={{
            left: calendarTooltip.x > 0 ? `${calendarTooltip.x}px` : '50%',
            top: calendarTooltip.x > 0 ? `${calendarTooltip.y - 8}px` : '50%',
            transform: calendarTooltip.x > 0 ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)',
          }}
        >
          <div className="font-bold mb-1">
            {calendarTooltip.dateKey.replace(/(\d{4})(\d{2})(\d{2})/, '$1/$2/$3')} 有給取得
          </div>
          {plCalendar[calendarTooltip.dateKey].map(wid => (
            <div key={wid}>{workerNames[wid] || `ID:${wid}`}</div>
          ))}
        </div>
      )}

      {/* ── 帰国情報タブ (旧 home-leave ページから統合) ── */}
      {activeTab === 'homeleave' && (() => {
        // 計算ヘルパー
        const today = new Date().toISOString().slice(0, 10)
        const fmt = (s: string) => {
          const d = new Date(s + 'T00:00:00')
          return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
        }
        const daysBetween = (s: string, e: string) => {
          const sd = new Date(s + 'T00:00:00')
          const ed = new Date(e + 'T00:00:00')
          return Math.ceil((ed.getTime() - sd.getTime()) / (24 * 60 * 60 * 1000)) + 1
        }
        const currentLeaves = homeLeaves.filter(h => h.startDate <= today && h.endDate >= today)
          .sort((a, b) => a.endDate.localeCompare(b.endDate))
        const upcomingLeaves = homeLeaves.filter(h => h.startDate > today)
          .sort((a, b) => a.startDate.localeCompare(b.startDate))
        const pastLeaves = homeLeaves.filter(h => h.endDate < today)
          .sort((a, b) => b.endDate.localeCompare(a.endDate))

        // 操作ハンドラ
        const handleHlAdd = async () => {
          if (!hlFormWorkerId || !hlFormStart || !hlFormEnd) return
          setHlSaving(true)
          try {
            const w = workers.find(w => w.id === Number(hlFormWorkerId))
            const res = await fetch('/api/home-leave', {
              method: 'POST',
              headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'create',
                workerId: Number(hlFormWorkerId),
                workerName: w?.name || '',
                startDate: hlFormStart,
                endDate: hlFormEnd,
                reason: hlFormReason,
                note: hlFormNote,
              }),
            })
            if (res.ok) {
              setHlFormOpen(false)
              setHlFormWorkerId('')
              setHlFormStart('')
              setHlFormEnd('')
              setHlFormReason('一時帰国')
              setHlFormNote('')
              fetchData()
            }
          } finally { setHlSaving(false) }
        }
        const startHlEdit = (h: HomeLeave) => {
          setHlEditingId(h.id)
          setHlEditStart(h.startDate)
          setHlEditEnd(h.endDate)
          setHlEditReason(h.reason)
          setHlEditNote(h.note || '')
        }
        const cancelHlEdit = () => {
          setHlEditingId(null)
        }
        const handleHlUpdate = async (id: string) => {
          setHlSaving(true)
          try {
            const res = await fetch('/api/home-leave', {
              method: 'POST',
              headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'update',
                id,
                startDate: hlEditStart,
                endDate: hlEditEnd,
                reason: hlEditReason,
                note: hlEditNote,
              }),
            })
            if (res.ok) {
              cancelHlEdit()
              fetchData()
            }
          } finally { setHlSaving(false) }
        }
        const handleHlDelete = async (id: string) => {
          setHlSaving(true)
          try {
            const res = await fetch('/api/home-leave', {
              method: 'POST',
              headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', id }),
            })
            if (res.ok) {
              setHlDeleteConfirm(null)
              fetchData()
            }
          } finally { setHlSaving(false) }
        }

        const renderHlCard = (h: HomeLeave, section: 'current' | 'upcoming') => {
          const totalDays = daysBetween(h.startDate, h.endDate)
          const dayMs = 24 * 60 * 60 * 1000
          const todayD = new Date(today + 'T00:00:00')
          const startD = new Date(h.startDate + 'T00:00:00')
          const endD = new Date(h.endDate + 'T00:00:00')
          const daysRemaining = Math.ceil((endD.getTime() - todayD.getTime()) / dayMs)
          const daysUntilDeparture = Math.ceil((startD.getTime() - todayD.getTime()) / dayMs)

          if (hlEditingId === h.id) {
            return (
              <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-blue-300 dark:border-blue-600">
                <div className="font-semibold mb-3 text-gray-900 dark:text-white">{h.workerName}</div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">出発日</label>
                    <input type="date" value={hlEditStart} onChange={e => setHlEditStart(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">帰国日</label>
                    <input type="date" value={hlEditEnd} onChange={e => setHlEditEnd(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                </div>
                <div className="mb-3">
                  <label className="block text-xs text-gray-500 mb-1">理由</label>
                  <select value={hlEditReason} onChange={e => setHlEditReason(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    {['一時帰国', 'ビザ更新帰国', 'その他'].map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="mb-3">
                  <label className="block text-xs text-gray-500 mb-1">備考</label>
                  <textarea value={hlEditNote} onChange={e => setHlEditNote(e.target.value)} rows={2}
                    className="w-full px-2 py-1.5 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleHlUpdate(h.id)} disabled={hlSaving}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">保存</button>
                  <button onClick={cancelHlEdit}
                    className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded">キャンセル</button>
                </div>
              </div>
            )
          }

          return (
            <div key={h.id} className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-gray-900 dark:text-white">{h.workerName}</div>
                {section === 'current' && (
                  <span className="text-xs px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full">
                    帰国まで {daysRemaining}日
                  </span>
                )}
                {section === 'upcoming' && (
                  <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">
                    出発まで {daysUntilDeparture}日
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
                <div>{fmt(h.startDate)} 〜 {fmt(h.endDate)} <span className="text-gray-400 ml-2">({totalDays}日間)</span></div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {h.reason}{h.note && <span className="ml-2">- {h.note}</span>}
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => startHlEdit(h)}
                  className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200">編集</button>
                {hlDeleteConfirm === h.id ? (
                  <div className="flex gap-1">
                    <button onClick={() => handleHlDelete(h.id)} disabled={hlSaving}
                      className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">削除する</button>
                    <button onClick={() => setHlDeleteConfirm(null)}
                      className="px-3 py-1 text-xs bg-gray-200 text-gray-700 rounded">やめる</button>
                  </div>
                ) : (
                  <button onClick={() => setHlDeleteConfirm(h.id)}
                    className="px-3 py-1 text-xs bg-red-50 dark:bg-red-900/20 text-red-600 rounded hover:bg-red-100">削除</button>
                )}
              </div>
            </div>
          )
        }

        return (
          <div className="space-y-6 max-w-2xl">
            {/* 新規登録 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow">
              <button onClick={() => setHlFormOpen(!hlFormOpen)}
                className="w-full px-4 py-3 flex items-center justify-between text-left">
                <span className="font-medium text-gray-900 dark:text-white">＋ 新規登録</span>
                <span className="text-gray-400 text-lg">{hlFormOpen ? '−' : '＋'}</span>
              </button>
              {hlFormOpen && (
                <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700 pt-3">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">スタッフ</label>
                    <select value={hlFormWorkerId}
                      onChange={e => setHlFormWorkerId(e.target.value ? Number(e.target.value) : '')}
                      className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                      <option value="">選択してください</option>
                      {workers.filter(w => w.visa && w.visa !== 'none').map(w => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">出発日</label>
                      <input type="date" value={hlFormStart} onChange={e => setHlFormStart(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">帰国日</label>
                      <input type="date" value={hlFormEnd} onChange={e => setHlFormEnd(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">理由</label>
                    <select value={hlFormReason} onChange={e => setHlFormReason(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                      {['一時帰国', 'ビザ更新帰国', 'その他'].map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">備考</label>
                    <textarea value={hlFormNote} onChange={e => setHlFormNote(e.target.value)} rows={2} placeholder="任意"
                      className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                  <button onClick={handleHlAdd}
                    disabled={hlSaving || !hlFormWorkerId || !hlFormStart || !hlFormEnd}
                    className="w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
                    {hlSaving ? '登録中...' : '登録する'}
                  </button>
                </div>
              )}
            </div>

            {/* 現在帰国中 */}
            <div>
              <div className="border-l-4 border-red-500 pl-3 mb-3">
                <h2 className="font-bold text-gray-900 dark:text-white">
                  現在帰国中
                  {currentLeaves.length > 0 && (
                    <span className="ml-2 text-sm font-normal text-red-600">({currentLeaves.length}名)</span>
                  )}
                </h2>
              </div>
              {currentLeaves.length === 0 ? (
                <div className="text-sm text-gray-400 pl-7">現在帰国中のスタッフはいません</div>
              ) : (
                <div className="space-y-3">{currentLeaves.map(h => renderHlCard(h, 'current'))}</div>
              )}
            </div>

            {/* 帰国予定 */}
            <div>
              <div className="border-l-4 border-blue-500 pl-3 mb-3">
                <h2 className="font-bold text-gray-900 dark:text-white">
                  帰国予定
                  {upcomingLeaves.length > 0 && (
                    <span className="ml-2 text-sm font-normal text-blue-600">({upcomingLeaves.length}件)</span>
                  )}
                </h2>
              </div>
              {upcomingLeaves.length === 0 ? (
                <div className="text-sm text-gray-400 pl-7">帰国予定はありません</div>
              ) : (
                <div className="space-y-3">{upcomingLeaves.map(h => renderHlCard(h, 'upcoming'))}</div>
              )}
            </div>

            {/* 過去履歴 */}
            <div>
              <div className="border-l-4 border-gray-300 pl-3 mb-3">
                <button onClick={() => setHlShowPast(!hlShowPast)}
                  className="font-bold text-gray-600 dark:text-gray-400 flex items-center gap-2">
                  過去の帰国履歴
                  {pastLeaves.length > 0 && <span className="text-sm font-normal">({pastLeaves.length}件)</span>}
                  <span className="text-sm">{hlShowPast ? '▲' : '▼'}</span>
                </button>
              </div>
              {hlShowPast && (pastLeaves.length === 0 ? (
                <div className="text-sm text-gray-400 pl-7">過去の帰国履歴はありません</div>
              ) : (
                <div className="space-y-2">
                  {pastLeaves.map(h => (
                    <div key={h.id} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-700 dark:text-gray-300">{h.workerName}</span>
                        <span className="text-xs text-gray-400">{h.reason}</span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {fmt(h.startDate)} 〜 {fmt(h.endDate)} <span className="ml-2">({daysBetween(h.startDate, h.endDate)}日間)</span>
                      </div>
                      {h.note && <div className="text-xs text-gray-400 mt-1">{h.note}</div>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Grant Modal */}
      {showGrantModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowGrantModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">有給付与</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">対象者</label>
                <select value={grantForm.workerId} onChange={e => setGrantForm({ ...grantForm, workerId: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                  <option value="">選択してください</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}（{w.org === 'hfu' ? 'HFU' : '日比'}）</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日</label>
                <input type="date" value={grantForm.grantDate} onChange={e => setGrantForm({ ...grantForm, grantDate: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
              </div>
              {/* Legal PL auto-calculation display */}
              {grantForm.workerId && (() => {
                const w = workers.find(w => w.id === Number(grantForm.workerId))
                if (!w) return null
                const autoMonth = w.grantMonth || calcGrantMonthFromHire(w.hireDate)
                return (
                  <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 space-y-1">
                    <div className="text-xs font-bold text-blue-800 dark:text-blue-300">自動計算プレビュー</div>
                    <div className="text-xs text-blue-700 dark:text-blue-400">
                      {w.name}: 入社{w.hireDate || '不明'}
                      {autoMonth ? ` → 発生月${autoMonth}月` : ''}
                      {legalPLInfo && legalPLInfo.years !== undefined ? ` → 勤続${legalPLInfo.years}年${legalPLInfo.months}月` : ''}
                      {legalPLInfo && legalPLInfo.days > 0 ? ` → 法定${legalPLInfo.days}日` : ''}
                    </div>
                  </div>
                )
              })()}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日数</label>
                <input type="number" value={grantForm.grantDays} onChange={e => setGrantForm({ ...grantForm, grantDays: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">発生月</label>
                <select value={grantForm.grantMonth} onChange={e => setGrantForm({ ...grantForm, grantMonth: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                  <option value="">未設定</option>
                  {[10,11,12,1,2,3,4,5,6,7,8,9].map(m => <option key={m} value={m}>{m}月</option>)}
                </select>
              </div>
              {/* Expiry preview */}
              {grantForm.grantDate && (
                <div className="text-xs text-gray-500">
                  有効期限: {(() => {
                    const gd = new Date(grantForm.grantDate)
                    if (isNaN(gd.getTime())) return '—'
                    const exp = new Date(gd)
                    exp.setFullYear(exp.getFullYear() + 2)
                    exp.setDate(exp.getDate() - 1)
                    return `${exp.getFullYear()}/${String(exp.getMonth() + 1).padStart(2, '0')}/${String(exp.getDate()).padStart(2, '0')}`
                  })()}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={handleGrant} disabled={saving}
                className="flex-1 bg-green-600 text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
                {saving ? '処理中...' : '付与'}
              </button>
              <button onClick={() => { setShowGrantModal(false); setLegalPLInfo(null) }}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditWorker(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">{editWorker.name} - 有給編集</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  付与日（有給サイクルの開始日）
                </label>
                <input type="date" value={editForm.grantDate}
                  onChange={e => setEditForm({ ...editForm, grantDate: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
                {editWorker.inferredFromDefault && (
                  <p className="text-[10px] text-blue-600 mt-1">
                    💡 日本人社員のデフォルト「10/1〜9/30」を自動適用中。明示的に保存すると確定します。
                  </p>
                )}
                <p className="text-[10px] text-gray-400 mt-1">
                  日本人社員は決算期に合わせて毎年10/1付与（10/1〜9/30）がデフォルトです。<br/>
                  個別に変更したい場合のみ日付を選び直してください。
                </p>
                {editForm.grantDate && (() => {
                  const gd = new Date(editForm.grantDate)
                  const end = new Date(gd); end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1)
                  const expiry = new Date(gd); expiry.setFullYear(expiry.getFullYear() + 2); expiry.setDate(expiry.getDate() - 1)
                  const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
                  return (
                    <div className="text-[10px] text-gray-500 mt-1">
                      期間: {fmt(gd)} 〜 {fmt(end)} / 当期付与の有効期限: {fmt(expiry)}
                    </div>
                  )
                })()}

                {/* Phase 8: FIFO内訳表示 */}
                {((editWorker.carryOverRemaining ?? 0) > 0 || (editWorker.grantRemaining ?? 0) > 0) && (
                  <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
                    <div className="text-[11px] font-bold text-blue-800 dark:text-blue-200 mb-1">
                      📊 残日数の内訳（FIFO：繰越分から先に消費）
                    </div>
                    <div className="space-y-1">
                      {(editWorker.carryOverRemaining ?? 0) > 0 && (
                        <div className={`text-[11px] ${editWorker.carryOverExpiryStatus === 'warning' ? 'text-orange-700 dark:text-orange-300 font-bold' : editWorker.carryOverExpiryStatus === 'expired' ? 'text-red-700 dark:text-red-300 font-bold' : 'text-blue-700 dark:text-blue-300'}`}>
                          {editWorker.carryOverExpiryStatus === 'warning' && '⏰ '}
                          {editWorker.carryOverExpiryStatus === 'expired' && '❌ '}
                          繰越分: <strong>{editWorker.carryOverRemaining}日</strong>
                          {editWorker.carryOverExpiryDate && <span className="ml-1 text-[10px]">（時効: {editWorker.carryOverExpiryDate}）</span>}
                          {editWorker.carryOverExpiryStatus === 'warning' && <span className="ml-1 text-[10px]">← 時効間近・優先消化推奨</span>}
                        </div>
                      )}
                      {(editWorker.grantRemaining ?? 0) > 0 && (
                        <div className="text-[11px] text-blue-700 dark:text-blue-300">
                          当期付与: <strong>{editWorker.grantRemaining}日</strong>
                          {editWorker.grantExpiryDate && <span className="ml-1 text-[10px]">（時効: {editWorker.grantExpiryDate}）</span>}
                        </div>
                      )}
                      <div className="text-[10px] text-gray-500 dark:text-gray-400 pt-1 border-t border-blue-200 dark:border-blue-700/30">
                        合計残: {(editWorker.carryOverRemaining ?? 0) + (editWorker.grantRemaining ?? 0)}日
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">付与日数</label>
                <input type="number" value={editForm.grantDays} onChange={e => setEditForm({ ...editForm, grantDays: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
              </div>
              {(() => {
                const isJp = !editWorker.visa || editWorker.visa === 'none'
                if (isJp) {
                  return (
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">繰越日数</label>
                      <input type="number" value="0" disabled
                        className="w-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-400 rounded-lg px-3 py-2 text-sm cursor-not-allowed" />
                      <p className="text-[10px] text-gray-500 mt-1">
                        💼 日本人社員は期末買取制のため繰越なし（強制0）
                      </p>
                    </div>
                  )
                }
                return (
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">繰越日数</label>
                    <input type="number" value={editForm.carryOver} onChange={e => setEditForm({ ...editForm, carryOver: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
                  </div>
                )
              })()}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  調整（過去の消化分など、カレンダー外で計上したい日数）
                </label>
                <input type="number" value={editForm.adjustment} onChange={e => setEditForm({ ...editForm, adjustment: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
              </div>

              {/* 操作ボタン (Phase 5/6/B) */}
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => {
                  setDesignateWorker(editWorker)
                  setDesignateKind('manual-entry')
                  setDesignateDates([''])
                  setDesignateSiteId(sites[0]?.id || '')
                  setDesignateNote('帰国期間中の有給申請を後から計上')
                  setDesignateOverwriteHomeLeave(true)  // デフォルトON（このボタンは主に帰国期間中対応）
                }} className="flex-1 bg-indigo-500 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-indigo-600"
                  title="帰国期間中などにPを後から入力する場合">
                  🗓 有給日を直接入力
                </button>
                <button type="button" onClick={() => {
                  setBuyoutWorker(editWorker)
                  setBuyoutForm({ days: '', amount: '', reason: (!editWorker.visa || editWorker.visa === 'none') ? 'year-end' : 'retirement' })
                }} className="flex-1 bg-amber-500 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-amber-600">
                  💰 買取を記録
                </button>
              </div>

              {/* 買取履歴 */}
              {editWorker.buyoutHistory && editWorker.buyoutHistory.length > 0 && (
                <div className="mt-2 p-2 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
                  <div className="text-[10px] font-bold text-amber-800 dark:text-amber-200 mb-1">
                    💰 買取記録（累計 {editWorker.buyoutDays || 0}日）
                  </div>
                  <div className="space-y-0.5 max-h-20 overflow-auto">
                    {editWorker.buyoutHistory.slice().reverse().map((h, i) => (
                      <div key={i} className="text-[10px] text-amber-700 dark:text-amber-300">
                        {new Date(h.at).toLocaleDateString('ja-JP')}: {h.days}日
                        {h.amount ? ` (¥${h.amount.toLocaleString()})` : ''}
                        {h.reason === 'year-end' ? ' 期末買取' : h.reason === 'retirement' ? ' 退職清算' : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 監査情報セクション */}
              {(editWorker.grantedAt || editWorker.method || (editWorker.adjustmentHistory && editWorker.adjustmentHistory.length > 0)) && (
                <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
                  <div className="text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-2">📋 監査情報</div>
                  {editWorker.method && (
                    <div className="text-[10px] text-gray-500 dark:text-gray-400">
                      付与方法: <span className="font-medium">{
                        editWorker.method === 'manual' ? '手動付与' :
                        editWorker.method === 'auto-pending' ? '半自動付与' :
                        editWorker.method === 'migration' ? 'データ正規化' :
                        editWorker.method === 'legacy' ? '旧データ' :
                        editWorker.method
                      }</span>
                    </div>
                  )}
                  {editWorker.grantedAt && (
                    <div className="text-[10px] text-gray-500 dark:text-gray-400">
                      付与日時: {new Date(editWorker.grantedAt).toLocaleString('ja-JP')}
                      {editWorker.grantedBy !== undefined && ` / 操作者: ${editWorker.grantedBy === 'super-admin' ? '日比靖仁' : editWorker.grantedBy === 'admin' ? '管理者' : `ID ${editWorker.grantedBy}`}`}
                    </div>
                  )}
                  {editWorker.lastEditedAt && editWorker.lastEditedAt !== editWorker.grantedAt && (
                    <div className="text-[10px] text-gray-500 dark:text-gray-400">
                      最終編集: {new Date(editWorker.lastEditedAt).toLocaleString('ja-JP')}
                      {editWorker.lastEditedBy !== undefined && ` / ${editWorker.lastEditedBy === 'super-admin' ? '日比靖仁' : editWorker.lastEditedBy === 'admin' ? '管理者' : `ID ${editWorker.lastEditedBy}`}`}
                    </div>
                  )}
                  {editWorker.adjustmentHistory && editWorker.adjustmentHistory.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-gray-600 dark:text-gray-400 cursor-pointer font-medium">変更履歴 ({editWorker.adjustmentHistory.length}件)</summary>
                      <div className="mt-1 space-y-1 max-h-32 overflow-auto">
                        {editWorker.adjustmentHistory.slice().reverse().map((h, i) => (
                          <div key={i} className="text-[10px] text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 rounded px-2 py-1">
                            <span className="text-gray-400">{new Date(h.at).toLocaleString('ja-JP')}</span>
                            {' '}
                            <span className="font-medium">{h.field}</span>: {h.before} → {h.after}
                            {' '}
                            <span className="text-gray-400">({h.by === 'super-admin' ? '日比靖仁' : h.by === 'admin' ? '管理者' : `ID ${h.by}`})</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-6">
              <button disabled={saving} onClick={async () => {
                setSaving(true)
                try {
                  // 日本人社員は繰越強制0
                  const isJp = !editWorker.visa || editWorker.visa === 'none'
                  const payload = { ...editForm, ...(isJp ? { carryOver: '0' } : {}) }
                  await fetch('/api/leave', {
                    method: 'POST',
                    headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workerId: editWorker.id, fy: editWorker.grantDate ? editWorker.grantDate.slice(0, 4) : String(new Date().getFullYear()), ...payload }),
                  })
                  setEditWorker(null)
                  fetchData()
                } finally { setSaving(false) }
              }} className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditWorker(null)} className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* 買取記録モーダル (Phase 6) */}
      {buyoutWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !buyoutSubmitting && setBuyoutWorker(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-5 animate-modalIn" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-2 mb-4">
              <div className="text-2xl">💰</div>
              <div>
                <h3 className="text-lg font-bold text-hibi-navy dark:text-white">有給買取記録</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {buyoutWorker.name}さん / 現在残 {buyoutWorker.remaining}日
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取理由</label>
                <select value={buyoutForm.reason} onChange={e => setBuyoutForm(prev => ({ ...prev, reason: e.target.value as 'year-end' | 'retirement' | 'other' }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm">
                  <option value="year-end">期末買取（9/30時点）</option>
                  <option value="retirement">退職時清算</option>
                  <option value="other">その他</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取日数</label>
                <input type="number" value={buyoutForm.days} onChange={e => setBuyoutForm(prev => ({ ...prev, days: e.target.value }))}
                  placeholder="例: 5"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
                <p className="text-[10px] text-gray-400 mt-1">※残日数の範囲内で指定</p>
              </div>

              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">買取金額（任意、¥）</label>
                <input type="number" value={buyoutForm.amount} onChange={e => setBuyoutForm(prev => ({ ...prev, amount: e.target.value }))}
                  placeholder="例: 50000"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
              </div>
            </div>

            <div className="mt-4 p-2 bg-amber-50 dark:bg-amber-900/20 rounded text-[10px] text-amber-700 dark:text-amber-300">
              ℹ️ 買取記録はこのレコードの buyoutHistory に追記されます。残日数の表示には影響しないため、別途「調整」欄で消化計上する運用です。
            </div>

            <div className="flex gap-2 mt-4">
              <button
                disabled={buyoutSubmitting || !buyoutForm.days || Number(buyoutForm.days) <= 0}
                onClick={async () => {
                  const days = Number(buyoutForm.days)
                  if (!confirm(`${buyoutWorker.name}さんの有給 ${days}日を買取記録しますか？\n理由: ${buyoutForm.reason === 'year-end' ? '期末買取' : buyoutForm.reason === 'retirement' ? '退職時清算' : 'その他'}${buyoutForm.amount ? `\n金額: ¥${Number(buyoutForm.amount).toLocaleString()}` : ''}`)) return
                  setBuyoutSubmitting(true)
                  try {
                    const currentFy = buyoutWorker.grantDate ? buyoutWorker.grantDate.slice(0, 4) : String(new Date().getFullYear())
                    const res = await fetch('/api/leave', {
                      method: 'POST',
                      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        action: 'recordBuyout',
                        workerId: buyoutWorker.id,
                        fy: currentFy,
                        days,
                        amount: buyoutForm.amount ? Number(buyoutForm.amount) : undefined,
                        reason: buyoutForm.reason,
                      }),
                    })
                    if (res.ok) {
                      setBuyoutWorker(null)
                      setEditWorker(null)
                      fetchData()
                    } else {
                      alert('買取記録に失敗しました')
                    }
                  } finally { setBuyoutSubmitting(false) }
                }}
                className="flex-1 bg-amber-600 text-white rounded-lg py-2 font-bold text-sm disabled:opacity-50">
                {buyoutSubmitting ? '処理中...' : '買取を記録する'}
              </button>
              <button disabled={buyoutSubmitting} onClick={() => setBuyoutWorker(null)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm disabled:opacity-50">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 時季指定モーダル / 管理者手動P入力 */}
      {designateWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !designateSubmitting && setDesignateWorker(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full p-5 animate-modalIn" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-2 mb-4">
              <div className="text-2xl">🗓</div>
              <div>
                <h3 className="text-lg font-bold text-hibi-navy dark:text-white">
                  {designateKind === 'designation' ? '時季指定' : '有給日を直接入力'}
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {designateWorker.name}さん
                  {designateKind === 'designation'
                    ? ` / 消化 ${designateWorker.periodUsed}日 → あと ${designateWorker.fiveDayShortfall}日義務`
                    : ` / 残 ${designateWorker.remaining}日`}
                </p>
                {designateKind === 'manual-entry' && (
                  <p className="text-[10px] text-indigo-600 dark:text-indigo-400 mt-1">
                    ※ 出面に P を直接書き込みます。管理者の手動計上として監査ログに記録されます。
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">指定日（複数可）</label>
                <div className="space-y-1">
                  {designateDates.map((d, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input type="date" value={d}
                        onChange={e => setDesignateDates(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                        className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm" />
                      <button onClick={() => setDesignateDates(prev => prev.filter((_, j) => j !== i))}
                        className="text-red-500 text-sm">×</button>
                    </div>
                  ))}
                  <button onClick={() => setDesignateDates(prev => [...prev, ''])}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    + 日付を追加
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">対象現場</label>
                <select value={designateSiteId} onChange={e => setDesignateSiteId(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm">
                  <option value="">-- 選択してください --</option>
                  {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <p className="text-[10px] text-gray-400 mt-1">出面にPを記録する現場（当日の所属現場）</p>
              </div>

              <div>
                <label className="text-xs text-gray-600 dark:text-gray-400 block mb-1">備考（任意）</label>
                <input type="text" value={designateNote} onChange={e => setDesignateNote(e.target.value)}
                  placeholder={designateKind === 'designation' ? '例: 年5日取得義務対応' : '例: 帰国期間中の有給申請を後から計上'}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm" />
              </div>

              {/* 帰国期間上書きチェック */}
              <div className="flex items-start gap-2 p-2 bg-indigo-50 dark:bg-indigo-900/20 rounded border border-indigo-200 dark:border-indigo-700/50">
                <input type="checkbox" id="overwrite-hk" checked={designateOverwriteHomeLeave}
                  onChange={e => setDesignateOverwriteHomeLeave(e.target.checked)}
                  className="mt-0.5 w-4 h-4 cursor-pointer" />
                <label htmlFor="overwrite-hk" className="text-[11px] text-indigo-800 dark:text-indigo-200 cursor-pointer">
                  <span className="font-bold">帰国期間(✈️)を上書きする</span>
                  <div className="text-[10px] text-indigo-600 dark:text-indigo-400 mt-0.5">
                    既存の帰国マーカーを削除して Pを書き込みます。帰国中でも事前に有給申請があった日を計上する場合に使用。
                  </div>
                </label>
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button
                disabled={designateSubmitting || designateDates.filter(d => !!d).length === 0 || !designateSiteId}
                onClick={async () => {
                  const validDates = designateDates.filter(d => !!d)
                  const label = designateKind === 'designation' ? '時季指定' : '有給として記録'
                  const msg = `${designateWorker.name}さんに以下の日を${label}しますか？\n${validDates.join('\n')}\n\n出面にPが自動入力され、履歴が記録されます。${designateOverwriteHomeLeave ? '\n\n⚠️ 既存の帰国マーカーは削除されます。' : ''}`
                  if (!confirm(msg)) return
                  setDesignateSubmitting(true)
                  try {
                    const res = await fetch('/api/leave', {
                      method: 'POST',
                      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        action: 'designateLeaves',
                        workerId: designateWorker.id,
                        dates: validDates,
                        siteId: designateSiteId,
                        note: designateNote,
                        kind: designateKind,
                        overwriteHomeLeave: designateOverwriteHomeLeave,
                      }),
                    })
                    if (res.ok) {
                      setDesignateWorker(null)
                      setEditWorker(null)
                      fetchData()
                    } else {
                      alert('処理に失敗しました')
                    }
                  } finally { setDesignateSubmitting(false) }
                }}
                className={`flex-1 text-white rounded-lg py-2 font-bold text-sm disabled:opacity-50 ${designateKind === 'designation' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {designateSubmitting ? '処理中...' : (designateKind === 'designation' ? '時季指定する' : '有給を記録する')}
              </button>
              <button disabled={designateSubmitting} onClick={() => setDesignateWorker(null)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm disabled:opacity-50">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending Grants Modal (半自動付与) */}
      {pendingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !pendingExecuting && setPendingModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col animate-modalIn" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-start gap-2">
                <div className="text-2xl">🌴</div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-hibi-navy dark:text-white">有給付与対象 ({pendingGrants.length}名)</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    付与日・日数は各スタッフごとに調整できます。「付与する」のチェックを外すと今回はスキップされます。
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              {pendingGrants.map(p => {
                const f = pendingForm[p.workerId] || { grantDate: p.nextGrantDate, grantDays: String(p.legalDays || 10), include: true }
                const isJp = !p.visa || p.visa === 'none'
                const visaLabel = isJp ? '日本人' : (p.visa === 'jisshu1' ? '実習1号' : p.visa === 'jisshu2' ? '実習2号' : p.visa === 'tokutei1' ? '特定1号' : p.visa === 'tokutei2' ? '特定2号' : p.visa)
                return (
                  <div key={p.workerId} className={`border rounded-lg p-3 ${
                    f.include
                      ? (p.needsAttention ? 'border-red-300 bg-red-50/50 dark:bg-red-900/10' : 'border-amber-300 bg-amber-50/50 dark:bg-amber-900/10')
                      : 'border-gray-200 bg-gray-50 dark:bg-gray-900/50 opacity-60'
                  }`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="font-bold text-sm text-hibi-navy dark:text-white flex items-center gap-1.5">
                          {p.name}
                          {p.needsAttention && <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-md font-normal">⚠️ 要確認</span>}
                        </div>
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {visaLabel} | {p.tenureText} | {p.reason}
                        </div>
                        {p.attentionNote && (
                          <div className="text-[10px] text-red-600 dark:text-red-400 mt-1">
                            ⚠️ {p.attentionNote}
                          </div>
                        )}
                      </div>
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input type="checkbox" checked={f.include}
                          onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, include: e.target.checked } }))}
                          className="w-4 h-4" />
                        <span>付与する</span>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-0.5">付与日</label>
                        <input type="date" value={f.grantDate} disabled={!f.include}
                          onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDate: e.target.value } }))}
                          className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-0.5">付与日数（法定 {p.legalDays}日）</label>
                        <input type="number" value={f.grantDays} disabled={!f.include}
                          onChange={e => setPendingForm(prev => ({ ...prev, [p.workerId]: { ...f, grantDays: e.target.value } }))}
                          className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-xs disabled:opacity-50" />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
              <button
                disabled={pendingExecuting || Object.values(pendingForm).every(f => !f.include)}
                onClick={async () => {
                  setPendingExecuting(true)
                  try {
                    const grants = pendingGrants
                      .filter(p => pendingForm[p.workerId]?.include)
                      .map(p => {
                        const f = pendingForm[p.workerId]
                        const gd = new Date(f.grantDate)
                        const fyYear = gd.getFullYear()
                        return {
                          workerId: p.workerId,
                          fy: String(fyYear),
                          grantDate: f.grantDate,
                          grantDays: Number(f.grantDays) || 0,
                        }
                      })
                      .filter(g => g.grantDays > 0)
                    if (grants.length === 0) return
                    const res = await fetch('/api/leave', {
                      method: 'POST',
                      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'executePendingGrants', grants }),
                    })
                    if (res.ok) {
                      setPendingModal(false)
                      fetchData()
                    } else {
                      alert('付与に失敗しました')
                    }
                  } finally {
                    setPendingExecuting(false)
                  }
                }}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm disabled:opacity-50">
                {pendingExecuting ? '付与中...' : `一括付与する（${Object.values(pendingForm).filter(f => f.include).length}名）`}
              </button>
              <button disabled={pendingExecuting} onClick={() => setPendingModal(false)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm disabled:opacity-50">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

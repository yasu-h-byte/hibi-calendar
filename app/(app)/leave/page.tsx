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
  const [activeTab, setActiveTab] = useState<'list' | 'requests' | 'monthly' | 'calendar'>('list')

  // 半自動付与（未付与検知）
  type PendingGrant = { workerId: number; name: string; visa: string; hireDate: string; tenureText: string; nextGrantDate: string; fy: string; legalDays: number; reason: string }
  const [pendingGrants, setPendingGrants] = useState<PendingGrant[]>([])
  const [pendingModal, setPendingModal] = useState(false)
  const [pendingForm, setPendingForm] = useState<Record<number, { grantDate: string; grantDays: string; include: boolean }>>({})
  const [pendingExecuting, setPendingExecuting] = useState(false)
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

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const [res, reqRes, siteRes, pendRes] = await Promise.all([
        fetch(`/api/leave?calendar=true`, { headers: { 'x-admin-password': password } }),
        fetch('/api/leave-request', { headers: { 'x-admin-password': password } }),
        fetch('/api/sites', { headers: { 'x-admin-password': password } }),
        fetch('/api/leave', {
          method: 'POST',
          headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getPendingGrants' }),
        }),
      ])
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
        // フォーム初期値を作成（デフォルトで全員対象にチェック）
        const form: Record<number, { grantDate: string; grantDays: string; include: boolean }> = {}
        list.forEach(p => {
          form[p.workerId] = {
            grantDate: p.nextGrantDate,
            grantDays: String(p.legalDays || 10),
            include: true,
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
    if (!confirm('繰越自動計算を実行しますか？前年度の残日数を繰越に反映します。')) return
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
            className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm hover:bg-orange-600 transition disabled:opacity-50">
            繰越自動計算
          </button>
        </div>
      </div>

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
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-3 py-3">名前</th>
              <th className="px-3 py-3">所属</th>
              <th className="px-3 py-3">入社日</th>
              <th className="px-3 py-3 text-center">発生月</th>
              <th className="px-3 py-3 text-right">付与</th>
              <th className="px-3 py-3 text-right">繰越</th>
              <th className="px-3 py-3 text-right">合計</th>
              <th className="px-3 py-3 text-right">調整</th>
              <th className="px-3 py-3 text-right">消化</th>
              <th className="px-3 py-3 text-right">残</th>
              <th className="px-3 py-3">期限</th>
              <th className="px-3 py-3">消化率</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={13} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : filteredWorkers.length === 0 ? (
              <tr><td colSpan={13} className="px-3 py-8 text-center text-gray-400">対象者がいません</td></tr>
            ) : filteredWorkers.map(w => {
              const rate = w.total > 0 ? (w.used / w.total * 100) : 0
              return (
                <tr key={w.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
                  <td className="px-3 py-2.5 font-medium">{w.name}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${w.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {w.org === 'hfu' ? 'HFU' : '日比'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                    {w.hireDate || '—'}
                  </td>
                  <td className="px-3 py-2.5 text-center text-xs">
                    {editingGrantMonth === w.id ? (
                      <select
                        autoFocus
                        disabled={grantMonthSaving}
                        defaultValue={w.grantMonth ?? ''}
                        onChange={e => handleGrantMonthUpdate(w.id, e.target.value)}
                        onBlur={() => setEditingGrantMonth(null)}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-1 py-0.5 text-xs"
                      >
                        <option value="">未設定</option>
                        {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => <option key={m} value={m}>{m}月</option>)}
                      </select>
                    ) : (
                      <button
                        onClick={() => setEditingGrantMonth(w.id)}
                        className="text-gray-600 dark:text-gray-400 hover:text-hibi-navy hover:underline cursor-pointer"
                        title="クリックで変更"
                      >
                        {w.grantMonth ? `${w.grantMonth}月` : (() => {
                          const calc = calcGrantMonthFromHire(w.hireDate)
                          return calc ? <span className="text-gray-400 italic">{calc}月</span> : '—'
                        })()}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{w.grantDays}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {(!w.visa || w.visa === 'none') ? <span className="text-gray-300" title="日本人社員は期末買取制で繰越なし">—</span> : w.carryOver}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">{w.total}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{w.adjustment > 0 ? w.adjustment : '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{w.used}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${w.remaining <= 3 ? 'text-red-500' : 'text-green-600'}`}>
                    {w.remaining}
                  </td>
                  {/* Expiry column */}
                  <td className="px-3 py-2.5">
                    {w.expiryDate ? (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        w.expiryStatus === 'expired'
                          ? 'bg-red-100 text-red-700 font-bold'
                          : w.expiryStatus === 'warning'
                            ? 'bg-orange-100 text-orange-700'
                            : 'text-gray-500'
                      }`}>
                        {w.expiryStatus === 'expired' ? '期限切れ' : w.expiryDate}
                      </span>
                    ) : <span className="text-xs text-gray-300">—</span>}
                  </td>
                  {/* Improved rate bar */}
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${rateBarColor(rate)} transition-all`}
                          style={{ width: `${Math.min(100, rate)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-600 font-medium min-w-[2.5rem]">{rate.toFixed(0)}%</span>
                      {w.fiveDayShortfall > 0 && (
                        <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-bold whitespace-nowrap" title="年5日取得義務未達">
                          5日未達
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => { setEditWorker(w); setEditForm({ grantDays: String(w.grantDays), carryOver: String(w.carryOver), adjustment: String(w.adjustment), grantDate: w.grantDate || '' }) }}
                      className="text-hibi-navy text-xs underline">編集</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
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
                      期間: {fmt(gd)} 〜 {fmt(end)} / 有効期限: {fmt(expiry)}
                    </div>
                  )
                })()}
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
                  <div key={p.workerId} className={`border rounded-lg p-3 ${f.include ? 'border-amber-300 bg-amber-50/50 dark:bg-amber-900/10' : 'border-gray-200 bg-gray-50 dark:bg-gray-900/50 opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="font-bold text-sm text-hibi-navy dark:text-white">{p.name}</div>
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {visaLabel} | {p.tenureText} | {p.reason}
                        </div>
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

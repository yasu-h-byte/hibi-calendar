'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYenMan, fmtNum as fmtNumShared } from '@/lib/format'

// ─── Types ───

interface DashboardSummary {
  totalManDays: number
  billing: number
  prevTotalManDays: number
  pctWork: number
}

interface TodaySiteStatus {
  siteId: string
  siteName: string
  tobi: number
  doko: number
  subTobi: number
  subDoko: number
  total: number
}

interface DailyAttendance {
  day: number
  sites: { siteId: string; siteName: string; count: number }[]
}

interface SiteOption {
  id: string
  name: string
}

interface LeaveRequestItem {
  id: string
  workerName: string
  date: string
  siteId: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
}

interface AbsenceReport {
  workerName: string
  date: string
  reason: string
  reasonLabel: string
  note?: string
}

interface HomeLongLeaveItem {
  id: string
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
}

interface ActionItems {
  pendingLeaveRequests: { count: number; items: LeaveRequestItem[] }
  absenceReports?: AbsenceReport[]
  homeLongLeaveRequests?: HomeLongLeaveItem[]
  // 5月運用対応で追加
  homeLeaveCurrentCount?: number
  homeLeaveUpcomingCount?: number
  pendingHomeLeaveApprovalCount?: number
  pendingGrantsCount?: number
  carryOverExpiringCount?: number
  plShortfall?: { count: number }
  visaExpiry?: { count: number; items: { name: string; daysLeft: number; expiry: string }[] }
}

interface DashboardData {
  summary: DashboardSummary
  todayStatus: { siteStatus: TodaySiteStatus[]; absentWorkers: { id: number; name: string }[] }
  dailyAttendance: DailyAttendance[]
  siteList: SiteOption[]
  selectedYm: string
  actionItems?: ActionItems
}

// ─── Helpers ───

function fmtNum(value: number): string {
  return fmtNumShared(value)
}

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

const SITE_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-orange-500', 'bg-indigo-500',
]

function siteColor(index: number): string {
  return SITE_COLORS[index % SITE_COLORS.length]
}

// ─── Announcements ───

interface DashboardAnnouncement {
  id: string; title: string; content: string
  category: 'new' | 'fix' | 'info'; publishedAt: string
}

function AnnouncementsCard({ password }: { password: string }) {
  const [items, setItems] = useState<DashboardAnnouncement[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!password) return
    fetch('/api/announcements', { headers: { 'x-admin-password': password } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setItems((data.announcements || []).slice(0, 3)) })
      .finally(() => setLoaded(true))
  }, [password])

  if (!loaded || items.length === 0) return null

  const catStyle: Record<string, { label: string; cls: string }> = {
    new: { label: '新機能', cls: 'bg-blue-100 text-blue-700' },
    fix: { label: '修正', cls: 'bg-green-100 text-green-700' },
    info: { label: 'お知らせ', cls: 'bg-gray-100 text-gray-700' },
  }

  const relTime = (iso: string) => {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (diff < 60) return `${diff}分前`
    if (diff < 1440) return `${Math.floor(diff / 60)}時間前`
    const days = Math.floor(diff / 1440)
    return days === 1 ? '昨日' : days < 7 ? `${days}日前` : `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}`
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 border-hibi-navy">
      <h3 className="text-sm font-bold text-hibi-navy dark:text-white mb-3">📢 お知らせ</h3>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {items.map(a => {
          const c = catStyle[a.category] || catStyle.info
          return (
            <div key={a.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${c.cls}`}>{c.label}</span>
                <span className="text-[11px] text-gray-400">{relTime(a.publishedAt)}</span>
              </div>
              <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">{a.title}</h4>
              <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap line-clamp-3">{a.content}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 申請バナー (ダッシュボード上部・対応待ちを目立つ場所に表示) ───

function PendingRequestsBanner({ leaveItems, homeLongLeaveItems, userRole }: {
  leaveItems: LeaveRequestItem[]
  homeLongLeaveItems: HomeLongLeaveItem[]
  userRole: string
}) {
  // 集計
  const leavePending = leaveItems.filter(i => i.status === 'pending').length
  const leaveForemanApproved = leaveItems.filter(i => i.status === 'foreman_approved').length
  const hlPending = homeLongLeaveItems.filter(i => i.status === 'pending').length
  const hlForemanApproved = homeLongLeaveItems.filter(i => i.status === 'foreman_approved').length

  // 「あなたの番」= ロールに応じて自分が対応すべき件数
  const isForemanOnly = userRole === 'foreman'
  const isFinalApprover = userRole === 'admin' || userRole === 'approver'

  // 職長 → pending のみ。最終承認者 → 両方（foreman_approved + pending、ただし foreman_approved 強調）
  const myLeaveCount = isForemanOnly ? leavePending : (leaveForemanApproved + leavePending)
  const myHlCount = isForemanOnly ? hlPending : (hlForemanApproved + hlPending)
  const myTotal = myLeaveCount + myHlCount

  // 全くなければバナー非表示
  if (myTotal === 0) return null

  const scrollToCard = () => {
    document.getElementById('attendance-request-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <button
      onClick={scrollToCard}
      className="w-full bg-gradient-to-r from-red-500 to-orange-500 text-white rounded-xl shadow-lg p-4 hover:shadow-xl active:scale-[0.99] transition-all"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="text-3xl animate-bounce">📥</div>
          <div className="text-left">
            <div className="text-xs opacity-90 font-medium">あなたの対応待ち</div>
            <div className="text-2xl font-bold leading-tight">{myTotal}件</div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {myLeaveCount > 0 && (
            <div className="text-center">
              <div className="text-xs opacity-90">🌴 有給申請</div>
              <div className="text-lg font-bold">{myLeaveCount}件</div>
              {!isForemanOnly && leaveForemanApproved > 0 && (
                <div className="text-[10px] opacity-80">最終承認待ち {leaveForemanApproved}件</div>
              )}
            </div>
          )}
          {myHlCount > 0 && (
            <div className="text-center">
              <div className="text-xs opacity-90">✈️ 帰国申請</div>
              <div className="text-lg font-bold">{myHlCount}件</div>
              {!isForemanOnly && hlForemanApproved > 0 && (
                <div className="text-[10px] opacity-80">最終承認待ち {hlForemanApproved}件</div>
              )}
            </div>
          )}
          <div className="text-2xl">↓</div>
        </div>
      </div>
    </button>
  )
}

// ─── Attendance Request Card (有給申請 + 欠勤届) ───

function AttendanceRequestCard({ leaveItems, absenceReports, homeLongLeaveItems, password, userRole, onUpdate }: {
  leaveItems: LeaveRequestItem[]
  absenceReports: AbsenceReport[]
  homeLongLeaveItems: HomeLongLeaveItem[]
  password: string
  userRole: string  // 'admin' | 'approver' | 'foreman' | 'jimu'
  onUpdate: () => void
}) {
  const [processing, setProcessing] = useState<string | null>(null)

  // 権限制御:
  //   - 職長承認: admin / approver / foreman が押せる
  //   - 最終承認: admin / approver のみ（事業責任者）
  //   - 却下: 全員可（ただし最終承認後の却下は実質意味なし）
  const canForemanApprove = userRole === 'admin' || userRole === 'approver' || userRole === 'foreman'
  const canFinalApprove = userRole === 'admin' || userRole === 'approver'

  const hasLeave = leaveItems.length > 0
  const hasAbsence = absenceReports.length > 0
  const hasHomeLongLeave = homeLongLeaveItems.length > 0
  if (!hasLeave && !hasAbsence && !hasHomeLongLeave) return null

  const handleAction = async (id: string, action: string, apiPath: string = '/api/leave-request') => {
    setProcessing(id)
    try {
      const stored = localStorage.getItem('hibi_auth')
      const user = stored ? JSON.parse(stored).user : null
      await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action,
          requestId: id,
          ...(action === 'foreman_approve' ? { foremanId: user?.workerId || 0 } : { approvedBy: user?.workerId || 0 }),
        }),
      })
      onUpdate()
    } catch { /* ignore */ }
    finally { setProcessing(null) }
  }

  const fmtDate = (d: string) => { const [, m, day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}` }
  const todayStr = (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}` })()

  const pending = leaveItems.filter(i => i.status === 'pending')
  const foremanApproved = leaveItems.filter(i => i.status === 'foreman_approved')
  const todayAbsence = absenceReports.filter(a => a.date === todayStr)
  const pastAbsence = absenceReports.filter(a => a.date !== todayStr)

  const hlPending = homeLongLeaveItems.filter(i => i.status === 'pending')
  const hlForemanApproved = homeLongLeaveItems.filter(i => i.status === 'foreman_approved')

  return (
    <div id="attendance-request-card" className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 border-blue-400 scroll-mt-4">
      <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">📋 勤怠申請</h3>

      {/* 有給申請 */}
      {hasLeave && (
        <div className="mb-3">
          <p className="text-[10px] text-green-600 font-bold mb-1.5 flex items-center gap-1">🌴 有給申請（{leaveItems.length}件）</p>
          <div className="space-y-1">
            {pending.map(req => (
              <div key={req.id} className="flex items-center justify-between py-2 px-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                <div className="min-w-0">
                  <span className="font-bold text-sm text-hibi-navy dark:text-white">{req.workerName}</span>
                  <span className="text-gray-500 text-sm ml-2">{fmtDate(req.date)}</span>
                  {req.reason && <span className="text-gray-400 text-xs ml-2">{req.reason}</span>}
                </div>
                <div className="flex gap-1.5 flex-shrink-0 ml-2">
                  {canForemanApprove && (
                    <button onClick={() => handleAction(req.id, 'foreman_approve')} disabled={processing === req.id}
                      className="px-2.5 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">職長承認</button>
                  )}
                  <button onClick={() => handleAction(req.id, 'reject')} disabled={processing === req.id}
                    className="px-2.5 py-1 bg-red-400 hover:bg-red-500 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                </div>
              </div>
            ))}
            {foremanApproved.map(req => (
              <div key={req.id} className="flex items-center justify-between py-2 px-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <div className="min-w-0">
                  <span className="font-bold text-sm text-hibi-navy dark:text-white">{req.workerName}</span>
                  <span className="text-gray-500 text-sm ml-2">{fmtDate(req.date)}</span>
                  <span className="text-[10px] text-blue-600 ml-2">職長済</span>
                </div>
                <div className="flex gap-1.5 flex-shrink-0 ml-2">
                  {canFinalApprove ? (
                    <>
                      <button onClick={() => handleAction(req.id, 'approve')} disabled={processing === req.id}
                        className="px-2.5 py-1 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">最終承認</button>
                      <button onClick={() => handleAction(req.id, 'reject')} disabled={processing === req.id}
                        className="px-2.5 py-1 bg-red-400 hover:bg-red-500 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                    </>
                  ) : (
                    <span className="text-[10px] text-gray-500">最終承認待ち</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 帰国申請 */}
      {hasHomeLongLeave && (
        <div className="mb-3">
          {hasLeave && <hr className="my-2 border-gray-100 dark:border-gray-700" />}
          <p className="text-[10px] text-purple-600 font-bold mb-1.5">✈️ 帰国申請（{homeLongLeaveItems.length}件）</p>
          <div className="space-y-1">
            {hlPending.map(req => (
              <div key={req.id} className="flex items-center justify-between py-2 px-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                <div className="min-w-0">
                  <span className="font-bold text-sm text-hibi-navy dark:text-white">{req.workerName}</span>
                  <span className="text-gray-500 text-sm ml-2">{fmtDate(req.startDate)}〜{fmtDate(req.endDate)}</span>
                  <span className="text-gray-400 text-xs ml-2">{req.reason}</span>
                </div>
                <div className="flex gap-1.5 flex-shrink-0 ml-2">
                  {canForemanApprove && (
                    <button onClick={() => handleAction(req.id, 'foreman_approve', '/api/home-long-leave')} disabled={processing === req.id}
                      className="px-2.5 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">職長承認</button>
                  )}
                  <button onClick={() => handleAction(req.id, 'reject', '/api/home-long-leave')} disabled={processing === req.id}
                    className="px-2.5 py-1 bg-red-400 hover:bg-red-500 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                </div>
              </div>
            ))}
            {hlForemanApproved.map(req => (
              <div key={req.id} className="flex items-center justify-between py-2 px-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <div className="min-w-0">
                  <span className="font-bold text-sm text-hibi-navy dark:text-white">{req.workerName}</span>
                  <span className="text-gray-500 text-sm ml-2">{fmtDate(req.startDate)}〜{fmtDate(req.endDate)}</span>
                  <span className="text-[10px] text-blue-600 ml-2">職長済</span>
                </div>
                <div className="flex gap-1.5 flex-shrink-0 ml-2">
                  {canFinalApprove ? (
                    <>
                      <button onClick={() => handleAction(req.id, 'approve', '/api/home-long-leave')} disabled={processing === req.id}
                        className="px-2.5 py-1 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">最終承認</button>
                      <button onClick={() => handleAction(req.id, 'reject', '/api/home-long-leave')} disabled={processing === req.id}
                        className="px-2.5 py-1 bg-red-400 hover:bg-red-500 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                    </>
                  ) : (
                    <span className="text-[10px] text-gray-500">最終承認待ち</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 欠勤届 */}
      {hasAbsence && (
        <div>
          {(hasLeave || hasHomeLongLeave) && <hr className="my-2 border-gray-100 dark:border-gray-700" />}
          {todayAbsence.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] text-red-500 font-bold mb-1.5">🏠 本日の欠勤届</p>
              <div className="space-y-1">
                {todayAbsence.map((a, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
                    <span className="font-bold text-sm text-hibi-navy dark:text-white">{a.workerName}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {a.reasonLabel}{a.note ? `（${a.note}）` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {pastAbsence.length > 0 && (
            <div>
              <p className="text-[10px] text-gray-400 font-bold mb-1.5">📅 過去7日の欠勤</p>
              <div className="space-y-0.5">
                {pastAbsence.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 px-3 text-xs text-gray-500">
                    <span className="tabular-nums">{fmtDate(a.date)}</span>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{a.workerName}</span>
                    <span className="text-gray-400">{a.reasonLabel}{a.note ? `（${a.note}）` : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───

export default function DashboardPage() {
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState<string>('')
  const [ym, setYm] = useState(currentYm)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw, user } = JSON.parse(stored)
      setPassword(pw)
      setUserRole(user?.role || '')
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ ym, period: 'month', site: 'all' })
      const res = await fetch(`/api/dashboard?${params}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        setError('データの取得に失敗しました')
        return
      }
      const json = await res.json()
      setData(json)
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Period navigation
  const navigateMonth = (direction: -1 | 1) => {
    const y = parseInt(ym.slice(0, 4))
    const m = parseInt(ym.slice(4, 6))
    const d = new Date(y, m - 1 + direction, 1)
    setYm(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const today = new Date()
  const dowJa = ['日', '月', '火', '水', '木', '金', '土']
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${dowJa[today.getDay()]})`

  const ymToLabel = (v: string) => {
    const y = v.slice(0, 4)
    const m = parseInt(v.slice(4, 6))
    return `${y}/${m}`
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">ダッシュボード</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => navigateMonth(-1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">◀</button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[70px] text-center">{ymToLabel(ym)}</span>
          <button onClick={() => navigateMonth(1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">▶</button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 rounded-lg p-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : data ? (
        <>
          {/* ═══ 📥 申請バナー（最上部・対応待ちがある時のみ表示） ═══ */}
          <PendingRequestsBanner
            leaveItems={data.actionItems?.pendingLeaveRequests?.items || []}
            homeLongLeaveItems={data.actionItems?.homeLongLeaveRequests || []}
            userRole={userRole}
          />

          {/* ═══ 🌴 休暇状況サマリー ═══ */}
          {(() => {
            const ai = data.actionItems
            if (!ai) return null
            const cur = ai.homeLeaveCurrentCount ?? 0
            const up = ai.homeLeaveUpcomingCount ?? 0
            const pendG = ai.pendingGrantsCount ?? 0
            const carryExp = ai.carryOverExpiringCount ?? 0
            const shortfall = ai.plShortfall?.count ?? 0
            // どれかある時のみ表示
            if (cur === 0 && up === 0 && pendG === 0 && carryExp === 0 && shortfall === 0) return null
            return (
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🌴</span>
                  <h3 className="text-sm font-bold text-hibi-navy dark:text-white">休暇状況</h3>
                  <a href="/leave" className="ml-auto text-xs text-blue-600 hover:underline">休暇管理を開く →</a>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="bg-cyan-50 dark:bg-cyan-900/20 rounded-lg p-3">
                    <div className="text-[10px] text-cyan-700 dark:text-cyan-300 font-medium">帰国中</div>
                    <div className="text-2xl font-bold text-cyan-900 dark:text-cyan-200 mt-0.5">{cur}<span className="text-xs ml-0.5 font-normal">名</span></div>
                  </div>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                    <div className="text-[10px] text-blue-700 dark:text-blue-300 font-medium">帰国予定（6ヶ月先まで）</div>
                    <div className="text-2xl font-bold text-blue-900 dark:text-blue-200 mt-0.5">{up}<span className="text-xs ml-0.5 font-normal">件</span></div>
                  </div>
                  <div className={`rounded-lg p-3 ${pendG > 0 ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-gray-50 dark:bg-gray-700/30'}`}>
                    <div className={`text-[10px] font-medium ${pendG > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500'}`}>付与時期到来</div>
                    <div className={`text-2xl font-bold mt-0.5 ${pendG > 0 ? 'text-amber-900 dark:text-amber-200' : 'text-gray-400'}`}>
                      {pendG}<span className="text-xs ml-0.5 font-normal">名</span>
                    </div>
                  </div>
                  <div className={`rounded-lg p-3 ${carryExp > 0 ? 'bg-orange-50 dark:bg-orange-900/20' : 'bg-gray-50 dark:bg-gray-700/30'}`}>
                    <div className={`text-[10px] font-medium ${carryExp > 0 ? 'text-orange-700 dark:text-orange-300' : 'text-gray-500'}`}>繰越時効間近</div>
                    <div className={`text-2xl font-bold mt-0.5 ${carryExp > 0 ? 'text-orange-900 dark:text-orange-200' : 'text-gray-400'}`}>
                      {carryExp}<span className="text-xs ml-0.5 font-normal">名</span>
                    </div>
                  </div>
                  <div className={`rounded-lg p-3 ${shortfall > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-gray-700/30'}`}>
                    <div className={`text-[10px] font-medium ${shortfall > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-500'}`}>年5日義務未達</div>
                    <div className={`text-2xl font-bold mt-0.5 ${shortfall > 0 ? 'text-red-900 dark:text-red-200' : 'text-gray-400'}`}>
                      {shortfall}<span className="text-xs ml-0.5 font-normal">名</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ═══ お知らせ ═══ */}
          <AnnouncementsCard password={password} />

          {/* ═══ 勤怠申請（有給＋帰国＋欠勤届） ═══ */}
          <AttendanceRequestCard
            leaveItems={data.actionItems?.pendingLeaveRequests?.items || []}
            absenceReports={data.actionItems?.absenceReports || []}
            homeLongLeaveItems={data.actionItems?.homeLongLeaveRequests || []}
            password={password}
            userRole={userRole}
            onUpdate={fetchData}
          />

          {/* ═══ 1. Today's Status Table ═══ */}
          <Section title={`本日の稼働状況 (${todayStr})`}>
            {data.todayStatus && data.todayStatus.siteStatus.length > 0 && data.todayStatus.siteStatus.some(s => s.total > 0) ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-hibi-navy text-white">
                        <th className="px-3 py-2 text-left">現場</th>
                        <th className="px-3 py-2 text-right">鳶</th>
                        <th className="px-3 py-2 text-right">土工</th>
                        <th className="px-3 py-2 text-right">外注鳶</th>
                        <th className="px-3 py-2 text-right">外注土工</th>
                        <th className="px-3 py-2 text-right">合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.todayStatus.siteStatus.map((s) => (
                        <tr key={s.siteId} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-3 py-2 font-medium text-hibi-navy">{s.siteName}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.tobi}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.doko}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.subTobi}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.subDoko}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">{s.total}</td>
                        </tr>
                      ))}
                      <tr className="bg-gray-50 dark:bg-gray-700 font-bold">
                        <td className="px-3 py-2">合計</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.tobi, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.doko, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.subTobi, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.subDoko, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.total, 0)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {data.todayStatus.absentWorkers.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                      休み {data.todayStatus.absentWorkers.length}名:
                    </span>
                    {data.todayStatus.absentWorkers.map(w => (
                      <span key={w.id} className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded-full text-xs">
                        {w.name}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="py-6 text-center">
                <p className="text-gray-400 text-sm">本日の出面はまだ入力されていません</p>
                <p className="text-gray-300 text-xs mt-1">出面入力画面で入力するとここに反映されます</p>
              </div>
            )}
          </Section>

          {/* ═══ 今月サマリー ═══ */}
          {data.summary && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <div className="flex items-center gap-1 text-xs font-semibold mb-1">
                  <span className="text-gray-500 dark:text-gray-400">総人工数</span>
                  {data.summary.prevTotalManDays > 0 && data.summary.pctWork !== 0 && (
                    <span className={`text-[10px] font-bold ${data.summary.pctWork > 0 ? 'text-green-600' : 'text-red-600'}`} title="前月同日比">
                      {data.summary.pctWork > 0 ? '▲' : '▼'}{Math.abs(Math.round(data.summary.pctWork))}%
                    </span>
                  )}
                </div>
                <div className="text-2xl font-bold text-hibi-navy dark:text-white tabular-nums">
                  {fmtNum(data.summary.totalManDays)}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500">人工</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                <div className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-1">
                  {data.summary.billing > 0 ? '売上' : '売上（概算）'}
                </div>
                <div className={`text-2xl font-bold tabular-nums ${data.summary.billing === 0 ? 'text-gray-400' : 'text-hibi-navy dark:text-white'}`}>
                  {data.summary.billing === 0 ? '未入力' : fmtYenMan(data.summary.billing)}
                </div>
                {data.summary.billing > 0 && <div className="text-xs text-gray-400 dark:text-gray-500">万円</div>}
              </div>
            </div>
          )}

          {/* Link to cost page */}
          <div className="text-center">
            <a href="/cost" className="text-sm text-hibi-navy dark:text-blue-400 hover:underline font-medium">
              詳しくは原価・収益管理へ →
            </a>
          </div>

          {/* ═══ Daily Attendance Bar Chart ═══ */}
          {data.dailyAttendance && data.dailyAttendance.length > 0 && (
            <Section title="日別稼働人数">
              <div className="overflow-x-auto">
                <div className="flex items-end gap-0.5" style={{ minWidth: `${data.dailyAttendance.length * 24}px`, height: '150px' }}>
                  {data.dailyAttendance.map((da) => {
                    const maxDaily = Math.max(
                      ...data.dailyAttendance.map(d => d.sites.reduce((s, st) => s + st.count, 0)),
                      1
                    )
                    return (
                      <div key={da.day} className="flex flex-col justify-end" style={{ width: '22px', height: '150px' }}>
                        {da.sites.map((st) => {
                          const segPct = maxDaily > 0 ? (st.count / maxDaily) * 140 : 0
                          return (
                            <div
                              key={st.siteId}
                              className={`w-full ${siteColor(data.siteList.findIndex(s => s.id === st.siteId))}`}
                              style={{ height: `${segPct}px` }}
                              title={`${st.siteName}: ${st.count}名`}
                            />
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
                <div className="flex gap-0.5" style={{ minWidth: `${data.dailyAttendance.length * 24}px` }}>
                  {data.dailyAttendance.map((da) => (
                    <div key={da.day} className="text-[10px] text-gray-500 text-center" style={{ width: '22px' }}>{da.day}</div>
                  ))}
                </div>
                <div className="flex gap-0.5" style={{ minWidth: `${data.dailyAttendance.length * 24}px` }}>
                  {data.dailyAttendance.map((da) => {
                    const totalCount = da.sites.reduce((s, st) => s + st.count, 0)
                    return (
                      <div key={da.day} className="text-[9px] text-gray-400 text-center" style={{ width: '22px' }}>
                        {totalCount > 0 ? totalCount : ''}
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-3 pt-2 mt-2 text-xs text-gray-500 dark:text-gray-400 border-t flex-wrap">
                  {data.siteList.map((s, i) => (
                    <span key={s.id} className="flex items-center gap-1">
                      <span className={`inline-block w-3 h-3 rounded ${siteColor(i)}`} />
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            </Section>
          )}

          {/* 有給残少は通知ベルに統合済み */}

          {/* 出勤率は通知ベルに統合済み — 詳細は人員マスタや月次集計で確認 */}
        </>
      ) : null}
    </div>
  )
}

// ─── Sub-components ───

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-white">
        <h2 className="font-bold text-hibi-navy dark:text-blue-300 text-sm">{title}</h2>
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  )
}


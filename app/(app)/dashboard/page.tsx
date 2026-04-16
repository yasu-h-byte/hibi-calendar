'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYen, fmtYenMan, fmtNum as fmtNumShared, fmtPct } from '@/lib/format'

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

interface PLAlertRow {
  workerId: number
  name: string
  org: string
  totalDays: number
  usedDays: number
  remaining: number
  status: string
}

interface ForeignWorkerRate {
  id: number
  name: string
  org: string
  visa: string
  avgRate: number
  monthlyRates: { ym: string; rate: number }[]
}

interface SiteOption {
  id: string
  name: string
}

interface ActionItems {
  visaExpiry: { count: number; items: { name: string; daysLeft: number; expiry: string }[] }
  plShortfall: { count: number }
  pendingLeaveRequests: { count: number }
  calendarProgress: { pending: number; total: number }
}

interface DashboardData {
  summary: DashboardSummary
  todayStatus: { siteStatus: TodaySiteStatus[]; absentWorkers: { id: number; name: string }[] }
  dailyAttendance: DailyAttendance[]
  plAlert: PLAlertRow[]
  foreignWorkerRates: { workers: ForeignWorkerRate[]; groupAvg: number; totalWorkers: number }
  siteList: SiteOption[]
  ymList: string[]
  period: string
  selectedYm: string
  actionItems?: ActionItems
}

// ─── Helpers ───

function fmtNum(value: number): string {
  return fmtNumShared(value)
}

function ymToShortLabel(ym: string): string {
  const m = parseInt(ym.slice(4, 6))
  return `${m}月`
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

// ─── Monthly Checklist (compact for dashboard) ───

function getNextYm(): string {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
}

// ─── Announcements (dashboard top banner) ───

interface DashboardAnnouncement {
  id: string
  title: string
  content: string
  category: 'new' | 'fix' | 'info'
  publishedAt: string
  publishedBy: string
}

function formatRelativeTime(iso: string): string {
  const now = new Date()
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}時間前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return '昨日'
  if (diffDay < 7) return `${diffDay}日前`
  return `${then.getMonth() + 1}/${then.getDate()}`
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
    new: { label: '新機能', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    fix: { label: '修正', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
    info: { label: 'お知らせ', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 border-hibi-navy">
      <h3 className="text-sm font-bold text-hibi-navy dark:text-white mb-3 flex items-center gap-2">
        お知らせ
      </h3>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {items.map(a => {
          const c = catStyle[a.category] || catStyle.info
          return (
            <div key={a.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${c.cls}`}>{c.label}</span>
                <span className="text-[11px] text-gray-400">{formatRelativeTime(a.publishedAt)}</span>
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

function MonthlyChecklist({ password }: { password: string }) {
  const [status, setStatus] = useState<{
    calCreated: number; calTotal: number
    calApproved: number
    signed: number; signTotal: number; unsigned: string[]
  } | null>(null)

  useEffect(() => {
    if (!password) return
    const ym = getNextYm()
    fetch(`/api/calendar/status?ym=${ym}`, {
      headers: { 'x-admin-password': password },
    }).then(r => r.ok ? r.json() : null).then(data => {
      if (!data?.sites) return
      const sites = data.sites.filter((s: { siteId: string }) => s.siteId)
      const total = sites.length
      const created = sites.filter((s: { days: unknown }) => s.days).length
      const approved = sites.filter((s: { status: string }) => s.status === 'approved').length
      let signTotal = 0, signDone = 0
      const unsigned: string[] = []
      for (const s of sites) {
        for (const w of (s.workers || [])) {
          signTotal++
          if (w.signed) signDone++
          else unsigned.push(w.name)
        }
      }
      setStatus({ calCreated: created, calTotal: total, calApproved: approved, signed: signDone, signTotal, unsigned })
    }).catch(() => {})
  }, [password])

  if (!status || status.calTotal === 0) return null

  const nextYm = getNextYm()
  const ymLabel = `${nextYm.slice(0, 4)}年${parseInt(nextYm.slice(4))}月`

  const step1Done = status.calCreated >= status.calTotal && status.calTotal > 0
  const step2Done = status.calApproved >= status.calTotal && status.calTotal > 0
  const step3Done = status.signed >= status.signTotal && status.signTotal > 0
  const allDone = step1Done && step2Done && step3Done

  const nextAction = !step1Done ? { label: 'カレンダーを作成', href: '/calendar' }
    : !step2Done ? { label: '承認する', href: '/calendar' }
    : !step3Done ? { label: '署名を依頼', href: '/calendar' }
    : null

  if (allDone) {
    return (
      <div className="rounded-xl px-4 py-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 flex items-center justify-between">
        <span className="text-sm font-medium text-green-700 dark:text-green-400">
          {ymLabel} カレンダー準備完了
        </span>
        <a href="/calendar" className="text-xs text-green-600 hover:underline">確認 →</a>
      </div>
    )
  }

  return (
    <div className="rounded-xl px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-bold text-hibi-navy dark:text-white">{ymLabel} カレンダー</span>
        {nextAction && (
          <a href={nextAction.href} className="text-xs px-3 py-1 bg-hibi-navy text-white rounded-lg hover:bg-hibi-light transition">
            {nextAction.label} →
          </a>
        )}
      </div>
      <div className="flex items-center gap-1 mb-1.5">
        <div className="flex-1 flex items-center gap-0.5">
          <div className={`h-2 rounded-l-full flex-1 ${step1Done ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-600'}`} />
          <div className={`h-2 flex-1 ${step2Done ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-600'}`} />
          <div className={`h-2 rounded-r-full flex-1 ${step3Done ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-600'}`} />
        </div>
      </div>
      <div className="flex items-center text-[11px] text-gray-500 dark:text-gray-400">
        <span className={`flex-1 ${step1Done ? 'text-green-600 font-bold' : ''}`}>
          {step1Done ? '✓' : ''} 作成 {status.calCreated}/{status.calTotal}
        </span>
        <span className="px-1">→</span>
        <span className={`flex-1 ${step2Done ? 'text-green-600 font-bold' : ''}`}>
          {step2Done ? '✓' : ''} 承認 {status.calApproved}/{status.calTotal}
        </span>
        <span className="px-1">→</span>
        <span className={`flex-1 ${step3Done ? 'text-green-600 font-bold' : ''}`}>
          {step3Done ? '✓' : ''} 署名 {status.signed}/{status.signTotal}
        </span>
      </div>
      {status.unsigned.length > 0 && (
        <details className="mt-2">
          <summary className="text-[10px] text-red-500 cursor-pointer hover:text-red-700">
            未署名 {status.unsigned.length}名
          </summary>
          <div className="text-[10px] text-red-400 mt-1 flex flex-wrap gap-1">
            {status.unsigned.map((name, i) => (
              <span key={i} className="bg-red-50 dark:bg-red-900/20 px-1.5 py-0.5 rounded">{name}</span>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// ─── Action Items Card ───

function ActionItemsCard({ items }: { items?: ActionItems }) {
  if (!items) return null
  const alerts: { label: string; count: number; href: string; icon: string; color: string }[] = []
  if (items.visaExpiry.count > 0) {
    alerts.push({ label: '在留期限（90日以内）', count: items.visaExpiry.count, href: '/workers', icon: '🛂', color: 'text-red-600' })
  }
  if (items.plShortfall.count > 0) {
    alerts.push({ label: '5日有給義務未達', count: items.plShortfall.count, href: '/leave', icon: '🌴', color: 'text-orange-600' })
  }
  if (items.pendingLeaveRequests.count > 0) {
    alerts.push({ label: '有給承認待ち', count: items.pendingLeaveRequests.count, href: '/leave', icon: '📝', color: 'text-blue-600' })
  }
  if (items.calendarProgress.pending > 0) {
    alerts.push({ label: 'カレンダー未提出', count: items.calendarProgress.pending, href: '/calendar', icon: '📅', color: 'text-purple-600' })
  }

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 ${alerts.length > 0 ? 'border-orange-400' : 'border-green-400'}`}>
      <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-2">⚡ 要対応</h3>
      {alerts.length === 0 ? (
        <p className="text-sm text-green-600">対応が必要な項目はありません ✅</p>
      ) : (
        <div className="space-y-1.5">
          {alerts.map((a, i) => (
            <a key={i} href={a.href} className="flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg px-2 py-1.5 transition">
              <div className="flex items-center gap-2">
                <span>{a.icon}</span>
                <span className="text-sm text-gray-700 dark:text-gray-300">{a.label}</span>
              </div>
              <span className={`text-sm font-bold ${a.color}`}>{a.count}件 →</span>
            </a>
          ))}
          {items.visaExpiry.count > 0 && items.visaExpiry.items.length > 0 && (
            <details className="mt-1 px-2">
              <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">在留期限の詳細</summary>
              <div className="mt-1 flex flex-wrap gap-1">
                {items.visaExpiry.items.map((v, i) => (
                  <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${v.daysLeft <= 30 ? 'bg-red-100 text-red-700' : v.daysLeft <= 60 ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {v.name} 残{v.daysLeft}日
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───

export default function DashboardPage() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(currentYm)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw } = JSON.parse(stored)
      setPassword(pw)
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
          {/* ═══ 0. Announcements ═══ */}
          <AnnouncementsCard password={password} />

          {/* ═══ 0.3. Action Items ═══ */}
          <ActionItemsCard items={data.actionItems} />

          {/* ═══ 0.5. Monthly Checklist ═══ */}
          <MonthlyChecklist password={password} />

          {/* ═══ 1. Today's Status Table ═══ */}
          <Section title={`本日の稼働状況 (${todayStr})`}>
            {data.todayStatus && data.todayStatus.siteStatus.length > 0 ? (
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
              <p className="text-gray-400 text-sm py-4 text-center">本日の出勤データなし</p>
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

          {/* ═══ PL Alert Table ═══ */}
          {data.plAlert && data.plAlert.length > 0 && (
            <Section title="有給残少アラート">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-red-50 text-red-800">
                      <th className="text-left px-3 py-2 font-semibold">名前</th>
                      <th className="text-left px-3 py-2 font-semibold">所属</th>
                      <th className="text-right px-3 py-2 font-semibold">残</th>
                      <th className="text-right px-3 py-2 font-semibold">合計</th>
                      <th className="text-right px-3 py-2 font-semibold">消化</th>
                      <th className="text-center px-3 py-2 font-semibold">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plAlert.map(row => (
                      <tr key={row.workerId} className="border-b border-gray-50 hover:bg-red-50/50">
                        <td className="px-3 py-2 font-medium">{row.name}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.org}</td>
                        <td className={`px-3 py-2 text-right font-bold ${
                          row.remaining <= 0 ? 'text-red-600' : row.remaining <= 1 ? 'text-orange-600' : 'text-yellow-600'
                        }`}>
                          {fmtNum(row.remaining)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.totalDays)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.usedDays)}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            row.status === 'danger' ? 'bg-red-100 text-red-700' :
                            row.status === 'warning' ? 'bg-orange-100 text-orange-700' :
                            'bg-yellow-100 text-yellow-700'
                          }`}>
                            {row.status === 'danger' ? '残なし' : row.status === 'warning' ? '残1以下' : '残少'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* ═══ Foreign Worker Attendance Rate ═══ */}
          {data.foreignWorkerRates && data.foreignWorkerRates.workers.length > 0 && (
            <Section title="出勤率: 平均を下回る外国人社員">
              <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                <span className="text-sm text-gray-600 dark:text-gray-400">6ヶ月平均出勤率:</span>
                <span className={`text-lg font-bold px-2.5 py-0.5 rounded ${
                  data.foreignWorkerRates.groupAvg >= 95 ? 'bg-green-100 text-green-800' :
                  data.foreignWorkerRates.groupAvg >= 90 ? 'bg-yellow-100 text-yellow-800' :
                  'bg-red-100 text-red-800'
                }`}>
                  {data.foreignWorkerRates.groupAvg.toFixed(1)}%
                </span>
                <span className="text-xs text-gray-400">
                  （{data.foreignWorkerRates.totalWorkers}名中 {data.foreignWorkerRates.workers.length}名が平均以下）
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 dark:text-gray-400">
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">名前</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">所属</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">資格</th>
                      <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">平均</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap text-center w-24">推移</th>
                      {data.ymList.map(m => (
                        <th key={m} className="text-right px-2 py-2 font-semibold whitespace-nowrap text-xs">
                          {ymToShortLabel(m)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.foreignWorkerRates.workers.map(fw => (
                      <tr key={fw.id} className="border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 bg-orange-50/30">
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{fw.name}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${fw.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                            {fw.org === 'hfu' ? 'HFU' : '日比建設'}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${fw.visa.startsWith('jisshu') ? 'bg-orange-100 text-orange-700' : 'bg-teal-100 text-teal-700'}`}>
                            {visaBadge(fw.visa)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                            fw.avgRate >= 95 ? 'bg-green-100 text-green-800' :
                            fw.avgRate >= 90 ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {fw.avgRate.toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <MiniSparkline rates={fw.monthlyRates.filter(r => data.ymList.includes(r.ym)).sort((a, b) => a.ym.localeCompare(b.ym))} />
                        </td>
                        {data.ymList.map(m => {
                          const mr = fw.monthlyRates.find(r => r.ym === m)
                          const rate = mr?.rate || 0
                          return (
                            <td key={m} className="px-2 py-2 text-right">
                              {rate > 0 ? (
                                <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                                  rate >= 95 ? 'bg-green-100 text-green-800' :
                                  rate >= 90 ? 'bg-yellow-100 text-yellow-800' :
                                  'bg-red-100 text-red-800'
                                }`}>
                                  {rate.toFixed(0)}%
                                </span>
                              ) : (
                                <span className="text-gray-300 text-xs">-</span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 mt-3 pt-2 border-t">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 bg-green-100 border border-green-300 rounded" /> 95%以上
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 bg-yellow-100 border border-yellow-300 rounded" /> 90-95%
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 bg-red-100 border border-red-300 rounded" /> 90%未満
                </span>
                <span className="text-gray-400 ml-2">出勤率 = 出勤日数 / 所定労働日数 x 100</span>
              </div>
            </Section>
          )}
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

function visaBadge(visa: string): string {
  if (visa.startsWith('jisshu')) {
    const n = visa.replace('jisshu', '')
    return n ? `実習${n}号` : '技能実習'
  }
  if (visa.startsWith('tokutei')) {
    const n = visa.replace('tokutei', '')
    return n ? `特定${n}号` : '特定技能'
  }
  if (!visa || visa === 'none' || visa === '') return ''
  return visa
}

/** Mini sparkline for attendance rates */
function MiniSparkline({ rates }: { rates: { ym: string; rate: number }[] }) {
  if (rates.length === 0) return <span className="text-gray-300 text-xs">-</span>

  const w = 80
  const h = 24
  const pad = 2
  const chartW = w - pad * 2
  const chartH = h - pad * 2

  const minR = 70
  const maxR = 100
  const range = maxR - minR

  const getX = (i: number) => pad + (rates.length > 1 ? (i / (rates.length - 1)) * chartW : chartW / 2)
  const getY = (v: number) => pad + chartH - ((Math.max(Math.min(v, maxR), minR) - minR) / range) * chartH

  const path = rates.map((r, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(r.rate).toFixed(1)}`).join(' ')

  const latestRate = rates[rates.length - 1]?.rate || 0
  const lineColor = latestRate >= 95 ? '#22c55e' : latestRate >= 90 ? '#eab308' : '#ef4444'

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="inline-block">
      <line x1={pad} y1={getY(90)} x2={w - pad} y2={getY(90)} stroke="#fecaca" strokeWidth="0.5" />
      <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" />
      {rates.map((r, i) => (
        <circle key={i} cx={getX(i)} cy={getY(r.rate)} r={1.5} fill={lineColor} />
      ))}
    </svg>
  )
}

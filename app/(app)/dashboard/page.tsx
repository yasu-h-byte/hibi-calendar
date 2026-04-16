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

interface DashboardData {
  summary: DashboardSummary
  todayStatus: { siteStatus: TodaySiteStatus[]; absentWorkers: { id: number; name: string }[] }
  dailyAttendance: DailyAttendance[]
  siteList: SiteOption[]
  selectedYm: string
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
          {/* 通知・お知らせ・カレンダー進捗は通知ベル（🔔）に統合済み */}

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


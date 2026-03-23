'use client'

import { useEffect, useState, useCallback } from 'react'

// ─── Types ───

interface KPI {
  totalManDays: number
  inHouseManDays: number
  subconManDays: number
  subconRate: number
  billing: number
  cost: number
  profit: number
  profitRate: number
  laborCostPerPerson: number
  laborCostPerPersonAll: number
  billingPerManDay: number
  billingPerManDayBaseline: number
  billingPerManDayRate: number
  otHours: number
}

interface SiteRow {
  id: string
  name: string
  inHouseWorkDays: number
  subconWorkDays: number
  subconRate: number
  otHours: number
  cost: number
  billing: number
  profit: number
  profitRate: number
}

interface TodaySiteStatus {
  siteId: string
  siteName: string
  tobi: number
  doko: number
  gaichuCount: number
  total: number
}

interface MonthlyTrend {
  ym: string
  billing: number
  cost: number
  profit: number
  manDays: number
  billingPerManDay: number
  costPerManDay: number
  profitPerManDay: number
  inHouseWorkDays: number
  subconWorkDays: number
}

interface DailyAttendance {
  day: number
  sites: { siteId: string; siteName: string; count: number }[]
}

interface CumulativeData {
  ym: string
  billing: number
  cost: number
  profit: number
  cumBilling: number
  cumCost: number
  cumProfit: number
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

interface SiteMember {
  id: number
  name: string
  org: string
  visa: string
  job: string
}

interface SiteTrendPoint {
  ym: string
  workerCount: number
  cost: number
  tobi: number
  doko: number
}

interface DashboardData {
  kpi: KPI
  sites: SiteRow[]
  monthlyTrend: MonthlyTrend[]
  todayStatus: { siteStatus: TodaySiteStatus[]; absentWorkers: { id: number; name: string }[] }
  dailyAttendance: DailyAttendance[]
  cumulativeData: CumulativeData[]
  plAlert: PLAlertRow[]
  foreignWorkerRates: ForeignWorkerRate[]
  siteList: SiteOption[]
  ymList: string[]
  period: string
  selectedYm: string
  siteMembers: SiteMember[] | null
  siteTrend: SiteTrendPoint[] | null
}

// ─── Helpers ───

// 小数点.0を除去（91.0→91, 267.4→267.4）
function fmtNum(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatMan(value: number): string {
  const v = value / 10000
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function formatYen(value: number): string {
  if (Math.abs(value) >= 10000) {
    return `¥${formatMan(value)}万`
  }
  return `¥${value.toLocaleString()}`
}

function formatYenFull(value: number): string {
  return `¥${Math.round(value / 10000).toLocaleString()}万`
}

function profitRateColor(rate: number): string {
  if (rate > 15) return 'text-green-600'
  if (rate > 0) return 'text-yellow-600'
  return 'text-red-600'
}

function ymToLabel(ym: string): string {
  const y = ym.slice(0, 4)
  const m = parseInt(ym.slice(4, 6))
  return `${y}/${m}`
}

function ymToShortLabel(ym: string): string {
  const m = parseInt(ym.slice(4, 6))
  return `${m}月`
}

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

function rateColorClass(rate: number): string {
  if (rate >= 90) return 'bg-green-100 text-green-800'
  if (rate >= 70) return 'bg-yellow-100 text-yellow-800'
  return 'bg-red-100 text-red-800'
}

const SITE_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-orange-500', 'bg-indigo-500',
]

function siteColor(index: number): string {
  return SITE_COLORS[index % SITE_COLORS.length]
}

const PERIOD_OPTIONS = [
  { key: 'month', label: '月次' },
  { key: '3month', label: '3ヶ月' },
  { key: '6month', label: '6ヶ月' },
  { key: 'fy', label: '決算期' },
  { key: 'year', label: '年間' },
]

// ─── CSS Bar Chart Components ───

function HBar({ value, max, color, label }: { value: number; max: number; color: string; label?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="text-xs text-gray-600 w-12 text-right whitespace-nowrap">{label}</span>}
    </div>
  )
}

// ─── Main Component ───

export default function DashboardPage() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(currentYm)
  const [period, setPeriod] = useState('month')
  const [siteFilter, setSiteFilter] = useState('all')
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
      const params = new URLSearchParams({ ym, period, site: siteFilter })
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
  }, [password, ym, period, siteFilter])

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
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">ダッシュボード</h1>
          <p className="text-sm text-gray-500 mt-0.5">{todayStr}</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 rounded-lg p-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : data ? (
        <>
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
                        <th className="px-3 py-2 text-right">外注</th>
                        <th className="px-3 py-2 text-right">合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.todayStatus.siteStatus.map((s) => (
                        <tr key={s.siteId} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium text-hibi-navy">{s.siteName}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.tobi}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.doko}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.gaichuCount}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">{s.total}</td>
                        </tr>
                      ))}
                      {/* Totals row */}
                      <tr className="bg-gray-50 font-bold">
                        <td className="px-3 py-2">合計</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.tobi, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.doko, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.gaichuCount, 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {data.todayStatus.siteStatus.reduce((s, r) => s + r.total, 0)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* Absent workers badges */}
                {data.todayStatus.absentWorkers.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-gray-600">
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

          {/* ═══ 2. KPI Cards ═══ */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 総人工数 */}
            <KPICard
              title="総人工数"
              value={fmtNum(data.kpi.totalManDays)}
              unit="人工"
              sub={`自社 ${fmtNum(data.kpi.inHouseManDays)} / 外注 ${fmtNum(data.kpi.subconManDays)}`}
              sub2={`外注率 ${fmtNum(data.kpi.subconRate)}%`}
            />
            {/* 概算売上 */}
            <KPICard
              title="概算売上"
              value={formatYenFull(data.kpi.billing)}
              unit=""
              sub={`原価 ${formatYenFull(data.kpi.cost)}`}
              sub2={`粗利率 ${fmtNum(data.kpi.profitRate)}%`}
              valueColor={profitRateColor(data.kpi.profitRate)}
            />
            {/* 1人あたり労務費 */}
            <KPICard
              title="1人あたり労務費"
              value={data.kpi.laborCostPerPersonAll > 0 ? `¥${Math.round(data.kpi.laborCostPerPersonAll).toLocaleString()}` : '-'}
              unit="/人工"
              sub={`外注込み ¥${Math.round(data.kpi.laborCostPerPersonAll).toLocaleString()}`}
              sub2={`社員のみ ¥${Math.round(data.kpi.laborCostPerPerson).toLocaleString()}`}
            />
            {/* 人工あたり売上 */}
            <KPICard
              title="人工あたり売上"
              value={data.kpi.billingPerManDay > 0 ? `¥${Math.round(data.kpi.billingPerManDay).toLocaleString()}` : '-'}
              unit="/人工"
              sub={`基準 ¥${data.kpi.billingPerManDayBaseline.toLocaleString()}`}
              sub2={`対比 ${fmtNum(data.kpi.billingPerManDayRate)}%`}
              valueColor={data.kpi.billingPerManDayRate >= 100 ? 'text-green-600' : 'text-red-600'}
            />
          </div>

          {/* ═══ 3. Period Selector + 4. Site Tabs ═══ */}
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            {/* Period buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => navigateMonth(-1)}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg font-medium"
              >
                ◀ 前
              </button>
              {PERIOD_OPTIONS.map(po => (
                <button
                  key={po.key}
                  onClick={() => setPeriod(po.key)}
                  className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                    period === po.key
                      ? 'bg-hibi-navy text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                >
                  {po.label}
                </button>
              ))}
              <button
                onClick={() => navigateMonth(1)}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg font-medium"
              >
                次 ▶
              </button>
              <span className="ml-2 text-sm text-gray-500">
                {ymToLabel(ym)}
              </span>
            </div>

            {/* Site tabs */}
            <div className="flex items-center gap-1 flex-wrap">
              <button
                onClick={() => setSiteFilter('all')}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  siteFilter === 'all'
                    ? 'bg-hibi-navy text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                }`}
              >
                全社
              </button>
              {data.siteList.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSiteFilter(s.id)}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                    siteFilter === s.id
                      ? 'bg-hibi-navy text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* ═══ 4b. Site-specific views (member list, donut, trend) ═══ */}
          {siteFilter !== 'all' && data.siteMembers && data.siteMembers.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Member list with donut */}
              <Section title="メンバー一覧">
                <SiteMemberList members={data.siteMembers} />
              </Section>

              {/* Donut chart: tobi vs doko */}
              <Section title="職種構成">
                <DonutChart members={data.siteMembers} />
              </Section>
            </div>
          )}

          {/* Site trend chart */}
          {siteFilter !== 'all' && data.siteTrend && data.siteTrend.length > 1 && (
            <Section title="月次推移（人数・原価）">
              <SiteTrendChart data={data.siteTrend} />
            </Section>
          )}

          {/* ═══ 5. KPI Trend Line Chart (人工あたりKPI) ═══ */}
          {data.monthlyTrend.length > 1 && (
            <Section title="人工あたりKPI推移">
              <CSSLineChart
                data={data.monthlyTrend}
                baseline={data.kpi.billingPerManDayBaseline}
              />
            </Section>
          )}

          {/* ═══ 6. Site Summary Table ═══ */}
          <Section title="現場別サマリー">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">現場</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">自社人工</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">外注人工</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">外注率</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">残業h</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">原価(万)</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">売上(万)</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">粗利(万)</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">粗利率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites
                    .filter(s => s.billing > 0 || s.inHouseWorkDays > 0 || s.subconWorkDays > 0)
                    .map(site => (
                    <tr key={site.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-hibi-navy whitespace-nowrap">{site.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.inHouseWorkDays)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.subconWorkDays)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{site.subconRate.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.otHours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMan(site.cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMan(site.billing)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${profitRateColor(site.profitRate)}`}>
                        {formatMan(site.profit)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${profitRateColor(site.profitRate)}`}>
                        {site.profitRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-hibi-navy text-white font-semibold">
                    <td className="px-3 py-2">合計</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {data.sites.reduce((s, r) => s + r.inHouseWorkDays, 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {data.sites.reduce((s, r) => s + r.subconWorkDays, 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{data.kpi.subconRate.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{data.kpi.otHours.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMan(data.kpi.cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMan(data.kpi.billing)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMan(data.kpi.profit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{data.kpi.profitRate.toFixed(1)}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Section>

          {/* ═══ 7. Site Man-Days Bar Charts ═══ */}
          {data.sites.filter(s => s.inHouseWorkDays > 0 || s.subconWorkDays > 0).length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Tobi / Doko chart - approximate via inHouse total */}
              <Section title="現場別人工数（自社/外注）">
                <div className="space-y-2">
                  {data.sites
                    .filter(s => s.inHouseWorkDays > 0 || s.subconWorkDays > 0)
                    .map(site => {
                    const maxVal = Math.max(
                      ...data.sites.map(s => s.inHouseWorkDays + s.subconWorkDays)
                    )
                    return (
                      <div key={site.id} className="space-y-0.5">
                        <div className="text-xs text-gray-600 font-medium truncate">{site.name}</div>
                        <div className="flex items-center h-5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-l"
                            style={{ width: `${maxVal > 0 ? (site.inHouseWorkDays / maxVal) * 100 : 0}%` }}
                            title={`自社 ${fmtNum(site.inHouseWorkDays)}`}
                          />
                          <div
                            className="h-full bg-orange-400"
                            style={{ width: `${maxVal > 0 ? (site.subconWorkDays / maxVal) * 100 : 0}%` }}
                            title={`外注 ${fmtNum(site.subconWorkDays)}`}
                          />
                        </div>
                        <div className="flex gap-3 text-xs text-gray-500">
                          <span>自社 {fmtNum(site.inHouseWorkDays)}</span>
                          <span>外注 {fmtNum(site.subconWorkDays)}</span>
                        </div>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 border-t">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 自社
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-orange-400 rounded" /> 外注
                    </span>
                  </div>
                </div>
              </Section>

              {/* Billing vs Cost per site */}
              <Section title="現場別 売上/原価">
                <div className="space-y-2">
                  {data.sites
                    .filter(s => s.billing > 0 || s.cost > 0)
                    .map(site => {
                    const maxVal = Math.max(
                      ...data.sites.map(s => Math.max(s.billing, s.cost))
                    )
                    return (
                      <div key={site.id} className="space-y-0.5">
                        <div className="text-xs text-gray-600 font-medium truncate">{site.name}</div>
                        <HBar value={site.billing} max={maxVal} color="bg-blue-500" label={`${formatMan(site.billing)}万`} />
                        <HBar value={site.cost} max={maxVal} color="bg-orange-400" label={`${formatMan(site.cost)}万`} />
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 border-t">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 売上
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-orange-400 rounded" /> 原価
                    </span>
                  </div>
                </div>
              </Section>
            </div>
          )}

          {/* ═══ 8. Daily Attendance Bar Chart ═══ */}
          {data.dailyAttendance && data.dailyAttendance.length > 0 && (
            <Section title="日別稼働人数">
              <div className="overflow-x-auto">
                <div className="flex items-end gap-0.5" style={{ minWidth: `${data.dailyAttendance.length * 24}px`, height: '180px' }}>
                  {data.dailyAttendance.map((da) => {
                    const totalCount = da.sites.reduce((s, st) => s + st.count, 0)
                    const maxDaily = Math.max(
                      ...data.dailyAttendance.map(d => d.sites.reduce((s, st) => s + st.count, 0)),
                      1
                    )
                    return (
                      <div key={da.day} className="flex flex-col items-center" style={{ width: '22px' }}>
                        <div className="flex-1 flex flex-col justify-end w-full" style={{ height: '150px' }}>
                          {da.sites.map((st) => {
                            const segPct = maxDaily > 0 ? (st.count / maxDaily) * 150 : 0
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
                        <div className="text-[10px] text-gray-500 mt-0.5">{da.day}</div>
                        {totalCount > 0 && (
                          <div className="text-[9px] text-gray-400">{totalCount}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {/* Legend */}
                <div className="flex items-center gap-3 pt-2 mt-2 text-xs text-gray-500 border-t flex-wrap">
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

          {/* ═══ 9. Cumulative FY Chart ═══ */}
          {data.cumulativeData && data.cumulativeData.length > 0 && (
            <Section title="累積推移（決算期）">
              <div className="overflow-x-auto">
                <div className="flex items-end gap-1" style={{ minWidth: `${data.cumulativeData.length * 60}px`, height: '220px' }}>
                  {data.cumulativeData.map((cd) => {
                    const maxCum = Math.max(
                      ...data.cumulativeData.map(c => Math.max(c.cumBilling, c.cumCost)),
                      1
                    )
                    const billingH = (cd.cumBilling / maxCum) * 180
                    const costH = (cd.cumCost / maxCum) * 180

                    return (
                      <div key={cd.ym} className="flex flex-col items-center" style={{ width: '56px' }}>
                        <div className="flex items-end gap-0.5" style={{ height: '180px' }}>
                          <div
                            className="w-5 bg-blue-500 rounded-t"
                            style={{ height: `${billingH}px` }}
                            title={`売上 ${formatYenFull(cd.cumBilling)}`}
                          />
                          <div
                            className="w-5 bg-orange-400 rounded-t"
                            style={{ height: `${costH}px` }}
                            title={`原価 ${formatYenFull(cd.cumCost)}`}
                          />
                        </div>
                        {cd.cumProfit !== 0 && (
                          <div className={`text-[9px] font-bold ${cd.cumProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatYenFull(cd.cumProfit)}
                          </div>
                        )}
                        <div className="text-[10px] text-gray-500 mt-0.5">{ymToShortLabel(cd.ym)}</div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-4 pt-2 mt-2 text-xs text-gray-500 border-t">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 累積売上
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-3 bg-orange-400 rounded" /> 累積原価
                  </span>
                  <span className="text-green-600 font-bold">数値=累積粗利</span>
                </div>
              </div>
            </Section>
          )}

          {/* ═══ 10. PL Alert Table ═══ */}
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
                        <td className="px-3 py-2 text-gray-600">{row.org}</td>
                        <td className={`px-3 py-2 text-right font-bold ${
                          row.remaining <= 0 ? 'text-red-600' : row.remaining <= 1 ? 'text-orange-600' : 'text-yellow-600'
                        }`}>
                          {row.remaining.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.totalDays.toFixed(1)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.usedDays.toFixed(1)}</td>
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

          {/* ═══ 11. Foreign Worker Attendance Rate Table ═══ */}
          {data.foreignWorkerRates && data.foreignWorkerRates.length > 0 && (
            <Section title="外国人社員勤怠率">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600">
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">名前</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">所属</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">資格</th>
                      <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">平均</th>
                      {data.ymList.map(m => (
                        <th key={m} className="text-right px-2 py-2 font-semibold whitespace-nowrap text-xs">
                          {ymToShortLabel(m)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.foreignWorkerRates.map(fw => (
                      <tr key={fw.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{fw.name}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${fw.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                            {fw.org === 'hfu' ? 'HFU' : '日比建設'}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${fw.visa === 'jisshu' ? 'bg-orange-100 text-orange-700' : 'bg-teal-100 text-teal-700'}`}>
                            {fw.visa === 'jisshu' ? '技能実習' : fw.visa === 'tokutei' ? '特定技能' : fw.visa}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${rateColorClass(fw.avgRate)}`}>
                            {fw.avgRate.toFixed(0)}%
                          </span>
                        </td>
                        {data.ymList.map(m => {
                          const mr = fw.monthlyRates.find(r => r.ym === m)
                          const rate = mr?.rate || 0
                          return (
                            <td key={m} className="px-2 py-2 text-right">
                              {rate > 0 ? (
                                <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${rateColorClass(rate)}`}>
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
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-white">
        <h2 className="font-bold text-hibi-navy text-sm">{title}</h2>
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  )
}

function KPICard({
  title, value, unit, sub, sub2, valueColor,
}: {
  title: string; value: string; unit: string; sub?: string; sub2?: string; valueColor?: string
}) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-gray-500 mb-1">{title}</div>
      <div className={`text-2xl font-bold ${valueColor || 'text-hibi-navy'}`}>
        {value}
      </div>
      <div className="text-xs text-gray-400">{unit}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1.5">{sub}</div>}
      {sub2 && <div className="text-[11px] text-gray-500">{sub2}</div>}
    </div>
  )
}

/** Enhanced SVG line chart with baseline, color-coded dots, Y-axis labels */
function CSSLineChart({
  data,
  baseline,
}: {
  data: MonthlyTrend[]
  baseline: number
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (data.length === 0) return null

  const allValues = [
    ...data.map(d => d.billingPerManDay),
    ...data.map(d => d.costPerManDay),
    ...data.map(d => d.profitPerManDay),
    baseline,
  ]
  const maxVal = Math.max(...allValues, 1)
  const minVal = Math.min(...allValues.filter(v => v > 0), 0)
  const range = maxVal - minVal || 1

  const svgW = 600
  const svgH = 200
  const padL = 60
  const padR = 16
  const padT = 16
  const padB = 32
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getY = (val: number) => padT + chartH - ((val - minVal) / range) * chartH

  const makePath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(' ')

  const billingPath = makePath(data.map(d => d.billingPerManDay))
  const costPath = makePath(data.map(d => d.costPerManDay))
  const profitPath = makePath(data.map(d => d.profitPerManDay))

  const baselineYPos = getY(baseline)

  // Y-axis labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const val = minVal + (range * i) / 4
    return { val, y: getY(val) }
  })

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '240px' }}>
        {/* Y-axis labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke="#f0f0f0" strokeWidth="1" />
            <text x={padL - 6} y={t.y + 4} textAnchor="end" className="text-[10px]" fill="#9ca3af" fontSize="10">
              {`\u00A5${Math.round(t.val / 1000)}k`}
            </text>
          </g>
        ))}

        {/* Baseline dashed line */}
        <line
          x1={padL} y1={baselineYPos} x2={svgW - padR} y2={baselineYPos}
          stroke="#6b7280" strokeWidth="1.5" strokeDasharray="6 4"
        />
        <text x={svgW - padR + 2} y={baselineYPos - 4} fill="#6b7280" fontSize="9" textAnchor="end">
          {`\u00A5${(baseline / 1000).toFixed(1)}k`}
        </text>

        {/* Lines */}
        <path d={billingPath} fill="none" stroke="#3b82f6" strokeWidth="2" />
        <path d={costPath} fill="none" stroke="#fb923c" strokeWidth="2" />
        <path d={profitPath} fill="none" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="4 2" />

        {/* Dots - billing (color-coded vs baseline) */}
        {data.map((d, i) => (
          <circle
            key={`b-${i}`}
            cx={getX(i)} cy={getY(d.billingPerManDay)} r={hoveredIndex === i ? 6 : 4}
            fill={d.billingPerManDay >= baseline ? '#22c55e' : '#ef4444'}
            stroke="white" strokeWidth="2"
            className="transition-all duration-150 cursor-pointer"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}

        {/* Dots - cost */}
        {data.map((d, i) => (
          <circle
            key={`c-${i}`}
            cx={getX(i)} cy={getY(d.costPerManDay)} r={3}
            fill="#fb923c" stroke="white" strokeWidth="1.5"
          />
        ))}

        {/* Dots - profit */}
        {data.map((d, i) => (
          <circle
            key={`p-${i}`}
            cx={getX(i)} cy={getY(d.profitPerManDay)} r={3}
            fill="#22c55e" stroke="white" strokeWidth="1.5"
          />
        ))}

        {/* X-axis labels */}
        {data.map((d, i) => (
          <text
            key={`x-${i}`}
            x={getX(i)} y={svgH - 4}
            textAnchor="middle" fill="#9ca3af" fontSize="10"
          >
            {ymToShortLabel(d.ym)}
          </text>
        ))}

        {/* Hover tooltip */}
        {hoveredIndex !== null && (() => {
          const d = data[hoveredIndex]
          const tx = getX(hoveredIndex)
          const ty = getY(d.billingPerManDay)
          const tooltipX = tx > svgW / 2 ? tx - 110 : tx + 10
          return (
            <g>
              <rect x={tooltipX} y={Math.max(ty - 50, 4)} width="105" height="48" rx="4" fill="white" stroke="#e5e7eb" strokeWidth="1" />
              <text x={tooltipX + 6} y={Math.max(ty - 50, 4) + 14} fill="#3b82f6" fontSize="10" fontWeight="600">
                {`売上 \u00A5${Math.round(d.billingPerManDay).toLocaleString()}`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 50, 4) + 28} fill="#fb923c" fontSize="10">
                {`原価 \u00A5${Math.round(d.costPerManDay).toLocaleString()}`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 50, 4) + 42} fill="#22c55e" fontSize="10">
                {`差益 \u00A5${Math.round(d.profitPerManDay).toLocaleString()}`}
              </text>
            </g>
          )
        })()}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" /> 売上/人工 (緑=基準以上 赤=基準未満)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-orange-400" /> 原価/人工
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 opacity-70" /> 差益/人工
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 border-t-2 border-dashed border-gray-500" /> 基準
        </span>
      </div>
    </div>
  )
}

// ─── Site-specific components ───

function jobLabel(job: string): string {
  if (job === 'とび' || job === 'tobi' || job === '鳶') return '鳶'
  if (job === 'doko' || job === '土工') return '土工'
  if (job === '職長') return '職長'
  if (job === '役員') return '役員'
  return job || '他'
}

function jobBadgeColor(job: string): string {
  const label = jobLabel(job)
  if (label === '鳶') return 'bg-amber-100 text-amber-800'
  if (label === '土工') return 'bg-stone-100 text-stone-700'
  if (label === '職長') return 'bg-blue-100 text-blue-800'
  if (label === '役員') return 'bg-purple-100 text-purple-800'
  return 'bg-gray-100 text-gray-600'
}

function orgBadgeColor(org: string): string {
  return org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-sky-100 text-sky-700'
}

function visaBadge(visa: string): string {
  if (visa === 'jisshu') return '技能実習'
  if (visa === 'tokutei') return '特定技能'
  if (!visa || visa === 'none' || visa === '') return ''
  return visa
}

/** Compact member cards grouped by org */
function SiteMemberList({ members }: { members: SiteMember[] }) {
  const hibi = members.filter(m => m.org !== 'hfu')
  const hfu = members.filter(m => m.org === 'hfu')

  const renderGroup = (label: string, workers: SiteMember[], badgeClass: string) => {
    if (workers.length === 0) return null
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeClass}`}>{label}</span>
          <span className="text-xs text-gray-400">{workers.length}名</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {workers.map(w => (
            <div
              key={w.id}
              className="flex flex-col gap-1 p-2 bg-gray-50 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors"
            >
              <span className="font-medium text-sm text-hibi-navy truncate">{w.name}</span>
              <div className="flex flex-wrap gap-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${jobBadgeColor(w.job)}`}>
                  {jobLabel(w.job)}
                </span>
                {visaBadge(w.visa) && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-teal-100 text-teal-700">
                    {visaBadge(w.visa)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {renderGroup('日比建設', hibi, 'bg-sky-100 text-sky-700')}
      {renderGroup('HFU', hfu, 'bg-purple-100 text-purple-700')}
      {members.length === 0 && (
        <p className="text-gray-400 text-sm text-center py-4">配置メンバーなし</p>
      )}
    </div>
  )
}

/** SVG donut chart showing tobi vs doko breakdown */
function DonutChart({ members }: { members: SiteMember[] }) {
  const tobi = members.filter(m => {
    const j = m.job || ''
    return j === 'とび' || j === 'tobi' || j === '鳶'
  }).length
  const doko = members.length - tobi
  const total = members.length

  if (total === 0) return <p className="text-gray-400 text-sm text-center py-4">データなし</p>

  const tobiPct = total > 0 ? tobi / total : 0
  const circumference = 2 * Math.PI * 60 // radius=60

  return (
    <div className="flex flex-col items-center">
      <svg width="180" height="180" viewBox="0 0 180 180">
        {/* Background circle */}
        <circle cx="90" cy="90" r="60" fill="none" stroke="#e5e7eb" strokeWidth="24" />

        {/* Doko segment (bottom layer - full circle) */}
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#78716c" strokeWidth="24"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />

        {/* Tobi segment (overlapping from start) */}
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#f59e0b" strokeWidth="24"
          strokeDasharray={`${tobiPct * circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />

        {/* Center text */}
        <text x="90" y="84" textAnchor="middle" fontSize="28" fontWeight="bold" fill="#1e3a5f">
          {total}
        </text>
        <text x="90" y="104" textAnchor="middle" fontSize="12" fill="#9ca3af">
          名
        </text>
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-6 mt-2">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-amber-500" />
          <span className="text-sm text-gray-700">鳶 <span className="font-bold">{tobi}</span>名</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-stone-500" />
          <span className="text-sm text-gray-700">土工 <span className="font-bold">{doko}</span>名</span>
        </div>
      </div>
    </div>
  )
}

/** SVG trend chart: worker count (dots+lines) and cost (bars) per month */
function SiteTrendChart({ data }: { data: SiteTrendPoint[] }) {
  const [hoveredI, setHoveredI] = useState<number | null>(null)

  if (data.length === 0) return null

  const maxWorkers = Math.max(...data.map(d => d.workerCount), 1)
  const maxCost = Math.max(...data.map(d => d.cost), 1)

  const svgW = 600
  const svgH = 200
  const padL = 48
  const padR = 48
  const padT = 16
  const padB = 32
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getWorkerY = (v: number) => padT + chartH - (v / maxWorkers) * chartH
  const getCostY = (v: number) => padT + chartH - (v / maxCost) * chartH

  // Worker count line path
  const workerPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getWorkerY(d.workerCount).toFixed(1)}`
  ).join(' ')

  // Cost line path
  const costPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getCostY(d.cost).toFixed(1)}`
  ).join(' ')

  // Y-axis ticks for workers (left)
  const workerTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxWorkers * i) / 4
    return { val: Math.round(val), y: getWorkerY(val) }
  })

  // Y-axis ticks for cost (right)
  const costTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxCost * i) / 4
    return { val, y: getCostY(val) }
  })

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '240px' }}>
        {/* Grid lines */}
        {workerTicks.map((t, i) => (
          <line key={i} x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke="#f0f0f0" strokeWidth="1" />
        ))}

        {/* Left Y-axis labels (worker count) */}
        {workerTicks.map((t, i) => (
          <text key={`wl-${i}`} x={padL - 6} y={t.y + 4} textAnchor="end" fill="#3b82f6" fontSize="10">
            {t.val}
          </text>
        ))}
        <text x={6} y={padT + chartH / 2} textAnchor="middle" fill="#3b82f6" fontSize="9" transform={`rotate(-90, 6, ${padT + chartH / 2})`}>
          人数
        </text>

        {/* Right Y-axis labels (cost in 万) */}
        {costTicks.map((t, i) => (
          <text key={`cl-${i}`} x={svgW - padR + 6} y={t.y + 4} textAnchor="start" fill="#f59e0b" fontSize="10">
            {Math.round(t.val / 10000)}万
          </text>
        ))}
        <text x={svgW - 6} y={padT + chartH / 2} textAnchor="middle" fill="#f59e0b" fontSize="9" transform={`rotate(90, ${svgW - 6}, ${padT + chartH / 2})`}>
          原価
        </text>

        {/* Cost line */}
        <path d={costPath} fill="none" stroke="#f59e0b" strokeWidth="2" opacity="0.7" />

        {/* Worker count line */}
        <path d={workerPath} fill="none" stroke="#3b82f6" strokeWidth="2.5" />

        {/* Worker dots */}
        {data.map((d, i) => (
          <circle
            key={`wd-${i}`}
            cx={getX(i)} cy={getWorkerY(d.workerCount)} r={hoveredI === i ? 6 : 4}
            fill="#3b82f6" stroke="white" strokeWidth="2"
            className="transition-all duration-150 cursor-pointer"
            onMouseEnter={() => setHoveredI(i)}
            onMouseLeave={() => setHoveredI(null)}
          />
        ))}

        {/* Cost dots */}
        {data.map((d, i) => (
          <circle
            key={`cd-${i}`}
            cx={getX(i)} cy={getCostY(d.cost)} r={3}
            fill="#f59e0b" stroke="white" strokeWidth="1.5"
          />
        ))}

        {/* X-axis labels */}
        {data.map((d, i) => (
          <text key={`xl-${i}`} x={getX(i)} y={svgH - 4} textAnchor="middle" fill="#9ca3af" fontSize="10">
            {ymToShortLabel(d.ym)}
          </text>
        ))}

        {/* Hover tooltip */}
        {hoveredI !== null && (() => {
          const d = data[hoveredI]
          const tx = getX(hoveredI)
          const ty = getWorkerY(d.workerCount)
          const tooltipX = tx > svgW / 2 ? tx - 115 : tx + 10
          return (
            <g>
              <rect x={tooltipX} y={Math.max(ty - 60, 4)} width="110" height="55" rx="4" fill="white" stroke="#e5e7eb" strokeWidth="1" />
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 14} fill="#3b82f6" fontSize="10" fontWeight="600">
                {`人数: ${d.workerCount}名`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 28} fill="#f59e0b" fontSize="10">
                {`原価: ${formatMan(d.cost)}万`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 42} fill="#f59e0b" fontSize="10">
                {`鳶 ${d.tobi} / 土工 ${d.doko}`}
              </text>
            </g>
          )
        })()}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500" /> 人数
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" /> 原価
        </span>
      </div>
    </div>
  )
}

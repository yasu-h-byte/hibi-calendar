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
}

// ─── Helpers ───

function formatMan(value: number): string {
  return (value / 10000).toFixed(1)
}

function formatYen(value: number): string {
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}万`
  }
  return value.toLocaleString()
}

function formatYenFull(value: number): string {
  return `${(value / 10000).toFixed(0)}万`
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
              value={data.kpi.totalManDays.toFixed(1)}
              unit="人工"
              sub={`自社 ${data.kpi.inHouseManDays.toFixed(1)} / 外注 ${data.kpi.subconManDays.toFixed(1)}`}
              sub2={`外注率 ${data.kpi.subconRate.toFixed(1)}%`}
            />
            {/* 概算売上 */}
            <KPICard
              title="概算売上"
              value={formatMan(data.kpi.billing)}
              unit="万円"
              sub={`原価 ${formatMan(data.kpi.cost)}万`}
              sub2={`粗利率 ${data.kpi.profitRate.toFixed(1)}%`}
              valueColor={profitRateColor(data.kpi.profitRate)}
            />
            {/* 1人あたり労務費 */}
            <KPICard
              title="1人あたり労務費"
              value={data.kpi.laborCostPerPersonAll > 0 ? formatYen(data.kpi.laborCostPerPersonAll) : '-'}
              unit="円"
              sub={`外注込み ${data.kpi.laborCostPerPersonAll > 0 ? formatYen(data.kpi.laborCostPerPersonAll) : '-'}`}
              sub2={`社員のみ ${data.kpi.laborCostPerPerson > 0 ? formatYen(data.kpi.laborCostPerPerson) : '-'}`}
            />
            {/* 人工あたり売上 */}
            <KPICard
              title="人工あたり売上"
              value={data.kpi.billingPerManDay > 0 ? formatYen(data.kpi.billingPerManDay) : '-'}
              unit="円"
              sub={`基準 \\${data.kpi.billingPerManDayBaseline.toLocaleString()}`}
              sub2={`対比 ${data.kpi.billingPerManDayRate.toFixed(1)}%`}
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
                      <td className="px-3 py-2 text-right tabular-nums">{site.inHouseWorkDays.toFixed(1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{site.subconWorkDays.toFixed(1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{site.subconRate.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{site.otHours.toFixed(1)}</td>
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
                            title={`自社 ${site.inHouseWorkDays.toFixed(1)}`}
                          />
                          <div
                            className="h-full bg-orange-400"
                            style={{ width: `${maxVal > 0 ? (site.subconWorkDays / maxVal) * 100 : 0}%` }}
                            title={`外注 ${site.subconWorkDays.toFixed(1)}`}
                          />
                        </div>
                        <div className="flex gap-3 text-xs text-gray-500">
                          <span>自社 {site.inHouseWorkDays.toFixed(1)}</span>
                          <span>外注 {site.subconWorkDays.toFixed(1)}</span>
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

/** CSS-only line chart approximation using dots + connecting segments */
function CSSLineChart({
  data,
  baseline,
}: {
  data: MonthlyTrend[]
  baseline: number
}) {
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
  const chartHeight = 160

  const getY = (val: number) => {
    return chartHeight - ((val - minVal) / range) * chartHeight
  }

  const baselineY = getY(baseline)
  const colWidth = data.length > 0 ? Math.max(100 / data.length, 8) : 10

  return (
    <div className="relative" style={{ height: `${chartHeight + 40}px` }}>
      {/* Baseline dashed line */}
      <div
        className="absolute left-0 right-0 border-t-2 border-dashed border-gray-400"
        style={{ top: `${baselineY}px` }}
      >
        <span className="absolute -top-4 right-0 text-[10px] text-gray-500">
          基準 {baseline.toLocaleString()}
        </span>
      </div>

      {/* Data points container */}
      <div className="absolute inset-0 flex items-start" style={{ paddingTop: 0 }}>
        {data.map((d, i) => {
          const billingY = getY(d.billingPerManDay)
          const costY = getY(d.costPerManDay)
          const profitY = getY(d.profitPerManDay)

          return (
            <div
              key={d.ym}
              className="flex flex-col items-center relative"
              style={{ width: `${colWidth}%` }}
            >
              {/* Billing dot */}
              <div
                className="absolute w-2.5 h-2.5 rounded-full bg-blue-500 z-10"
                style={{ top: `${billingY - 5}px` }}
                title={`売上/人工 ${d.billingPerManDay.toLocaleString()}`}
              />
              {/* Cost dot */}
              <div
                className="absolute w-2.5 h-2.5 rounded-full bg-orange-400 z-10"
                style={{ top: `${costY - 5}px` }}
                title={`原価/人工 ${d.costPerManDay.toLocaleString()}`}
              />
              {/* Profit dot */}
              <div
                className="absolute w-2.5 h-2.5 rounded-full bg-green-500 z-10"
                style={{ top: `${profitY - 5}px` }}
                title={`差益/人工 ${d.profitPerManDay.toLocaleString()}`}
              />
              {/* Label */}
              <div
                className="absolute text-[10px] text-gray-500 text-center whitespace-nowrap"
                style={{ top: `${chartHeight + 4}px` }}
              >
                {ymToShortLabel(d.ym)}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div
        className="absolute left-0 flex items-center gap-4 text-xs text-gray-500"
        style={{ top: `${chartHeight + 22}px` }}
      >
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500" /> 売上/人工
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-orange-400" /> 原価/人工
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" /> 差益/人工
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-gray-400" /> 基準
        </span>
      </div>
    </div>
  )
}

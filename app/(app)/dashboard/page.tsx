'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYen, fmtYenMan, fmtNum as fmtNumShared, fmtPct } from '@/lib/format'

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
  perW: number
  perWEst: number
  billingPerManDayBaseline: number
  billingPerManDayRate: number
  otHours: number
  estMonths: number
  // Previous month comparison values
  pctWork: number
  prevTotalManDays: number
  prevBilling: number
  prevCost: number
  prevProfitRate: number
  prevBillingPerManDay: number
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
  subTobi: number
  subDoko: number
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

interface Forecast {
  nextYm: string
  predictedBilling: number
  predictedCost: number
  predictedProfitRate: number
  movingAvgBilling: number[]
  movingAvgCost: number[]
}

interface SubconAlert {
  overallRate: number
  level: 'none' | 'yellow' | 'red'
  sitesAbove50: { id: string; name: string; rate: number }[]
}

interface YoYComparison {
  hasPrevData: boolean
  currentTotal: number
  prevTotal: number
  changeRate: number
  sites: { id: string; name: string; current: number; prev: number; changeRate: number }[]
}

interface SubconAnalysisRow {
  id: string
  name: string
  type: string
  workDays: number
  otCount: number
  cost: number
  rate: number
  otRate: number
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
  forecast: Forecast | null
  subconAlert: SubconAlert | null
  yoyComparison: YoYComparison | null
  subconAnalysis: SubconAnalysisRow[]
}

// ─── Helpers ───

// Use shared formatters from @/lib/format (imported above as fmtYen, fmtYenMan, fmtNumShared, fmtPct)
// Local alias for backward compat within this file
function fmtNum(value: number): string {
  return fmtNumShared(value)
}

function formatYenFull(value: number): string {
  return fmtYenMan(value)
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
      {label && <span className="text-xs text-gray-600 dark:text-gray-400 w-12 text-right whitespace-nowrap">{label}</span>}
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
      {/* Header with period selector (matches old app layout) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">ダッシュボード</h1>
          {data && (
            <div className="flex items-center gap-1">
              <button onClick={() => setSiteFilter('all')}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                  siteFilter === 'all' ? 'bg-hibi-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'
                }`}>全社</button>
              {data.siteList?.filter(s => s.id !== 'all').map(s => (
                <button key={s.id} onClick={() => setSiteFilter(s.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                    siteFilter === s.id ? 'bg-hibi-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'
                  }`}>{s.name.substring(0, 10) + (s.name.length > 10 ? '...' : '')}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(['monthly','3months','6months','fiscal','yearly'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded text-xs font-bold transition ${
                period === p ? 'bg-hibi-navy text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-300'
              }`}>
              {{ monthly: '月次', '3months': '3ヶ月', '6months': '6ヶ月', fiscal: '決算期', yearly: '年間' }[p]}
            </button>
          ))}
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
                      {/* Totals row */}
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
                {/* Absent workers badges */}
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

          {/* ═══ 2. KPI Cards (4-card grid) ═══ */}
          {(() => {
            const k = data.kpi
            const baseline = k.billingPerManDayBaseline
            const bpmBaselinePct = baseline > 0 ? (k.billingPerManDay / baseline) * 100 : 0
            const isAboveBaseline = k.billingPerManDay >= baseline

            return (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 総人工数 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <div className="flex items-center gap-1 text-xs font-semibold mb-1">
                    <span className="text-gray-500 dark:text-gray-400">総人工数</span>
                    {k.prevTotalManDays > 0 && k.pctWork !== 0 && (
                      <span className={`text-[10px] font-bold ${k.pctWork > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {k.pctWork > 0 ? '▲' : '▼'}{Math.abs(Math.round(k.pctWork))}%
                      </span>
                    )}
                  </div>
                  <div className="text-2xl font-bold text-hibi-navy dark:text-white tabular-nums">
                    {fmtNum(k.totalManDays)}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">人工</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                    <div>自社{fmtNum(k.inHouseManDays)}/外注{fmtNum(k.subconManDays)}</div>
                    <div>外注率 {fmtPct(k.subconRate)}</div>
                  </div>
                </div>

                {/* 売上 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <div className="flex items-center gap-1 text-xs font-semibold mb-1">
                    <span className="text-gray-500 dark:text-gray-400">
                      {k.estMonths > 0 ? '概算売上' : '確定売上'}
                    </span>
                    {k.estMonths > 0 && (
                      <span className="text-orange-500 text-[10px] font-medium">出面概算{k.estMonths}ヶ月含</span>
                    )}
                    {k.billing > 0 && (
                      <span className={`${k.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        ({k.profit >= 0 ? '+' : '-'})
                      </span>
                    )}
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ${k.billing === 0 ? 'text-gray-400' : 'text-hibi-navy dark:text-white'}`}>
                    {k.billing === 0 ? '未入力' : fmtYenMan(k.billing)}
                  </div>
                  {k.billing > 0 && <div className="text-xs text-gray-400 dark:text-gray-500">万円</div>}
                  {k.billing > 0 && (
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                      <div>原価{fmtYenMan(k.cost)}</div>
                      <div className={k.profit >= 0 ? 'text-green-600' : 'text-red-600'}>
                        粗利{fmtYenMan(k.profit)}({fmtPct(k.profitRate)})
                      </div>
                    </div>
                  )}
                </div>

                {/* 1人あたり労務費 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <div className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-1">1人あたり労務費</div>
                  <div className="text-2xl font-bold text-hibi-navy dark:text-white tabular-nums">
                    {fmtYen(k.laborCostPerPersonAll)}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">/人工</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                    <div>外注込み {fmtYen(k.laborCostPerPersonAll)}</div>
                    <div>社員のみ {fmtYen(k.laborCostPerPerson)}</div>
                  </div>
                </div>

                {/* 人工あたり売上 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
                  <div className="flex items-center gap-1 text-xs font-semibold mb-1">
                    <span className="text-gray-500 dark:text-gray-400">人工あたり売上</span>
                    {k.estMonths > 0 && (
                      <span className="text-orange-500 text-[10px] font-medium">概算含</span>
                    )}
                    {k.billingPerManDay > 0 && (
                      <span className={`${isAboveBaseline ? 'text-green-600' : 'text-red-600'}`}>
                        ({isAboveBaseline ? '+' : '-'})
                      </span>
                    )}
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ${isAboveBaseline ? 'text-green-600' : 'text-red-600'}`}>
                    {(() => {
                      const displayValue = k.estMonths > 0 ? k.perWEst : k.perW
                      return displayValue > 0 ? fmtYen(displayValue) : '-'
                    })()}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">/人工</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                    {k.estMonths > 0 && k.perW > 0 && (
                      <div>確定{fmtYen(k.perW)}</div>
                    )}
                    <div>基準{fmtYen(baseline)} {fmtPct(bpmBaselinePct)}</div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ═══ 人工あたりKPIチャート（ファーストビュー重要指標）═══ */}
          {data.monthlyTrend && data.monthlyTrend.length > 0 && (
            <Section title={`人工あたり KPI${siteFilter === 'all' ? '全社' : ''}（${(() => {
              const firstYm = data.monthlyTrend[0].ym
              const m = parseInt(firstYm.slice(4, 6))
              const y = parseInt(firstYm.slice(0, 4))
              const fy = m >= 10 ? y : y - 1
              return `${fy}年度`
            })()}）`}>
              <KPILineChart data={data.monthlyTrend} baseline={data.kpi.billingPerManDayBaseline} />
            </Section>
          )}

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

          {/* KPI Trend chart moved above (after KPI cards) */}

          {/* ═══ 6. Site Summary Table ═══ */}
          <Section title="現場別サマリー">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 dark:text-gray-400">
                    <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">現場</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">自社人工</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">外注人工</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">外注率</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">残業h</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">原価</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">売上</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">粗利</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">粗利率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites
                    .filter(s => s.billing > 0 || s.inHouseWorkDays > 0 || s.subconWorkDays > 0)
                    .map(site => (
                    <tr key={site.id} className="border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-3 py-2 font-medium text-hibi-navy whitespace-nowrap">{site.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.inHouseWorkDays)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.subconWorkDays)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtPct(site.subconRate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(site.otHours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtYenMan(site.cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtYenMan(site.billing)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${profitRateColor(site.profitRate)}`}>
                        {fmtYenMan(site.profit)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${profitRateColor(site.profitRate)}`}>
                        {fmtPct(site.profitRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-hibi-navy text-white font-semibold">
                    <td className="px-3 py-2">合計</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtNum(data.sites.reduce((s, r) => s + r.inHouseWorkDays, 0))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtNum(data.sites.reduce((s, r) => s + r.subconWorkDays, 0))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(data.kpi.subconRate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(data.kpi.otHours)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtYenMan(data.kpi.cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtYenMan(data.kpi.billing)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtYenMan(data.kpi.profit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(data.kpi.profitRate)}</td>
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
                        <div className="text-xs text-gray-600 dark:text-gray-400 font-medium truncate">{site.name}</div>
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
                        <div className="flex gap-3 text-xs text-gray-500 dark:text-gray-400">
                          <span>自社 {fmtNum(site.inHouseWorkDays)}</span>
                          <span>外注 {fmtNum(site.subconWorkDays)}</span>
                        </div>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 dark:text-gray-400 border-t">
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
                        <div className="text-xs text-gray-600 dark:text-gray-400 font-medium truncate">{site.name}</div>
                        <HBar value={site.billing} max={maxVal} color="bg-blue-500" label={fmtYenMan(site.billing)} />
                        <HBar value={site.cost} max={maxVal} color="bg-orange-400" label={fmtYenMan(site.cost)} />
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 dark:text-gray-400 border-t">
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
                <div className="flex items-center gap-4 pt-2 mt-2 text-xs text-gray-500 dark:text-gray-400 border-t">
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

          {/* ═══ Subcon Cost Analysis ═══ */}
          {data.subconAnalysis && data.subconAnalysis.length > 0 && (
            <Section title="外注先別コスト分析">
              {/* Horizontal bar chart */}
              <div className="space-y-1.5 mb-4">
                {data.subconAnalysis.map(sc => {
                  const maxCost = data.subconAnalysis[0].cost || 1
                  const pct = Math.min((sc.cost / maxCost) * 100, 100)
                  const barColor = sc.type === '鳶業者' ? 'bg-blue-500' : 'bg-amber-500'
                  return (
                    <div key={sc.id} className="flex items-center gap-2">
                      <span className="text-xs text-gray-700 dark:text-gray-300 w-20 truncate shrink-0" title={sc.name}>{sc.name}</span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-600 dark:text-gray-400 w-16 text-right shrink-0 whitespace-nowrap">{fmtYenMan(sc.cost)}</span>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 mb-3">
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 鳶業者</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-amber-500 rounded" /> 土工業者</span>
              </div>
              {/* Compact table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">
                      <th className="text-left py-1 pr-2">外注先</th>
                      <th className="text-left py-1 pr-2">区分</th>
                      <th className="text-right py-1 pr-2">人工数</th>
                      <th className="text-right py-1 pr-2">残業</th>
                      <th className="text-right py-1 pr-2">単価</th>
                      <th className="text-right py-1">合計金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.subconAnalysis.map(sc => (
                      <tr key={sc.id} className="border-b border-gray-100 dark:border-gray-700">
                        <td className="py-1 pr-2 text-gray-800 dark:text-gray-200">{sc.name}</td>
                        <td className="py-1 pr-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            sc.type === '鳶業者' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                          }`}>{sc.type}</span>
                        </td>
                        <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-300">{fmtNum(sc.workDays)}</td>
                        <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-300">{fmtNum(sc.otCount)}</td>
                        <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-300">{fmtYen(sc.rate)}</td>
                        <td className="py-1 text-right font-medium text-gray-800 dark:text-gray-200">{fmtYen(sc.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 dark:border-gray-500 font-bold text-gray-800 dark:text-gray-200">
                      <td className="py-1 pr-2" colSpan={2}>合計</td>
                      <td className="py-1 pr-2 text-right">{fmtNum(data.subconAnalysis.reduce((s, sc) => s + sc.workDays, 0))}</td>
                      <td className="py-1 pr-2 text-right">{fmtNum(data.subconAnalysis.reduce((s, sc) => s + sc.otCount, 0))}</td>
                      <td className="py-1 pr-2"></td>
                      <td className="py-1 text-right">{fmtYen(data.subconAnalysis.reduce((s, sc) => s + sc.cost, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Section>
          )}

          {/* ═══ Site Profitability Ranking ═══ */}
          {data.sites.filter(s => s.billing > 0 || s.cost > 0).length > 0 && (
            <SiteProfitRanking sites={data.sites} />
          )}

          {/* ═══ YoY Labor Cost Comparison ═══ */}
          {data.yoyComparison && (
            <Section title="人件費の対前年比較">
              {data.yoyComparison.hasPrevData ? (
                <div className="space-y-4">
                  {/* Overall comparison */}
                  <div className="flex items-center gap-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <div className="text-sm text-gray-600 dark:text-gray-400">当期合計</div>
                    <div className="font-bold text-hibi-navy dark:text-blue-300">{formatYenFull(data.yoyComparison.currentTotal)}</div>
                    <div className="text-sm text-gray-400">vs</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">前年 {formatYenFull(data.yoyComparison.prevTotal)}</div>
                    <div className={`font-bold text-sm flex items-center gap-1 ${
                      data.yoyComparison.changeRate > 0 ? 'text-red-600' : data.yoyComparison.changeRate < 0 ? 'text-green-600' : 'text-gray-600 dark:text-gray-400'
                    }`}>
                      {data.yoyComparison.changeRate > 0 ? '\u2191' : data.yoyComparison.changeRate < 0 ? '\u2193' : '\u2192'}
                      {fmtPct(Math.abs(data.yoyComparison.changeRate))}
                    </div>
                  </div>
                  {/* Per-site table */}
                  {data.yoyComparison.sites.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 text-gray-600 dark:text-gray-400">
                            <th className="text-left px-3 py-2 font-semibold">現場</th>
                            <th className="text-right px-3 py-2 font-semibold">当期</th>
                            <th className="text-right px-3 py-2 font-semibold">前年</th>
                            <th className="text-right px-3 py-2 font-semibold">増減率</th>
                            <th className="px-3 py-2 font-semibold w-32">対比</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.yoyComparison.sites.map(s => {
                            const maxCost = Math.max(...data.yoyComparison!.sites.map(x => Math.max(x.current, x.prev)), 1)
                            return (
                              <tr key={s.id} className="border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                                <td className="px-3 py-2 font-medium text-hibi-navy whitespace-nowrap">{s.name}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{formatYenFull(s.current)}</td>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                                  {s.prev > 0 ? formatYenFull(s.prev) : '-'}
                                </td>
                                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                                  s.prev === 0 ? 'text-gray-400' : s.changeRate > 0 ? 'text-red-600' : 'text-green-600'
                                }`}>
                                  {s.prev > 0 ? (
                                    <>
                                      {s.changeRate > 0 ? '\u2191' : '\u2193'}
                                      {fmtPct(Math.abs(s.changeRate))}
                                    </>
                                  ) : 'NEW'}
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-1 h-4">
                                    <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden relative">
                                      <div className="h-full bg-blue-500 rounded-l absolute left-0 top-0"
                                        style={{ width: `${(s.current / maxCost) * 100}%` }} />
                                      {s.prev > 0 && (
                                        <div className="h-0.5 bg-gray-400 absolute top-1/2 -translate-y-1/2"
                                          style={{ width: `${(s.prev / maxCost) * 100}%`, left: 0 }} />
                                      )}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 border-t pt-2">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 当期
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-1 bg-gray-400 rounded" /> 前年
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-gray-400 text-sm py-4 text-center">前年データなし</p>
              )}
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

          {/* ═══ 11. Foreign Worker Attendance Rate (Enhanced) ═══ */}
          {data.foreignWorkerRates && data.foreignWorkerRates.length > 0 && (
            <>
              {/* Alert: workers below 90% */}
              {(() => {
                const lowWorkers = data.foreignWorkerRates.filter(fw => fw.avgRate < 90 && fw.avgRate > 0)
                if (lowWorkers.length === 0) return null
                return (
                  <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
                    <div className="font-bold text-red-800 text-sm mb-2">
                      出勤率90%未満の外国人社員 ({lowWorkers.length}名)
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {lowWorkers.sort((a, b) => a.avgRate - b.avgRate).map(fw => (
                        <span key={fw.id} className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                          fw.avgRate < 80 ? 'bg-red-200 text-red-900' : 'bg-orange-200 text-orange-900'
                        }`}>
                          {fw.name}: {fw.avgRate.toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })()}

              <Section title="外国人社員勤怠率分析">
                {/* Overall average */}
                {(() => {
                  const validRates = data.foreignWorkerRates.filter(fw => fw.avgRate > 0)
                  const overallAvg = validRates.length > 0
                    ? validRates.reduce((s, fw) => s + fw.avgRate, 0) / validRates.length
                    : 0
                  return (
                    <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                      <span className="text-sm text-gray-600 dark:text-gray-400">全体平均出勤率:</span>
                      <span className={`text-lg font-bold px-2.5 py-0.5 rounded ${
                        overallAvg >= 95 ? 'bg-green-100 text-green-800' :
                        overallAvg >= 90 ? 'bg-yellow-100 text-yellow-800' :
                        'bg-red-100 text-red-800'
                      }`}>
                        {overallAvg.toFixed(1)}%
                      </span>
                      <span className="text-xs text-gray-400">
                        ({overallAvg >= 95 ? '良好' : overallAvg >= 90 ? '要注意' : '要改善'})
                      </span>
                    </div>
                  )
                })()}

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
                      {data.foreignWorkerRates.map(fw => (
                        <tr key={fw.id} className={`border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                          fw.avgRate > 0 && fw.avgRate < 90 ? 'bg-red-50/30' : ''
                        }`}>
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
            </>
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


/** SVG line chart for 人工あたりKPI with value labels and MoM % changes */
function KPILineChart({
  data,
  baseline,
}: {
  data: MonthlyTrend[]
  baseline: number
}) {
  if (data.length === 0) return null

  const COLORS = {
    billing: '#2563EB',
    cost: '#EA580C',
    profit: '#16A34A',
    baseline: '#DC2626',
    grid: '#E5E7EB',
  }

  // Average values for legend (across all active months in the chart)
  const activeData = data.filter(d => d.billingPerManDay > 0 || d.costPerManDay > 0 || d.profitPerManDay > 0)
  const avgBilling = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.billingPerManDay, 0) / activeData.length)
    : 0
  const avgCost = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.costPerManDay, 0) / activeData.length)
    : 0
  const avgProfit = avgBilling - avgCost

  // Chart dimensions
  const svgW = 800
  const svgH = 400
  const padL = 70
  const padR = 20
  const padT = 50
  const padB = 40
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  // Value range
  const allValues = [
    ...data.map(d => d.billingPerManDay),
    ...data.map(d => d.costPerManDay),
    ...data.map(d => d.profitPerManDay),
    baseline,
  ]
  const rawMax = Math.max(...allValues, 1)
  const rawMin = Math.min(...allValues.filter(v => v > 0), 0)
  // Add 15% padding for labels
  const range = rawMax - rawMin || 1
  const maxVal = rawMax + range * 0.15
  const minVal = Math.max(rawMin - range * 0.1, 0)
  const yRange = maxVal - minVal || 1

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getY = (val: number) => padT + chartH - ((val - minVal) / yRange) * chartH

  // Build smooth line paths
  const makePath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(' ')

  const billingPath = makePath(data.map(d => d.billingPerManDay))
  const costPath = makePath(data.map(d => d.costPerManDay))
  const profitPath = makePath(data.map(d => d.profitPerManDay))

  // Y-axis gridlines (5 ticks)
  const yTickCount = 5
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const val = minVal + (yRange * i) / yTickCount
    return { val, y: getY(val) }
  })

  const baselineY = getY(baseline)

  // MoM % change helper
  const momPct = (curr: number, prev: number) => {
    if (prev === 0) return ''
    const pct = ((curr - prev) / prev) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
  }

  return (
    <div>
      {/* Legend row */}
      <div className="flex items-center justify-end gap-4 text-xs mb-2 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 h-0.5" style={{ backgroundColor: COLORS.billing }} />
          <span className="text-gray-600 dark:text-gray-400">売上 {fmtYen(avgBilling)}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 h-0.5" style={{ backgroundColor: COLORS.cost }} />
          <span className="text-gray-600 dark:text-gray-400">原価 {fmtYen(avgCost)}</span>
        </span>
        <span className={`font-bold ${avgProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          差益 {avgProfit >= 0 ? '+' : ''}{fmtYen(avgProfit)}
        </span>
      </div>

      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '400px' }} preserveAspectRatio="xMidYMid meet">
        {/* Y-axis gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke={COLORS.grid} strokeWidth="1" />
            <text x={padL - 8} y={t.y + 4} textAnchor="end" fill="#9ca3af" fontSize="11">
              {fmtYen(t.val)}
            </text>
          </g>
        ))}

        {/* Baseline dashed line */}
        <line
          x1={padL} y1={baselineY} x2={svgW - padR} y2={baselineY}
          stroke={COLORS.baseline} strokeWidth="1.5" strokeDasharray="8 4"
        />
        <text x={svgW - padR - 4} y={baselineY - 6} textAnchor="end" fill={COLORS.baseline} fontSize="10" fontWeight="600">
          基準{fmtYen(baseline)}
        </text>

        {/* Lines */}
        <path d={billingPath} fill="none" stroke={COLORS.billing} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={costPath} fill="none" stroke={COLORS.cost} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={profitPath} fill="none" stroke={COLORS.profit} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Dots and value labels - billing */}
        {data.map((d, i) => {
          const x = getX(i)
          const y = getY(d.billingPerManDay)
          return (
            <g key={`bl-${i}`}>
              <circle cx={x} cy={y} r={4} fill={COLORS.billing} stroke="white" strokeWidth="2" />
              <text x={x} y={y - 10} textAnchor="middle" fill={COLORS.billing} fontSize="9" fontWeight="600">
                {fmtYen(d.billingPerManDay)}
              </text>
              {/* MoM % between points */}
              {i > 0 && (() => {
                const pct = momPct(d.billingPerManDay, data[i - 1].billingPerManDay)
                if (!pct) return null
                const mx = (getX(i - 1) + x) / 2
                const my = (getY(data[i - 1].billingPerManDay) + y) / 2
                return (
                  <text x={mx} y={my - 8} textAnchor="middle" fill={COLORS.billing} fontSize="8" opacity="0.7">
                    {pct}
                  </text>
                )
              })()}
            </g>
          )
        })}

        {/* Dots and value labels - cost */}
        {data.map((d, i) => {
          const x = getX(i)
          const y = getY(d.costPerManDay)
          return (
            <g key={`cl-${i}`}>
              <circle cx={x} cy={y} r={4} fill={COLORS.cost} stroke="white" strokeWidth="2" />
              <text x={x} y={y + 16} textAnchor="middle" fill={COLORS.cost} fontSize="9" fontWeight="600">
                {fmtYen(d.costPerManDay)}
              </text>
              {i > 0 && (() => {
                const pct = momPct(d.costPerManDay, data[i - 1].costPerManDay)
                if (!pct) return null
                const mx = (getX(i - 1) + x) / 2
                const my = (getY(data[i - 1].costPerManDay) + y) / 2
                return (
                  <text x={mx} y={my + 16} textAnchor="middle" fill={COLORS.cost} fontSize="8" opacity="0.7">
                    {pct}
                  </text>
                )
              })()}
            </g>
          )
        })}

        {/* Dots and value labels - profit */}
        {data.map((d, i) => {
          const x = getX(i)
          const y = getY(d.profitPerManDay)
          return (
            <g key={`pl-${i}`}>
              <circle cx={x} cy={y} r={3.5} fill={COLORS.profit} stroke="white" strokeWidth="1.5" />
              {/* Only show profit value if it doesn't overlap too much */}
              {(i === 0 || i === data.length - 1 || i % 2 === 0) && (
                <text x={x + 8} y={y + 4} textAnchor="start" fill={COLORS.profit} fontSize="8" fontWeight="600">
                  {fmtYen(d.profitPerManDay)}
                </text>
              )}
            </g>
          )
        })}

        {/* X-axis labels */}
        {data.map((d, i) => (
          <text
            key={`x-${i}`}
            x={getX(i)} y={svgH - 8}
            textAnchor="middle" fill="#6b7280" fontSize="11"
          >
            {ymToShortLabel(d.ym)}
          </text>
        ))}
      </svg>

      {/* Bottom legend */}
      <div className="flex items-center gap-5 text-xs text-gray-500 dark:text-gray-400 mt-1 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.billing }} /> 売上/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.cost }} /> 原価/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.profit }} /> 差益/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: COLORS.baseline }} /> 基準
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
  return 'bg-gray-100 text-gray-600 dark:text-gray-400'
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

/** Mini sparkline for attendance rates */
function MiniSparkline({ rates }: { rates: { ym: string; rate: number }[] }) {
  if (rates.length === 0) return <span className="text-gray-300 text-xs">-</span>

  const w = 80
  const h = 24
  const pad = 2
  const chartW = w - pad * 2
  const chartH = h - pad * 2

  // Scale: 70-100% range for better visibility
  const minR = 70
  const maxR = 100
  const range = maxR - minR

  const getX = (i: number) => pad + (rates.length > 1 ? (i / (rates.length - 1)) * chartW : chartW / 2)
  const getY = (v: number) => pad + chartH - ((Math.max(Math.min(v, maxR), minR) - minR) / range) * chartH

  const path = rates.map((r, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(r.rate).toFixed(1)}`).join(' ')

  // Line color based on latest rate
  const latestRate = rates[rates.length - 1]?.rate || 0
  const lineColor = latestRate >= 95 ? '#22c55e' : latestRate >= 90 ? '#eab308' : '#ef4444'

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="inline-block">
      {/* 90% threshold line */}
      <line x1={pad} y1={getY(90)} x2={w - pad} y2={getY(90)} stroke="#fecaca" strokeWidth="0.5" />
      <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" />
      {rates.map((r, i) => (
        <circle key={i} cx={getX(i)} cy={getY(r.rate)} r={1.5} fill={lineColor} />
      ))}
    </svg>
  )
}

/** Site profitability ranking with horizontal bar chart */
function SiteProfitRanking({ sites }: { sites: SiteRow[] }) {
  const [sortBy, setSortBy] = useState<'rate' | 'profit'>('rate')

  const validSites = sites.filter(s => s.billing > 0 || s.cost > 0)
  const sorted = [...validSites].sort((a, b) =>
    sortBy === 'rate' ? b.profitRate - a.profitRate : b.profit - a.profit
  )

  const maxAbsProfit = Math.max(...sorted.map(s => Math.abs(s.profit)), 1)
  const maxAbsRate = Math.max(...sorted.map(s => Math.abs(s.profitRate)), 1)

  return (
    <Section title="現場別利益率ランキング">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-gray-500 dark:text-gray-400">並び順:</span>
        <button
          onClick={() => setSortBy('rate')}
          className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
            sortBy === 'rate' ? 'bg-hibi-navy text-white' : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400'
          }`}
        >
          利益率順
        </button>
        <button
          onClick={() => setSortBy('profit')}
          className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
            sortBy === 'profit' ? 'bg-hibi-navy text-white' : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400'
          }`}
        >
          利益額順
        </button>
      </div>

      <div className="space-y-2">
        {sorted.map((site, idx) => {
          const isPositive = sortBy === 'rate' ? site.profitRate >= 0 : site.profit >= 0
          const barValue = sortBy === 'rate' ? Math.abs(site.profitRate) : Math.abs(site.profit)
          const barMax = sortBy === 'rate' ? maxAbsRate : maxAbsProfit
          const pct = barMax > 0 ? Math.min((barValue / barMax) * 100, 100) : 0

          return (
            <div key={site.id} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 w-4 text-right">{idx + 1}</span>
              <span className="text-xs font-medium text-hibi-navy w-24 truncate" title={site.name}>
                {site.name}
              </span>
              <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isPositive ? 'bg-green-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center gap-2 w-36 justify-end">
                <span className={`text-xs font-bold tabular-nums ${
                  site.profitRate >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {fmtPct(site.profitRate)}
                </span>
                <span className={`text-xs tabular-nums ${
                  site.profit >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {fmtYen(site.profit)}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {sorted.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">データなし</p>
      )}
    </Section>
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
                {`原価: ${fmtYenMan(d.cost)}`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 42} fill="#f59e0b" fontSize="10">
                {`鳶 ${d.tobi} / 土工 ${d.doko}`}
              </text>
            </g>
          )
        })()}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
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

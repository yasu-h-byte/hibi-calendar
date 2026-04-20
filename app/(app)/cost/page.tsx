'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYen, fmtYenMan, fmtNum, fmtPct } from '@/lib/format'

// ─── Types ───

interface SiteProfit {
  id: string; name: string
  billing: number; billingRaw?: number; billingByMonth: Record<string, number[]>
  cost: number; costRaw?: number; subCost: number; totalCost: number
  profit: number; profitRate: number; workDays: number; subWorkDays: number
  tobiEquiv: number; tobiRate: number; tobiBase: number
  dispatchDeduction?: number
}

interface SubconSiteBreakdown {
  siteId: string; siteName: string; workDays: number; otCount: number; cost: number
}

interface SubconCostDetail {
  id: string; name: string; type: string; rate: number; otRate: number
  workDays: number; otCount: number; cost: number
  siteBreakdown: SubconSiteBreakdown[]
}

interface MonthlyTrend {
  ym: string
  billing: number
  cost: number
  profit: number
  manDays: number
  equiv: number
  billingPerManDay: number
  costPerManDay: number
  profitPerManDay: number
  inHouseWorkDays: number
  subconWorkDays: number
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

interface KPIExtended {
  totalManDays: number
  inHouseManDays: number
  subconManDays: number
  subconRate: number
  billing: number
  billingRaw: number
  cost: number
  profit: number
  profitRate: number
  perW: number
  perWEst: number
  billingPerManDay: number
  billingPerManDayBaseline: number
  laborCostPerPerson: number
  laborCostPerPersonAll: number
  estMonths: number
  pctWork: number
  prevTotalManDays: number
  prevBilling: number
  prevCost: number
  prevProfitRate: number
  prevBillingPerManDay: number
  otHours: number
}

interface SiteOption {
  id: string; name: string
}

interface SiteMember {
  id: number; name: string; org: string; visa: string; job: string
}

interface SiteTrendPoint {
  ym: string; workerCount: number; cost: number; tobi: number; doko: number
}

interface CostData {
  sites: SiteProfit[]
  subconDetails: SubconCostDetail[]
  ymRange: string[]
  totals: {
    billing: number; cost: number; subCost: number; totalCost: number
    profit: number; profitRate: number; workDays: number; subWorkDays: number
    otHours: number; dispatchDeduction?: number; billingRaw?: number; costRaw?: number
  }
  monthlyTrend: MonthlyTrend[]
  cumulativeData: CumulativeData[]
  kpiExtended: KPIExtended
  siteList: SiteOption[]
  siteMembers: SiteMember[] | null
  siteTrend: SiteTrendPoint[] | null
}

type PeriodType = 'monthly' | '3months' | '6months' | 'fiscal' | 'yearly'

// ─── Helpers ───

function ymToShortLabel(ym: string): string {
  const m = parseInt(ym.slice(4, 6))
  return `${m}月`
}

function jobLabel(job: string): string {
  if (job === 'とび' || job === 'tobi' || job === '鳶') return '鳶'
  if (job === 'doko' || job === '土工') return '土工'
  if (job === '職長' || job === 'shokucho') return '職長'
  if (job === '役員' || job === 'yakuin') return '役員'
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

// ─── Main Component ───

export default function CostPage() {
  const [password, setPassword] = useState('')
  const [data, setData] = useState<CostData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodType>('monthly')
  const [siteFilter, setSiteFilter] = useState('all')
  const [ym, setYm] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  // Local billing edits: siteId_ym -> number[]
  const [billingEdits, setBillingEdits] = useState<Record<string, number[]>>({})
  const [expandedBilling, setExpandedBilling] = useState<string | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ ym, period, site: siteFilter })
      const res = await fetch(`/api/cost?${params}`, { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const d = await res.json()
        setData(d)
        // Initialize billing edits from data
        const edits: Record<string, number[]> = {}
        for (const site of d.sites) {
          for (const [m, arr] of Object.entries(site.billingByMonth as Record<string, number[]>)) {
            edits[`${site.id}_${m}`] = arr.length > 0 ? [...arr] : [0]
          }
        }
        setBillingEdits(edits)
      }
    } finally {
      setLoading(false)
    }
  }, [password, ym, period, siteFilter])

  useEffect(() => { fetchData() }, [fetchData])

  const profitColor = (r: number) => r > 15 ? 'text-green-600' : r > 0 ? 'text-yellow-600' : 'text-red-600'

  const ymOptions: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear(); const m = d.getMonth() + 1
    ymOptions.push({ value: `${y}${String(m).padStart(2, '0')}`, label: `${y}年${m}月` })
  }

  const ymLabel = (m: string) => `${parseInt(m.slice(4))}月`

  // Period navigation (prev/next month)
  const navigateMonth = (direction: -1 | 1) => {
    const y = parseInt(ym.slice(0, 4))
    const m = parseInt(ym.slice(4, 6))
    const d = new Date(y, m - 1 + direction, 1)
    setYm(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const ymDisplayLabel = `${parseInt(ym.slice(0, 4))}年${parseInt(ym.slice(4))}月`

  const isMultiMonth = period !== 'monthly'
  const ymRange = data?.ymRange || [ym]

  // Save billing for a site+month
  const saveBilling = async (siteId: string, month: string, amounts: number[]) => {
    await fetch('/api/cost', {
      method: 'POST',
      headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, ym: month, amounts }),
    })
    fetchData()
  }

  // Update a billing row value locally
  const updateBillingRow = (siteId: string, month: string, rowIndex: number, value: number) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr[rowIndex] = value
      return { ...prev, [key]: arr }
    })
  }

  // Add billing row
  const addBillingRow = (siteId: string, month: string) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0]), 0]
      return { ...prev, [key]: arr }
    })
  }

  // Remove billing row
  const removeBillingRow = (siteId: string, month: string, rowIndex: number) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr.splice(rowIndex, 1)
      if (arr.length === 0) arr.push(0)
      return { ...prev, [key]: arr }
    })
  }

  const t = data?.totals
  const kpi = data?.kpiExtended
  // Max total cost for bar chart scaling
  const maxCost = data ? Math.max(...data.sites.map(s => s.cost + s.subCost), 1) : 1

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">原価・収益管理</h1>
          {/* Site filter */}
          {data && data.siteList && data.siteList.length > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={() => setSiteFilter('all')}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                  siteFilter === 'all' ? 'bg-hibi-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'
                }`}>全現場</button>
              {data.siteList.map(s => (
                <button key={s.id} onClick={() => setSiteFilter(s.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                    siteFilter === s.id ? 'bg-hibi-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'
                  }`}>{s.name.substring(0, 10) + (s.name.length > 10 ? '...' : '')}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {([['monthly', '月次'], ['3months', '3ヶ月'], ['6months', '6ヶ月'], ['fiscal', '決算期'], ['yearly', '年間']] as [PeriodType, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setPeriod(key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                  period === key ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={() => navigateMonth(-1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">◀前</button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[80px] text-center">{ymDisplayLabel}</span>
          <button onClick={() => navigateMonth(1)} className="px-2 py-1 text-sm text-gray-500 hover:text-hibi-navy dark:text-gray-400">次▶</button>
          <select value={ym} onChange={e => setYm(e.target.value)} className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
            {ymOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* 出向控除バナー */}
      {t && t.dispatchDeduction && t.dispatchDeduction > 0 && (
        <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 rounded-xl px-4 py-3 text-xs text-purple-700 dark:text-purple-300">
          出向中スタッフの人件費 <span className="font-bold">{fmtYen(t.dispatchDeduction)}</span> を人件費から差し引いています（売上は既に控除済みの値が入力されています）。
          {t.billingRaw && <span className="ml-2 text-gray-500">（控除前: 売上 {fmtYen(t.billingRaw)} / 人件費 {fmtYen(t.costRaw || 0)}）</span>}
        </div>
      )}

      {/* ═══ KPI Cards (expanded) ═══ */}
      {kpi && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-hibi-navy tabular-nums">{fmtYenMan(kpi.billing)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {kpi.estMonths > 0 ? '概算売上' : '確定売上'}
              {kpi.estMonths > 0 && <span className="text-orange-500 ml-1">(概算{kpi.estMonths}ヶ月含)</span>}
            </div>
            {kpi.billing > 0 && (
              <div className="text-[11px] text-gray-500 mt-1">
                <span className={kpi.profit >= 0 ? 'text-green-600' : 'text-red-600'}>
                  粗利{fmtYenMan(kpi.profit)}({fmtPct(kpi.profitRate)})
                </span>
              </div>
            )}
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className={`text-2xl font-bold tabular-nums ${profitColor(kpi.profitRate)}`}>{fmtYenMan(kpi.profit)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">粗利（{fmtPct(kpi.profitRate)}）</div>
            <div className="text-[11px] text-gray-500 mt-1">
              原価{fmtYenMan(kpi.cost)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-hibi-navy tabular-nums">
              {(() => {
                const displayValue = kpi.estMonths > 0 ? kpi.perWEst : kpi.perW
                return displayValue > 0 ? fmtYen(displayValue) : '-'
              })()}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">人工あたり売上</div>
            <div className="text-[11px] text-gray-500 mt-1">
              基準{fmtYen(kpi.billingPerManDayBaseline)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 text-center">
            <div className="text-2xl font-bold text-blue-600 tabular-nums">{fmtYen(kpi.laborCostPerPersonAll)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">1人あたり労務費</div>
            <div className="text-[11px] text-gray-500 mt-1 space-y-0.5">
              <div>外注率 {fmtPct(kpi.subconRate)}</div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ KPI Trend Chart ═══ */}
      {data && data.monthlyTrend && data.monthlyTrend.length > 0 && kpi && (
        <Section title={`人工あたり KPI${siteFilter === 'all' ? '（全現場）' : ''}（${(() => {
          const firstYm = data.monthlyTrend[0].ym
          const m = parseInt(firstYm.slice(4, 6))
          const y = parseInt(firstYm.slice(0, 4))
          const fy = m >= 10 ? y : y - 1
          return `${fy}年度`
        })()}）`}>
          <KPILineChart data={data.monthlyTrend} baseline={kpi.billingPerManDayBaseline} />
        </Section>
      )}

      {/* ═══ Site Members + Donut (when site filter active) ═══ */}
      {siteFilter !== 'all' && data?.siteMembers && data.siteMembers.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Section title="メンバー一覧">
            <SiteMemberList members={data.siteMembers} />
          </Section>
          <Section title="職種構成">
            <DonutChart members={data.siteMembers} />
          </Section>
        </div>
      )}

      {/* ═══ Site Trend Chart (when site filter active) ═══ */}
      {siteFilter !== 'all' && data?.siteTrend && data.siteTrend.length > 1 && (
        <Section title="月次推移（人数・原価）">
          <SiteTrendChart data={data.siteTrend} />
        </Section>
      )}

      {/* ═══ Cumulative FY Chart ═══ */}
      {data && data.cumulativeData && data.cumulativeData.length > 0 && (
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
                        title={`売上 ${fmtYenMan(cd.cumBilling)}`}
                      />
                      <div
                        className="w-5 bg-orange-400 rounded-t"
                        style={{ height: `${costH}px` }}
                        title={`原価 ${fmtYenMan(cd.cumCost)}`}
                      />
                    </div>
                    {cd.cumProfit !== 0 && (
                      <div className={`text-[9px] font-bold ${cd.cumProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {fmtYenMan(cd.cumProfit)}
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

      {/* ═══ Site profit table ═══ */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-3 py-3 whitespace-nowrap">現場</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">
                請求額
                {isMultiMonth && <span className="text-xs text-gray-400 ml-1">（合計）</span>}
              </th>
              <th className="px-3 py-3 text-right whitespace-nowrap">社員人件費</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">外注費</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">原価計</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">粗利</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">粗利率</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">鳶換算人工</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">人工あたり売上</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : !data || data.sites.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : (
              <>
                {data.sites.map(s => {
                  return (
                    <tr key={s.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 align-top">
                      <td className="px-3 py-2.5 font-medium">
                        {s.name}
                        {s.dispatchDeduction && s.dispatchDeduction > 0 && (
                          <span
                            className="ml-1.5 text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-bold"
                            title={`出向控除: -${fmtYen(s.dispatchDeduction)}（人件費から差引）`}
                          >
                            -{fmtYen(s.dispatchDeduction)}
                          </span>
                        )}
                      </td>
                      {/* Billing column with multiple rows */}
                      <td className="px-3 py-2 text-right">
                        {isMultiMonth ? (
                          /* Multi-month: show total, click to expand monthly detail */
                          <div>
                            <button
                              onClick={() => setExpandedBilling(prev => prev === s.id ? null : s.id)}
                              className="text-right w-full font-bold tabular-nums hover:text-hibi-navy transition"
                            >
                              {fmtYen(s.billing)}
                              <span className="text-[10px] text-gray-400 ml-1">{expandedBilling === s.id ? '▲' : '▼'}</span>
                            </button>
                            {expandedBilling === s.id && (
                              <div className="mt-2 border-t border-gray-100 dark:border-gray-700 pt-2 space-y-1">
                                {ymRange.map(m => {
                                  const key = `${s.id}_${m}`
                                  const rows = billingEdits[key] || [0]
                                  const monthTotal = rows.reduce((a: number, b: number) => a + b, 0)
                                  return (
                                    <div key={m} className="flex items-center justify-between text-xs">
                                      <span className="text-gray-500 w-8">{ymLabel(m)}</span>
                                      <span className="tabular-nums">{monthTotal > 0 ? fmtYen(monthTotal) : '—'}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          /* Single month: show billing rows with add/remove */
                          <div className="space-y-0.5">
                            {(() => {
                              const key = `${s.id}_${ym}`
                              const rows = billingEdits[key] || [0]
                              return (
                                <>
                                  {rows.map((val, ri) => (
                                    <div key={ri} className="flex items-center justify-end gap-1">
                                      <input
                                        type="text"
                                        defaultValue={val ? val.toLocaleString() : ''}
                                        placeholder="0"
                                        onFocus={(e) => { e.target.value = String(Number(e.target.value.replace(/,/g, '')) || '') }}
                                        onBlur={(e) => {
                                          const v = Number(e.target.value.replace(/,/g, '')) || 0
                                          e.target.value = v ? v.toLocaleString() : ''
                                          updateBillingRow(s.id, ym, ri, v)
                                          const updated = [...rows]
                                          updated[ri] = v
                                          saveBilling(s.id, ym, updated)
                                        }}
                                        className="w-28 text-right border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1 text-sm tabular-nums focus:ring-1 focus:ring-hibi-navy focus:outline-none"
                                      />
                                      {rows.length > 1 && (
                                        <button onClick={() => { removeBillingRow(s.id, ym, ri); const updated = [...rows]; updated.splice(ri, 1); saveBilling(s.id, ym, updated.length > 0 ? updated : [0]) }}
                                          className="text-gray-300 hover:text-red-400 text-sm leading-none w-4">x</button>
                                      )}
                                    </div>
                                  ))}
                                  <button onClick={() => addBillingRow(s.id, ym)}
                                    className="text-[11px] text-blue-400 hover:text-blue-600">+ 行追加</button>
                                  {rows.length > 1 && (
                                    <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums border-t border-gray-100 pt-0.5">
                                      計: {fmtYen(rows.reduce((a, b) => a + b, 0))}
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.cost)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.subCost)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(s.totalCost)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${profitColor(s.profitRate)}`}>{fmtYen(s.profit)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(s.profitRate)}`}>{fmtPct(s.profitRate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {s.tobiEquiv > 0 ? fmtNum(s.tobiEquiv) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {s.tobiEquiv > 0 ? (
                          <span>
                            {fmtYen(Math.round(s.billing / s.tobiEquiv))}
                            {s.tobiBase > 0 && (
                              <span className={`ml-1 text-xs font-medium ${Math.round(s.billing / s.tobiEquiv) >= s.tobiBase ? 'text-blue-600' : 'text-red-600'}`}>
                                {Math.round(s.billing / s.tobiEquiv / s.tobiBase * 100)}%
                              </span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
                {t && (
                  <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold">
                    <td className="px-3 py-2.5">合計</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.billing)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.cost)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.subCost)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(t.totalCost)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(t.profitRate)}`}>{fmtYen(t.profit)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${profitColor(t.profitRate)}`}>{fmtPct(t.profitRate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">—</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {(t.workDays + t.subWorkDays) > 0
                        ? fmtYen(Math.round(t.billing / (t.workDays + t.subWorkDays)))
                        : '—'}
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Cost Bar Chart */}
      {data && data.sites.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4">
          <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-3">現場別原価バーチャート</h2>
          <div className="space-y-2">
            {data.sites
              .filter(s => s.cost > 0 || s.subCost > 0)
              .sort((a, b) => (b.cost + b.subCost) - (a.cost + a.subCost))
              .map(s => {
                const total = s.cost + s.subCost
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="w-24 text-xs text-gray-700 truncate text-right flex-shrink-0">{s.name}</div>
                    <div className="flex-1 flex items-center h-6">
                      <div className="flex h-full rounded-lg overflow-hidden transition-all duration-500 ease-out"
                        style={{ width: `${Math.max((total / maxCost) * 100, 2)}%` }}>
                        {s.cost > 0 && (
                          <div
                            className="bg-blue-500 h-full transition-all duration-500"
                            style={{ width: `${total > 0 ? (s.cost / total) * 100 : 0}%` }}
                            title={`自社: ${fmtYen(s.cost)}`}
                          />
                        )}
                        {s.subCost > 0 && (
                          <div
                            className="bg-orange-400 h-full transition-all duration-500"
                            style={{ width: `${total > 0 ? (s.subCost / total) * 100 : 0}%` }}
                            title={`外注: ${fmtYen(s.subCost)}`}
                          />
                        )}
                      </div>
                    </div>
                    <div className="w-24 text-xs text-gray-600 dark:text-gray-400 tabular-nums text-right flex-shrink-0">{fmtYen(total)}</div>
                  </div>
                )
              })}
          </div>
          <div className="flex gap-4 mt-3 pt-2 border-t border-gray-100">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-blue-500" />
              <span className="text-xs text-gray-600 dark:text-gray-400">自社人件費</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-orange-400" />
              <span className="text-xs text-gray-600 dark:text-gray-400">外注費</span>
            </div>
          </div>
        </div>
      )}

      {/* Subcon cost detail table */}
      {data && data.subconDetails && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
          <div className="px-4 py-3 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
            <h2 className="text-sm font-bold text-hibi-navy dark:text-white">外注先別原価明細</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                <th className="px-3 py-3">外注先</th>
                <th className="px-3 py-3 text-right">人工単価</th>
                <th className="px-3 py-3 text-right">残業単価</th>
                <th className="px-3 py-3 text-right">人工数</th>
                <th className="px-3 py-3 text-right">残業人数</th>
                <th className="px-3 py-3 text-right">合計金額</th>
              </tr>
            </thead>
            <tbody>
              {data.subconDetails.map(sc => {
                const hasWork = sc.workDays > 0
                return (
                  <tr key={sc.id} className={`border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${!hasWork ? 'opacity-50' : ''}`}>
                    <td className={`px-3 py-2.5 font-medium ${!hasWork ? 'italic text-gray-400' : ''}`}>
                      {sc.name}
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${sc.type === '鳶業者' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{sc.type}</span>
                      {!hasWork && <span className="ml-2 text-xs text-gray-400">稼働なし</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtYen(sc.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{sc.otRate ? fmtYen(sc.otRate) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(sc.workDays)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(sc.otCount)}</td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmtYen(sc.cost)}</td>
                  </tr>
                )
              })}
              {/* Grand total footer */}
              <tr className="border-t-2 border-hibi-navy dark:border-blue-400 bg-gray-50 dark:bg-gray-700 font-bold">
                <td className="px-3 py-2.5">合計</td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(data.subconDetails.reduce((s, sc) => s + sc.workDays, 0))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(data.subconDetails.reduce((s, sc) => s + sc.otCount, 0))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {fmtYen(data.subconDetails.reduce((s, sc) => s + sc.cost, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-white dark:bg-gray-800">
        <h2 className="font-bold text-hibi-navy dark:text-blue-300 text-sm">{title}</h2>
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  )
}

/** SVG line chart for per-worker KPIs */
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

  const activeData = data.filter(d => d.billingPerManDay > 0 || d.costPerManDay > 0 || d.profitPerManDay > 0)
  const avgBilling = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.billingPerManDay, 0) / activeData.length)
    : 0
  const avgCost = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.costPerManDay, 0) / activeData.length)
    : 0
  const avgProfit = avgBilling - avgCost

  const svgW = 800
  const svgH = 400
  const padL = 70
  const padR = 20
  const padT = 50
  const padB = 40
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const allValues = [
    ...data.map(d => d.billingPerManDay),
    ...data.map(d => d.costPerManDay),
    ...data.map(d => d.profitPerManDay),
    baseline,
  ]
  const rawMax = Math.max(...allValues, 1)
  const rawMin = Math.min(...allValues.filter(v => v > 0), 0)
  const range = rawMax - rawMin || 1
  const maxVal = rawMax + range * 0.15
  const minVal = Math.max(rawMin - range * 0.1, 0)
  const yRange = maxVal - minVal || 1

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getY = (val: number) => padT + chartH - ((val - minVal) / yRange) * chartH

  const makePath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(' ')

  const billingPath = makePath(data.map(d => d.billingPerManDay))
  const costPath = makePath(data.map(d => d.costPerManDay))

  const barW = 30
  const zeroY = Math.min(getY(0), padT + chartH)

  const yTickCount = 5
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const val = minVal + (yRange * i) / yTickCount
    return { val, y: getY(val) }
  })

  const baselineY = getY(baseline)

  const momPct = (curr: number, prev: number) => {
    if (prev === 0) return ''
    const pct = ((curr - prev) / prev) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
  }

  return (
    <div>
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
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke={COLORS.grid} strokeWidth="1" />
            <text x={padL - 8} y={t.y + 4} textAnchor="end" fill="#9ca3af" fontSize="11">
              {fmtYen(t.val)}
            </text>
          </g>
        ))}

        {/* 基準線 */}
        <line
          x1={padL} y1={baselineY} x2={svgW - padR} y2={baselineY}
          stroke={COLORS.baseline} strokeWidth="1.5" strokeDasharray="8 4"
        />

        {/* 差益バー */}
        {data.map((d, i) => {
          const x = getX(i)
          const val = d.profitPerManDay
          const barTop = val >= 0 ? getY(val) : zeroY
          const barBottom = val >= 0 ? zeroY : getY(val)
          const h = barBottom - barTop
          return (
            <rect
              key={`bar-${i}`}
              x={x - barW / 2}
              y={barTop}
              width={barW}
              height={Math.max(h, 1)}
              fill={val >= 0 ? COLORS.profit : '#DC2626'}
              opacity={0.7}
              rx={2}
            />
          )
        })}

        {/* 折れ線 */}
        <path d={billingPath} fill="none" stroke={COLORS.billing} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={costPath} fill="none" stroke={COLORS.cost} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

        {/* 全ラベルを衝突回避しながら描画 */}
        {data.map((d, i) => {
          const x = getX(i)
          const bY = getY(d.billingPerManDay)
          const cY = getY(d.costPerManDay)
          const pVal = d.profitPerManDay
          const pBarTop = pVal >= 0 ? getY(pVal) : zeroY

          // ラベル候補Y（初期位置）
          let bLabelY = bY - 12       // 売上: ドットの上
          let cLabelY = cY + 18       // 原価: ドットの下
          let pLabelY = pBarTop - 6   // 差益: バーの上

          // 基準線との衝突回避（売上ラベルが基準線と重なる場合）
          if (Math.abs(bLabelY - baselineY) < 14) {
            bLabelY = baselineY - 18
          }

          // 売上と原価ラベルの衝突回避
          const MIN_GAP = 16
          if (cLabelY - bLabelY < MIN_GAP) {
            // 売上を上に、原価を下に押す
            const mid = (bLabelY + cLabelY) / 2
            bLabelY = mid - MIN_GAP / 2
            cLabelY = mid + MIN_GAP / 2
          }

          // 原価ラベルと差益ラベルの衝突回避
          if (Math.abs(cLabelY - pLabelY) < MIN_GAP) {
            pLabelY = cLabelY + MIN_GAP
          }

          // 差益バーの下に原価ラベルが入り込む場合
          if (cLabelY < pBarTop + 8 && cLabelY > pBarTop - 20) {
            cLabelY = pBarTop + 22
          }

          const showProfit = i === 0 || i === data.length - 1 || i % 2 === 0

          return (
            <g key={`labels-${i}`}>
              {/* 売上ドット+ラベル */}
              <circle cx={x} cy={bY} r={4} fill={COLORS.billing} stroke="white" strokeWidth="2" />
              <text x={x} y={bLabelY} textAnchor="middle" fill={COLORS.billing} fontSize="9" fontWeight="600">
                {fmtYen(d.billingPerManDay)}
              </text>

              {/* 原価ドット+ラベル */}
              <circle cx={x} cy={cY} r={4} fill={COLORS.cost} stroke="white" strokeWidth="2" />
              <text x={x} y={cLabelY} textAnchor="middle" fill={COLORS.cost} fontSize="9" fontWeight="600">
                {fmtYen(d.costPerManDay)}
              </text>

              {/* 差益ラベル */}
              {showProfit && (
                <text x={x} y={pLabelY} textAnchor="middle"
                  fill={pVal >= 0 ? COLORS.profit : '#DC2626'} fontSize="8" fontWeight="600">
                  {fmtYen(pVal)}
                </text>
              )}
            </g>
          )
        })}

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

      <div className="flex items-center gap-5 text-xs text-gray-500 dark:text-gray-400 mt-1 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.billing }} /> 売上/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.cost }} /> 原価/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: COLORS.profit, opacity: 0.7 }} /> 差益/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: COLORS.baseline }} /> 基準
        </span>
      </div>
    </div>
  )
}

/** Site member list grouped by org */
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
  const circumference = 2 * Math.PI * 60

  return (
    <div className="flex flex-col items-center">
      <svg width="180" height="180" viewBox="0 0 180 180">
        <circle cx="90" cy="90" r="60" fill="none" stroke="#e5e7eb" strokeWidth="24" />
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#78716c" strokeWidth="24"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#f59e0b" strokeWidth="24"
          strokeDasharray={`${tobiPct * circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />
        <text x="90" y="84" textAnchor="middle" fontSize="28" fontWeight="bold" fill="#1e3a5f">
          {total}
        </text>
        <text x="90" y="104" textAnchor="middle" fontSize="12" fill="#9ca3af">
          名
        </text>
      </svg>
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

/** SVG trend chart: worker count and cost per month */
function SiteTrendChart({ data }: { data: SiteTrendPoint[] }) {
  const [hoveredI, setHoveredI] = useState<number | null>(null)

  if (data.length === 0) return null

  const maxWorkers = Math.max(...data.map(d => d.workerCount), 1)
  const maxCostVal = Math.max(...data.map(d => d.cost), 1)

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
  const getCostY = (v: number) => padT + chartH - (v / maxCostVal) * chartH

  const workerPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getWorkerY(d.workerCount).toFixed(1)}`
  ).join(' ')

  const costPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getCostY(d.cost).toFixed(1)}`
  ).join(' ')

  const workerTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxWorkers * i) / 4
    return { val: Math.round(val), y: getWorkerY(val) }
  })

  const costTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxCostVal * i) / 4
    return { val, y: getCostY(val) }
  })

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '240px' }}>
        {workerTicks.map((t, i) => (
          <line key={i} x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke="#f0f0f0" strokeWidth="1" />
        ))}

        {workerTicks.map((t, i) => (
          <text key={`wl-${i}`} x={padL - 6} y={t.y + 4} textAnchor="end" fill="#3b82f6" fontSize="10">
            {t.val}
          </text>
        ))}
        <text x={6} y={padT + chartH / 2} textAnchor="middle" fill="#3b82f6" fontSize="9" transform={`rotate(-90, 6, ${padT + chartH / 2})`}>
          人数
        </text>

        {costTicks.map((t, i) => (
          <text key={`cl-${i}`} x={svgW - padR + 6} y={t.y + 4} textAnchor="start" fill="#f59e0b" fontSize="10">
            {Math.round(t.val / 10000)}万
          </text>
        ))}
        <text x={svgW - 6} y={padT + chartH / 2} textAnchor="middle" fill="#f59e0b" fontSize="9" transform={`rotate(90, ${svgW - 6}, ${padT + chartH / 2})`}>
          原価
        </text>

        <path d={costPath} fill="none" stroke="#f59e0b" strokeWidth="2" opacity="0.7" />
        <path d={workerPath} fill="none" stroke="#3b82f6" strokeWidth="2.5" />

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

        {data.map((d, i) => (
          <circle
            key={`cd-${i}`}
            cx={getX(i)} cy={getCostY(d.cost)} r={3}
            fill="#f59e0b" stroke="white" strokeWidth="1.5"
          />
        ))}

        {data.map((d, i) => (
          <text key={`xl-${i}`} x={getX(i)} y={svgH - 4} textAnchor="middle" fill="#9ca3af" fontSize="10">
            {ymToShortLabel(d.ym)}
          </text>
        ))}

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

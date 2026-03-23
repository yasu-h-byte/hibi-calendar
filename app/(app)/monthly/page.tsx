'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { formatYen } from '@/lib/compute'

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
  otMul: number
  sites: string[]
  workDays: number
  otHours: number
  plDays: number
  restDays: number
  siteOffDays: number
  cost: number
  otCost: number
  totalCost: number
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

interface MonthlyData {
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
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
  const [data, setData] = useState<MonthlyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Worker sort
  const [workerSortKey, setWorkerSortKey] = useState<WorkerSortKey>('name')
  const [workerSortAsc, setWorkerSortAsc] = useState(true)

  // Subcon sort
  const [subconSortKey, setSubconSortKey] = useState<SubconSortKey>('name')
  const [subconSortAsc, setSubconSortAsc] = useState(true)

  const ymOptions = useMemo(() => getYmOptions(12), [])

  // Read auth
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        setPassword(pw)
      } catch { /* ignore */ }
    }
  }, [])

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
    } catch (e) {
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [password, ym])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Worker filtering & sorting ──

  const filteredWorkers = useMemo(() => {
    if (!data) return []
    if (tab === 'hibi') return data.workers.filter(w => w.org === 'hibi')
    if (tab === 'hfu') return data.workers.filter(w => w.org === 'hfu')
    return data.workers
  }, [data, tab])

  const sortedWorkers = useMemo(() => {
    const list = [...filteredWorkers]
    list.sort((a, b) => {
      let cmp = 0
      switch (workerSortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'org': cmp = a.org.localeCompare(b.org); break
        case 'workDays': cmp = a.workDays - b.workDays; break
        case 'plDays': cmp = a.plDays - b.plDays; break
        case 'otHours': cmp = a.otHours - b.otHours; break
        case 'rate': cmp = a.rate - b.rate; break
        case 'totalCost': cmp = a.totalCost - b.totalCost; break
      }
      return workerSortAsc ? cmp : -cmp
    })
    return list
  }, [filteredWorkers, workerSortKey, workerSortAsc])

  const workerTotals = useMemo(() => {
    return {
      workDays: filteredWorkers.reduce((s, w) => s + w.workDays, 0),
      plDays: filteredWorkers.reduce((s, w) => s + w.plDays, 0),
      otHours: filteredWorkers.reduce((s, w) => s + w.otHours, 0),
      totalCost: filteredWorkers.reduce((s, w) => s + w.totalCost, 0),
    }
  }, [filteredWorkers])

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

  // ── Render ──

  const isWorkerTab = tab !== 'subcon'

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header & controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy">月次集計</h1>
          {data && (
            <p className="text-sm text-gray-500 mt-1">
              出勤延べ {data.totals.workDays}人日 / 外注 {data.totals.subWorkDays}人工 / 残業 {data.totals.otHours}h
            </p>
          )}
        </div>
        <select
          value={ym}
          onChange={e => setYm(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-hibi-navy focus:outline-none"
        >
          {ymOptions.map(o => (
            <option key={o.ym} value={o.ym}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key
                ? 'bg-hibi-navy text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="bg-white rounded-xl shadow p-8 text-center text-gray-400">
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Worker Table (全体 / 日比建設 / HFU) */}
      {!loading && data && isWorkerTab && (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-600">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
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
                >
                  残業(h){sortArrow(workerSortKey === 'otHours', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('rate')}
                >
                  日額単価{sortArrow(workerSortKey === 'rate', workerSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleWorkerSort('totalCost')}
                >
                  概算労務費{sortArrow(workerSortKey === 'totalCost', workerSortAsc)}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedWorkers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              ) : (
                sortedWorkers.map(w => (
                  <tr key={w.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap">{w.name}</td>
                    <td className="px-3 py-2.5">{orgBadge(w.org)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{w.workDays}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {w.plDays > 0 ? w.plDays : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {w.otHours > 0 ? w.otHours.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                      {formatYen(w.rate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                      {formatYen(Math.round(w.totalCost))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {sortedWorkers.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-hibi-navy bg-gray-50 font-bold text-hibi-navy">
                  <td className="px-3 py-3">合計 ({filteredWorkers.length}名)</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3 text-right tabular-nums">{workerTotals.workDays}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{workerTotals.plDays}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{workerTotals.otHours.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatYen(Math.round(workerTotals.totalCost))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Subcon Table (外注) */}
      {!loading && data && !isWorkerTab && (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-600">
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleSubconSort('name')}
                >
                  外注先{sortArrow(subconSortKey === 'name', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap"
                  onClick={() => toggleSubconSort('type')}
                >
                  区分{sortArrow(subconSortKey === 'type', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('workDays')}
                >
                  人工計{sortArrow(subconSortKey === 'workDays', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('otCount')}
                >
                  残業人数{sortArrow(subconSortKey === 'otCount', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('rate')}
                >
                  単価{sortArrow(subconSortKey === 'rate', subconSortAsc)}
                </th>
                <th
                  className="px-3 py-3 cursor-pointer hover:text-hibi-navy whitespace-nowrap text-right"
                  onClick={() => toggleSubconSort('cost')}
                >
                  金額{sortArrow(subconSortKey === 'cost', subconSortAsc)}
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
                  <tr key={sc.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap">{sc.name}</td>
                    <td className="px-3 py-2.5">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                        {TYPE_LABELS[sc.type] || sc.type}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{sc.workDays}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {sc.otCount > 0 ? sc.otCount : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                      {formatYen(sc.rate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                      {formatYen(Math.round(sc.cost))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {sortedSubcons.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-hibi-navy bg-gray-50 font-bold text-hibi-navy">
                  <td className="px-3 py-3">合計 ({data!.subcons.length}社)</td>
                  <td className="px-3 py-3"></td>
                  <td className="px-3 py-3 text-right tabular-nums">{subconTotals.workDays}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{subconTotals.otCount}</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatYen(Math.round(subconTotals.cost))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  )
}

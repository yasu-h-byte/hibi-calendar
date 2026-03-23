'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'

// ────────────────────────────────────────
//  Types
// ────────────────────────────────────────

interface SiteOption {
  id: string
  name: string
}

interface Worker {
  id: number
  name: string
  org: string
  visa: string
  job: string
}

interface Subcon {
  id: string
  name: string
  type: string
}

interface AttEntry {
  w: number
  o?: number
  r?: number
  p?: number
  h?: number
  s?: string
}

interface SubconDayEntry {
  n: number
  on: number
}

interface GridData {
  site: SiteOption
  year: number
  month: number
  daysInMonth: number
  ym: string
  workers: Worker[]
  subcons: Subcon[]
  workerEntries: Record<string, Record<number, AttEntry>>
  subconEntries: Record<string, Record<number, SubconDayEntry>>
  locked: boolean
  sites: SiteOption[]
}

// ────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土']

function currentYm(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getYmOptions(count: number): { ym: string; label: string }[] {
  const result: { ym: string; label: string }[] = []
  const now = new Date()
  for (let i = -2; i < count; i++) {
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

function getDow(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getDay()
}

function isToday(year: number, month: number, day: number): boolean {
  const now = new Date()
  return now.getFullYear() === year && now.getMonth() + 1 === month && now.getDate() === day
}

function dayColBg(year: number, month: number, day: number): string {
  if (isToday(year, month, day)) return 'bg-amber-50'
  const dow = getDow(year, month, day)
  if (dow === 0) return 'bg-red-50'
  if (dow === 6) return 'bg-blue-50'
  return ''
}

function dayHeaderBg(year: number, month: number, day: number): string {
  if (isToday(year, month, day)) return 'bg-amber-100'
  const dow = getDow(year, month, day)
  if (dow === 0) return 'bg-red-100'
  if (dow === 6) return 'bg-blue-100'
  return 'bg-gray-100'
}

function dayTextColor(dow: number): string {
  if (dow === 0) return 'text-red-600'
  if (dow === 6) return 'text-blue-600'
  return 'text-gray-700'
}

// ────────────────────────────────────────
//  Component
// ────────────────────────────────────────

export default function AttendanceGridPage() {
  const [password, setPassword] = useState('')
  const [ym, setYm] = useState(currentYm)
  const [siteId, setSiteId] = useState('')
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  // Local state for entries (for instant UI updates)
  const [workerEntries, setWorkerEntries] = useState<Record<string, Record<number, AttEntry | null>>>({})
  const [subconEntries, setSubconEntries] = useState<Record<string, Record<number, SubconDayEntry | null>>>({})

  const saveTimer = useRef<NodeJS.Timeout | null>(null)
  const ymOptions = useMemo(() => getYmOptions(14), [])

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

  // Fetch grid data
  const fetchData = useCallback(async () => {
    if (!password || !siteId || !ym) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/attendance/grid?siteId=${siteId}&ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) {
        const msg = await res.text()
        setError(msg || 'データ取得に失敗しました')
        setData(null)
        return
      }
      const json: GridData = await res.json()
      setData(json)
      setWorkerEntries(json.workerEntries)
      setSubconEntries(json.subconEntries)
    } catch {
      setError('通信エラーが発生しました')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [password, siteId, ym])

  useEffect(() => { fetchData() }, [fetchData])

  // On first load with sites, select first site if none selected
  useEffect(() => {
    if (data && data.sites.length > 0 && !siteId) {
      setSiteId(data.sites[0].id)
    }
  }, [data, siteId])

  // Initial site load: fetch with a temporary siteId to get sites list
  useEffect(() => {
    if (!password || siteId) return
    const loadSites = async () => {
      setLoading(true)
      try {
        // Fetch with a dummy site to get the sites list - the API returns sites regardless
        const res = await fetch(`/api/attendance/grid?siteId=__list__&ym=${ym}`, {
          headers: { 'x-admin-password': password },
        })
        if (res.ok) {
          const json = await res.json()
          if (json.sites && json.sites.length > 0) {
            setSiteId(json.sites[0].id)
          }
        } else {
          // Try fetching sites from a different approach - use first available site
          // Fall through to let main fetch handle it
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    loadSites()
  }, [password, ym, siteId])

  // ── Save helpers ──

  const saveWorkerEntry = useCallback(async (
    workerId: number | string,
    day: number,
    entry: AttEntry | null,
  ) => {
    if (!password || !data) return
    setSaving(`w-${workerId}-${day}`)
    try {
      await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          siteId: data.site.id,
          ym: data.ym,
          workerId,
          day,
          entry,
        }),
      })
    } catch (e) {
      console.error('Save error:', e)
    } finally {
      setSaving(null)
    }
  }, [password, data])

  const saveSubconEntry = useCallback(async (
    subconId: string,
    day: number,
    subconEntry: SubconDayEntry | null,
  ) => {
    if (!password || !data) return
    setSaving(`s-${subconId}-${day}`)
    try {
      await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          siteId: data.site.id,
          ym: data.ym,
          subconId,
          day,
          subconEntry,
        }),
      })
    } catch (e) {
      console.error('Save error:', e)
    } finally {
      setSaving(null)
    }
  }, [password, data])

  // ── Worker cell handlers ──

  const handleWorkChange = useCallback((workerId: string, day: number, value: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }

      let entry: AttEntry | null = null
      if (value === '1') {
        entry = { w: 1, o: 0 }
      } else if (value === '0.5') {
        entry = { w: 0.5, o: 0 }
      } else if (value === 'P') {
        entry = { w: 0, p: 1 }
      }

      if (entry) {
        entries[day] = entry
      } else {
        delete entries[day]
      }
      next[workerId] = entries
      return next
    })

    let entry: AttEntry | null = null
    if (value === '1') entry = { w: 1, o: 0 }
    else if (value === '0.5') entry = { w: 0.5, o: 0 }
    else if (value === 'P') entry = { w: 0, p: 1 }

    saveWorkerEntry(workerId, day, entry)
  }, [saveWorkerEntry])

  const handleOtChange = useCallback((workerId: string, day: number, otValue: string) => {
    const ot = parseFloat(otValue) || 0
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day]
      if (existing && existing.w > 0) {
        entries[day] = { ...existing, o: ot }
      }
      next[workerId] = entries
      return next
    })

    // Get current entry to preserve w value
    const current = workerEntries[workerId]?.[day]
    if (current && current.w > 0) {
      saveWorkerEntry(workerId, day, { ...current, o: ot })
    }
  }, [saveWorkerEntry, workerEntries])

  // ── Subcon cell handlers ──

  const handleSubconNChange = useCallback((subconId: string, day: number, value: string) => {
    const n = parseFloat(value) || 0
    setSubconEntries(prev => {
      const next = { ...prev }
      if (!next[subconId]) next[subconId] = {}
      const entries = { ...next[subconId] }
      const existing = entries[day]
      if (n > 0 || (existing && existing.on > 0)) {
        entries[day] = { n, on: existing?.on ?? 0 }
      } else {
        delete entries[day]
      }
      next[subconId] = entries
      return next
    })

    const existing = subconEntries[subconId]?.[day]
    const on = existing?.on ?? 0
    if (n > 0 || on > 0) {
      saveSubconEntry(subconId, day, { n, on })
    } else {
      saveSubconEntry(subconId, day, null)
    }
  }, [saveSubconEntry, subconEntries])

  const handleSubconOnChange = useCallback((subconId: string, day: number, value: string) => {
    const on = parseFloat(value) || 0
    setSubconEntries(prev => {
      const next = { ...prev }
      if (!next[subconId]) next[subconId] = {}
      const entries = { ...next[subconId] }
      const existing = entries[day]
      if (on > 0 || (existing && existing.n > 0)) {
        entries[day] = { n: existing?.n ?? 0, on }
      } else {
        delete entries[day]
      }
      next[subconId] = entries
      return next
    })

    const existing = subconEntries[subconId]?.[day]
    const n = existing?.n ?? 0
    if (on > 0 || n > 0) {
      saveSubconEntry(subconId, day, { n, on })
    } else {
      saveSubconEntry(subconId, day, null)
    }
  }, [saveSubconEntry, subconEntries])

  // ── Computed: grouped workers ──

  const groupedWorkers = useMemo(() => {
    if (!data) return []
    const hibi = data.workers.filter(w => w.org === 'hibi')
    const hfu = data.workers.filter(w => w.org === 'hfu')
    const groups: { org: string; label: string; workers: Worker[] }[] = []
    if (hibi.length > 0) groups.push({ org: 'hibi', label: '日比建設', workers: hibi })
    if (hfu.length > 0) groups.push({ org: 'hfu', label: 'HFU', workers: hfu })
    return groups
  }, [data])

  // ── Computed: day info ──

  const days = useMemo(() => {
    if (!data) return []
    return Array.from({ length: data.daysInMonth }, (_, i) => {
      const day = i + 1
      const dow = getDow(data.year, data.month, day)
      return { day, dow, label: DOW_JA[dow] }
    })
  }, [data])

  // ── Computed: worker totals ──

  const workerTotals = useCallback((workerId: string) => {
    const entries = workerEntries[workerId] || {}
    let wSum = 0
    let oSum = 0
    for (const e of Object.values(entries)) {
      if (e) {
        wSum += e.w || 0
        oSum += e.o || 0
      }
    }
    return { wSum, oSum }
  }, [workerEntries])

  // ── Computed: subcon totals ──

  const subconTotals = useCallback((subconId: string) => {
    const entries = subconEntries[subconId] || {}
    let nSum = 0
    let onSum = 0
    for (const e of Object.values(entries)) {
      if (e) {
        nSum += e.n || 0
        onSum += e.on || 0
      }
    }
    return { nSum, onSum }
  }, [subconEntries])

  // ── Work dropdown value ──

  function getWorkValue(entry: AttEntry | null | undefined): string {
    if (!entry) return ''
    if (entry.p && entry.p > 0) return 'P'
    if (entry.w === 1) return '1'
    if (entry.w === 0.5) return '0.5'
    return ''
  }

  // ── Render ──

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-hibi-navy flex items-center gap-2">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          出面入力
        </h1>

        {data?.locked && (
          <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-100 text-red-700 text-xs font-bold rounded-full">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            ロック中
          </span>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {/* Site selector */}
          <select
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-hibi-navy focus:outline-none min-w-[180px]"
          >
            {(data?.sites || []).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          {/* Year/Month selector */}
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
      </div>

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400">
          <svg className="animate-spin h-6 w-6 mx-auto mb-2 text-hibi-navy" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          読み込み中...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* ── Grid Table ── */}
      {!loading && data && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse" style={{ minWidth: `${180 + days.length * 52 + 120}px` }}>
              <thead>
                {/* Day number row */}
                <tr className="border-b border-gray-200">
                  <th
                    className="sticky left-0 z-20 bg-[#1B2A4A] text-white px-2 py-1.5 text-left font-medium whitespace-nowrap"
                    style={{ minWidth: 120 }}
                  >
                    名前
                  </th>
                  <th
                    className="sticky left-[120px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-medium"
                    style={{ minWidth: 48 }}
                  >
                    所属
                  </th>
                  {days.map(d => (
                    <th
                      key={d.day}
                      className={`px-0 py-1 text-center font-bold ${dayHeaderBg(data.year, data.month, d.day)} ${dayTextColor(d.dow)} border-l border-gray-200`}
                      style={{ minWidth: 48 }}
                    >
                      <div className="leading-tight">
                        <div className="text-[11px]">{d.day}</div>
                        <div className="text-[9px] opacity-70">{d.label}</div>
                      </div>
                    </th>
                  ))}
                  <th className="bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-medium border-l-2 border-gray-400" style={{ minWidth: 52 }}>
                    人工計
                  </th>
                  <th className="bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-medium border-l border-gray-600" style={{ minWidth: 52 }}>
                    残業計
                  </th>
                </tr>
              </thead>

              <tbody>
                {/* ── Worker groups ── */}
                {groupedWorkers.map(group => (
                  <>
                    {/* Group header */}
                    <tr key={`group-${group.org}`} className="bg-gray-50">
                      <td
                        colSpan={2 + days.length + 2}
                        className="sticky left-0 z-10 px-2 py-1 font-bold text-[11px] text-hibi-navy border-t-2 border-hibi-navy"
                      >
                        {group.label} ({group.workers.length}名)
                      </td>
                    </tr>

                    {group.workers.map(worker => {
                      const wId = String(worker.id)
                      const entries = workerEntries[wId] || {}
                      const totals = workerTotals(wId)
                      const isLocked = data.locked

                      return (
                        <tr key={worker.id} className="border-t border-gray-100 hover:bg-gray-50/50 group">
                          {/* Worker name - sticky */}
                          <td
                            className="sticky left-0 z-10 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium whitespace-nowrap text-gray-800 border-r border-gray-100"
                            style={{ minWidth: 120 }}
                          >
                            <div className="truncate max-w-[110px]" title={worker.name}>
                              {worker.name}
                            </div>
                          </td>

                          {/* Org badge - sticky */}
                          <td
                            className="sticky left-[120px] z-10 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center border-r border-gray-200"
                            style={{ minWidth: 48 }}
                          >
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              worker.org === 'hfu'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {worker.org === 'hfu' ? 'HFU' : '日比'}
                            </span>
                          </td>

                          {/* Day cells */}
                          {days.map(d => {
                            const entry = entries[d.day] || null
                            const workVal = getWorkValue(entry)
                            const otVal = entry?.o || 0
                            const canOt = entry && entry.w > 0

                            return (
                              <td
                                key={d.day}
                                className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day)}`}
                                style={{ minWidth: 48 }}
                              >
                                <div className="flex flex-col">
                                  {/* Work dropdown */}
                                  <select
                                    value={workVal}
                                    onChange={e => handleWorkChange(wId, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-[11px] py-0.5 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${workVal === '1' ? 'text-green-700 font-bold' : ''}
                                      ${workVal === '0.5' ? 'text-yellow-700 font-bold' : ''}
                                      ${workVal === 'P' ? 'text-purple-600 font-bold' : ''}
                                      ${workVal === '' ? 'text-gray-300' : ''}
                                    `}
                                  >
                                    <option value="">-</option>
                                    <option value="1">1</option>
                                    <option value="0.5">0.5</option>
                                    <option value="P">P</option>
                                  </select>

                                  {/* OT input */}
                                  <input
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    max="8"
                                    value={canOt && otVal > 0 ? otVal : ''}
                                    placeholder=""
                                    onChange={e => handleOtChange(wId, d.day, e.target.value)}
                                    disabled={isLocked || !canOt}
                                    className={`w-full text-center text-[10px] py-0.5 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
                                      ${!canOt || isLocked ? 'opacity-30 cursor-not-allowed' : 'text-amber-700'}
                                    `}
                                  />
                                </div>
                              </td>
                            )
                          })}

                          {/* Totals */}
                          <td className="px-1 py-0.5 text-center font-bold text-hibi-navy tabular-nums border-l-2 border-gray-300 bg-gray-50">
                            {totals.wSum > 0 ? totals.wSum : '-'}
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold text-amber-700 tabular-nums border-l border-gray-200 bg-gray-50">
                            {totals.oSum > 0 ? totals.oSum : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </>
                ))}

                {/* ── Subcontractors ── */}
                {data.subcons.length > 0 && (
                  <>
                    <tr className="bg-amber-50">
                      <td
                        colSpan={2 + days.length + 2}
                        className="sticky left-0 z-10 px-2 py-1 font-bold text-[11px] text-amber-800 border-t-2 border-amber-400"
                      >
                        外注 ({data.subcons.length}社)
                      </td>
                    </tr>

                    {data.subcons.map(sc => {
                      const entries = subconEntries[sc.id] || {}
                      const totals = subconTotals(sc.id)
                      const isLocked = data.locked

                      return (
                        <tr key={sc.id} className="border-t border-gray-100 hover:bg-gray-50/50 group">
                          {/* Subcon name - sticky */}
                          <td
                            className="sticky left-0 z-10 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium whitespace-nowrap text-gray-800 border-r border-gray-100"
                            style={{ minWidth: 120 }}
                          >
                            <div className="truncate max-w-[110px]" title={sc.name}>
                              {sc.name}
                            </div>
                          </td>

                          {/* Type badge - sticky */}
                          <td
                            className="sticky left-[120px] z-10 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center border-r border-gray-200"
                            style={{ minWidth: 48 }}
                          >
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                              {sc.type === 'tobi' ? 'とび' : sc.type === 'doko' ? '土工' : sc.type}
                            </span>
                          </td>

                          {/* Day cells */}
                          {days.map(d => {
                            const entry = entries[d.day] || null
                            const nVal = entry?.n ?? 0
                            const onVal = entry?.on ?? 0

                            return (
                              <td
                                key={d.day}
                                className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day)}`}
                                style={{ minWidth: 48 }}
                              >
                                <div className="flex flex-col">
                                  {/* People count */}
                                  <input
                                    type="number"
                                    step="1"
                                    min="0"
                                    value={nVal > 0 ? nVal : ''}
                                    placeholder="-"
                                    onChange={e => handleSubconNChange(sc.id, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-[11px] py-0.5 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none tabular-nums
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${nVal > 0 ? 'text-green-700 font-bold' : 'text-gray-300'}
                                    `}
                                  />

                                  {/* OT people count */}
                                  <input
                                    type="number"
                                    step="1"
                                    min="0"
                                    value={onVal > 0 ? onVal : ''}
                                    placeholder=""
                                    onChange={e => handleSubconOnChange(sc.id, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-[10px] py-0.5 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${onVal > 0 ? 'text-amber-700' : 'opacity-30'}
                                    `}
                                  />
                                </div>
                              </td>
                            )
                          })}

                          {/* Totals */}
                          <td className="px-1 py-0.5 text-center font-bold text-hibi-navy tabular-nums border-l-2 border-gray-300 bg-gray-50">
                            {totals.nSum > 0 ? totals.nSum : '-'}
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold text-amber-700 tabular-nums border-l border-gray-200 bg-gray-50">
                            {totals.onSum > 0 ? totals.onSum : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 flex items-center gap-4 text-[10px] text-gray-500 flex-wrap">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-amber-50 border border-amber-200" /> 今日
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-red-50 border border-red-200" /> 日曜
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded bg-blue-50 border border-blue-200" /> 土曜
            </span>
            <span className="mx-2 border-l border-gray-300 h-3" />
            <span><strong className="text-green-700">1</strong> = 出勤</span>
            <span><strong className="text-yellow-700">0.5</strong> = 半日</span>
            <span><strong className="text-purple-600">P</strong> = 有給</span>
            <span className="text-amber-700">下段 = 残業h</span>
            {saving && (
              <span className="ml-auto text-hibi-navy flex items-center gap-1">
                <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                保存中...
              </span>
            )}
          </div>
        </div>
      )}

      {/* No data placeholder */}
      {!loading && !error && !data && !siteId && (
        <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400">
          現場を選択してください
        </div>
      )}
    </div>
  )
}

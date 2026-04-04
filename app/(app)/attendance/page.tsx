'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'

// ────────────────────────────────────────
//  Types
// ────────────────────────────────────────

interface SiteOption {
  id: string
  name: string
  foreman?: number
  foremanName?: string
  foremanNote?: string
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

type DayType = 'work' | 'off' | 'holiday'

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
  approvals: Record<number, boolean>
  sites: SiteOption[]
  workDays: number | null
  siteWorkDays: number | null
  allWorkers: Worker[]
  foremanOverride: { name: string; note: string } | null
  calendarDays: Record<string, DayType> | null
}

// ── Visa badge helper ──

function visaBadge(visa: string): { label: string; cls: string } | null {
  if (visa.startsWith('jisshu')) {
    const num = visa.replace('jisshu', '')
    return { label: num ? `実習${num}号` : '実習', cls: 'bg-orange-100 text-orange-700' }
  }
  if (visa.startsWith('tokutei')) {
    const num = visa.replace('tokutei', '')
    return { label: num ? `特定${num}号` : '特定', cls: 'bg-pink-100 text-pink-700' }
  }
  return null // 日本人 = no special badge, uses org badge
}

function orgBadgeCls(org: string, visa: string): string {
  const v = visaBadge(visa)
  if (v) return v.cls
  return org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
}

function orgBadgeLabel(org: string, visa: string): string {
  const v = visaBadge(visa)
  if (v) return v.label
  return org === 'hfu' ? 'HFU' : '日比'
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
//  Debounce hook
// ────────────────────────────────────────

interface PendingSave {
  type: 'worker' | 'subcon'
  id: string
  day: number
  entry: AttEntry | null
  subconEntry?: SubconDayEntry | null
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

  // Save status: null | 'saving' | 'saved'
  const [saveStatus, setSaveStatus] = useState<null | 'saving' | 'saved'>(null)
  const saveStatusTimer = useRef<NodeJS.Timeout | null>(null)

  // Local state for entries (for instant UI updates)
  const [workerEntries, setWorkerEntries] = useState<Record<string, Record<number, AttEntry | null>>>({})
  const [subconEntries, setSubconEntries] = useState<Record<string, Record<number, SubconDayEntry | null>>>({})

  // workDays input
  const [workDaysInput, setWorkDaysInput] = useState<string>('')

  // Assignment modal
  const [showAssignModal, setShowAssignModal] = useState(false)

  // Debounce queue
  const pendingSaves = useRef<Map<string, PendingSave>>(new Map())
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)

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
      // Use siteWorkDays (from approved calendar) if workDays is not manually set
      const effectiveWorkDays = json.workDays ?? json.siteWorkDays
      setWorkDaysInput(effectiveWorkDays != null ? String(effectiveWorkDays) : '')
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

  // Initial site load: fetch site list from sites API
  useEffect(() => {
    if (!password || siteId) return
    const loadSites = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/sites', {
          headers: { 'x-admin-password': password },
        })
        if (res.ok) {
          const json = await res.json()
          const activeSites = (json.sites || []).filter((s: { archived?: boolean }) => !s.archived)
          if (activeSites.length > 0) {
            setSiteId(activeSites[0].id)
          }
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    loadSites()
  }, [password, siteId])

  // ── Debounced save flush ──

  const flushSaves = useCallback(async () => {
    if (!password || !data || pendingSaves.current.size === 0) return

    setSaveStatus('saving')

    const saves = Array.from(pendingSaves.current.values())
    pendingSaves.current.clear()

    try {
      // Send all pending saves
      const promises = saves.map(s => {
        const body: Record<string, unknown> = {
          siteId: data.site.id,
          ym: data.ym,
          day: s.day,
        }
        if (s.type === 'worker') {
          body.workerId = s.id
          body.entry = s.entry
        } else {
          body.subconId = s.id
          body.subconEntry = s.subconEntry
        }
        return fetch('/api/attendance/grid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': password,
          },
          body: JSON.stringify(body),
        })
      })
      await Promise.all(promises)

      setSaveStatus('saved')
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
    } catch (e) {
      console.error('Save error:', e)
      setSaveStatus(null)
    }
  }, [password, data])

  const scheduleSave = useCallback((key: string, save: PendingSave) => {
    pendingSaves.current.set(key, save)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      flushSaves()
    }, 1000)
  }, [flushSaves])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
    }
  }, [])

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
      } else if (value === '0.6') {
        entry = { w: 0.6 }
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
    else if (value === '0.6') entry = { w: 0.6 }
    else if (value === 'P') entry = { w: 0, p: 1 }

    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry,
    })
  }, [scheduleSave])

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
      const updated = { ...current, o: ot }
      scheduleSave(`w-${workerId}-${day}`, {
        type: 'worker', id: workerId, day, entry: updated,
      })
    }
  }, [scheduleSave, workerEntries])

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
    const subconEntry = (n > 0 || on > 0) ? { n, on } : null
    scheduleSave(`s-${subconId}-${day}`, {
      type: 'subcon', id: subconId, day, entry: null, subconEntry,
    })
  }, [scheduleSave, subconEntries])

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
    const subconEntry = (on > 0 || n > 0) ? { n, on } : null
    scheduleSave(`s-${subconId}-${day}`, {
      type: 'subcon', id: subconId, day, entry: null, subconEntry,
    })
  }, [scheduleSave, subconEntries])

  // ── Save workDays ──

  const workDaysTimer = useRef<NodeJS.Timeout | null>(null)
  const handleWorkDaysChange = useCallback((value: string) => {
    setWorkDaysInput(value)
    if (workDaysTimer.current) clearTimeout(workDaysTimer.current)
    workDaysTimer.current = setTimeout(async () => {
      if (!password || !data) return
      setSaveStatus('saving')
      try {
        await fetch('/api/attendance/grid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': password,
          },
          body: JSON.stringify({
            action: 'saveWorkDays',
            ym: data.ym,
            value: parseFloat(value) || 0,
          }),
        })
        setSaveStatus('saved')
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      } catch (e) {
        console.error('Save workDays error:', e)
        setSaveStatus(null)
      }
    }, 1000)
  }, [password, data])

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
    let compSum = 0
    let plSum = 0
    for (const e of Object.values(entries)) {
      if (e) {
        wSum += e.w || 0
        oSum += e.o || 0
        if (e.w === 0.6) compSum += 0.6
        if (e.p && e.p > 0) plSum += 1
      }
    }
    // 浮動小数点誤差を丸める（0.6 * 12 = 7.199... → 7.2）
    wSum = Math.round(wSum * 10) / 10
    oSum = Math.round(oSum * 10) / 10
    compSum = Math.round(compSum * 10) / 10
    return { wSum, oSum, compSum, plSum }
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
    // 浮動小数点誤差を丸める
    nSum = Math.round(nSum * 10) / 10
    onSum = Math.round(onSum * 10) / 10
    return { nSum, onSum }
  }, [subconEntries])

  // ── Computed: footer summary rows ──

  const footerSums = useMemo(() => {
    if (!data) return { tobi: {} as Record<number, number>, doko: {} as Record<number, number>, grand: {} as Record<number, number>, tobiOt: {} as Record<number, number>, dokoOt: {} as Record<number, number>, grandOt: {} as Record<number, number>, tobiTotal: 0, dokoTotal: 0, grandTotal: 0, tobiOtTotal: 0, dokoOtTotal: 0, grandOtTotal: 0 }

    const tobi: Record<number, number> = {}
    const doko: Record<number, number> = {}
    const grand: Record<number, number> = {}
    const tobiOt: Record<number, number> = {}
    const dokoOt: Record<number, number> = {}
    const grandOt: Record<number, number> = {}
    let tobiTotal = 0
    let dokoTotal = 0
    let grandTotal = 0
    let tobiOtTotal = 0
    let dokoOtTotal = 0
    let grandOtTotal = 0

    for (let d = 1; d <= data.daysInMonth; d++) {
      let tobiDay = 0
      let dokoDay = 0
      let grandDay = 0
      let tobiOtDay = 0
      let dokoOtDay = 0
      let grandOtDay = 0

      // Sum worker contributions by job type
      for (const w of data.workers) {
        const wId = String(w.id)
        const entry = workerEntries[wId]?.[d]
        if (entry && entry.w > 0 && !entry.p) {
          const workVal = entry.w
          const otVal = entry.o || 0
          if (w.job === 'tobi') {
            if (entry.w !== 0.6) {
              tobiDay += workVal
              tobiOtDay += otVal
            }
          } else if (w.job === 'doko') {
            if (entry.w !== 0.6) {
              dokoDay += workVal
              dokoOtDay += otVal
            }
          }
          grandDay += workVal
          grandOtDay += otVal
        }
      }

      // Add subcon counts to grand total
      for (const sc of data.subcons) {
        const entry = subconEntries[sc.id]?.[d]
        if (entry && entry.n > 0) {
          grandDay += entry.n
        }
        if (entry && entry.on > 0) {
          grandOtDay += entry.on
        }
      }

      tobi[d] = tobiDay
      doko[d] = dokoDay
      grand[d] = grandDay
      tobiOt[d] = tobiOtDay
      dokoOt[d] = dokoOtDay
      grandOt[d] = grandOtDay
      tobiTotal += tobiDay
      dokoTotal += dokoDay
      grandTotal += grandDay
      tobiOtTotal += tobiOtDay
      dokoOtTotal += dokoOtDay
      grandOtTotal += grandOtDay
    }

    // 浮動小数点誤差を丸める
    const r = (n: number) => Math.round(n * 10) / 10
    return {
      tobi, doko, grand, tobiOt, dokoOt, grandOt,
      tobiTotal: r(tobiTotal), dokoTotal: r(dokoTotal), grandTotal: r(grandTotal),
      tobiOtTotal: r(tobiOtTotal), dokoOtTotal: r(dokoOtTotal), grandOtTotal: r(grandOtTotal),
    }
  }, [data, workerEntries, subconEntries])

  // ── Computed: Sunday validation warnings ──

  const sundayWarnings = useMemo(() => {
    if (!data) return []
    const warnings: { workerName: string; day: number }[] = []
    for (const w of data.workers) {
      const wId = String(w.id)
      const entries = workerEntries[wId] || {}
      for (let d = 1; d <= data.daysInMonth; d++) {
        const dow = getDow(data.year, data.month, d)
        if (dow === 0) {
          const entry = entries[d]
          if (entry && entry.w > 0 && !entry.p) {
            warnings.push({ workerName: w.name, day: d })
          }
        }
      }
    }
    return warnings
  }, [data, workerEntries])

  // Holiday work warnings (calendar off/holiday days with attendance)
  const holidayWorkWarnings = useMemo(() => {
    if (!data || !data.calendarDays) return []
    const warnings: { workerName: string; day: number; dayType: string }[] = []
    for (const w of data.workers) {
      const wId = String(w.id)
      const entries = workerEntries[wId] || {}
      for (let d = 1; d <= data.daysInMonth; d++) {
        const calDay = data.calendarDays![String(d)]
        if (calDay && (calDay === 'off' || calDay === 'holiday')) {
          const entry = entries[d]
          if (entry && entry.w > 0 && !entry.p) {
            warnings.push({ workerName: w.name, day: d, dayType: calDay === 'holiday' ? '祝日' : '休日' })
          }
        }
      }
    }
    return warnings
  }, [data, workerEntries])

  // ── Work dropdown value ──

  function getWorkValue(entry: AttEntry | null | undefined): string {
    if (!entry) return ''
    if (entry.p && entry.p > 0) return 'P'
    if (entry.w === 1) return '1'
    if (entry.w === 0.5) return '0.5'
    if (entry.w === 0.6) return '0.6'
    return ''
  }

  // ── Assignment modal handlers ──

  const handleSaveAssign = useCallback(async (workerIds: number[]) => {
    if (!password || !data) return
    setSaveStatus('saving')
    try {
      await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          action: 'saveAssign',
          siteId: data.site.id,
          workerIds,
        }),
      })
      setSaveStatus('saved')
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      setShowAssignModal(false)
      // Refresh grid
      fetchData()
    } catch (e) {
      console.error('Save assign error:', e)
      setSaveStatus(null)
    }
  }, [password, data, fetchData])

  // ── Render ──

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white flex items-center gap-2">
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

        {/* Organization count badges */}
        {data && (
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
              日比建設 {data.workers.filter(w => w.org === 'hibi').length}名
            </span>
            <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
              HFU {data.workers.filter(w => w.org === 'hfu').length}名
            </span>
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
              外注 {data.subcons.length}社
            </span>
          </div>
        )}

        {/* 配置編集 button */}
        <button
          onClick={() => setShowAssignModal(true)}
          className="text-xs px-3 py-1.5 border border-hibi-navy text-hibi-navy rounded-lg hover:bg-hibi-navy hover:text-white transition"
        >
          配置編集
        </button>

        {/* 所定日数 input */}
        {data && (
          <div className="flex items-center gap-1.5 text-xs">
            <label className="text-gray-600 font-medium whitespace-nowrap">所定日数:</label>
            <input
              type="number"
              min="0"
              max="31"
              step="1"
              value={workDaysInput}
              onChange={e => handleWorkDaysChange(e.target.value)}
              className="w-14 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-1.5 py-1 text-center text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
              placeholder="-"
            />
            <span className="text-gray-400">日</span>
            {data.siteWorkDays != null && (
              <span className="text-green-600 dark:text-green-400 whitespace-nowrap" title="就業カレンダーから自動算出">
                (カレンダー: {data.siteWorkDays}日)
              </span>
            )}
          </div>
        )}

        {/* Save status indicator */}
        {saveStatus && (
          <span className={`text-xs flex items-center gap-1 ${saveStatus === 'saving' ? 'text-hibi-navy' : 'text-green-600'}`}>
            {saveStatus === 'saving' ? (
              <>
                <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                保存中...
              </>
            ) : (
              <>&#x2713; 保存済み</>
            )}
          </span>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {/* Site selector */}
          <select
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none min-w-[180px]"
          >
            {(data?.sites || []).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          {/* Year/Month selector */}
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none"
          >
            {ymOptions.map(o => (
              <option key={o.ym} value={o.ym}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-12 text-center text-gray-400">
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

      {/* ── Sunday validation warnings ── */}
      {sundayWarnings.length > 0 && (
        <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 rounded-xl px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-bold text-yellow-800 dark:text-yellow-300 mb-1">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            日曜出勤あり ({sundayWarnings.length}件)
          </div>
          <div className="text-yellow-700 dark:text-yellow-400 text-xs leading-relaxed">
            {sundayWarnings.map((w, i) => (
              <span key={i}>
                {i > 0 && '、 '}
                {w.workerName} ({w.day}日)
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Holiday work warnings ── */}
      {holidayWorkWarnings.length > 0 && (
        <div className="bg-orange-50 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700 rounded-xl px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-bold text-orange-800 dark:text-orange-300 mb-1">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            休日出勤あり ({holidayWorkWarnings.length}件)
          </div>
          <div className="text-orange-700 dark:text-orange-400 text-xs leading-relaxed">
            {holidayWorkWarnings.map((w, i) => (
              <span key={i}>
                {i > 0 && ', '}
                {w.workerName} ({w.day}日/{w.dayType})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Grid Table ── */}
      {!loading && data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse table-fixed" style={{ width: `${180 + days.length * 48 + 120}px` }}>
              <thead>
                {/* Day number row */}
                <tr className="border-b border-gray-200">
                  <th
                    className="sticky left-0 z-20 bg-[#1B2A4A] text-white px-2 py-1.5 text-left font-medium whitespace-nowrap"
                    style={{ minWidth: 220 }}
                  >
                    名前
                  </th>
                  <th
                    className="sticky left-[220px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-medium"
                    style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                  >
                    所属
                  </th>
                  {days.map(d => (
                    <th
                      key={d.day}
                      className={`px-0 py-1 text-center font-bold ${dayHeaderBg(data.year, data.month, d.day)} ${dayTextColor(d.dow)} border-l border-gray-200`}
                      style={{ width: 48, minWidth: 48, maxWidth: 48 }}
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
                {/* ── Foreman row (yellow) ── */}
                {data.site.foremanName && (
                  <tr className="bg-yellow-50 border-b border-yellow-200">
                    <td
                      className="sticky left-0 z-20 bg-yellow-50 px-2 py-1 font-bold text-yellow-800 whitespace-nowrap text-[11px] border-r border-yellow-200"
                      style={{ minWidth: 220 }}
                    >
                      職長: {data.site.foremanName}{data.site.foremanNote ? <span className="text-[9px] text-gray-500 ml-1">({data.site.foremanNote})</span> : ''}
                    </td>
                    <td className="sticky left-[220px] z-20 bg-yellow-50 px-1 py-1 text-center border-r border-yellow-200" style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-yellow-200 text-yellow-800">職長</span>
                    </td>
                    {days.map(d => (
                      <td key={d.day} className={`px-0 py-1 border-l border-yellow-100 bg-yellow-50 text-center text-[10px] text-yellow-600`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
                        {/* placeholder: foreman presence can be derived from worker entries */}
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center border-l-2 border-yellow-200 bg-yellow-50" colSpan={2}></td>
                  </tr>
                )}

                {/* ── Approval row (red/orange) ── */}
                <tr className="bg-orange-50 border-b border-orange-200">
                  <td
                    className="sticky left-0 z-20 bg-orange-50 px-2 py-1 font-bold text-orange-700 whitespace-nowrap text-[11px] border-r border-orange-200"
                    style={{ minWidth: 220 }}
                  >
                    承認
                  </td>
                  <td className="sticky left-[220px] z-20 bg-orange-50 px-1 py-1 text-center border-r border-orange-200" style={{ width: 48, minWidth: 48, maxWidth: 48 }}></td>
                  {days.map(d => {
                    const approved = data.approvals?.[d.day]
                    return (
                      <td key={d.day} className="px-0 py-1 border-l border-orange-100 bg-orange-50 text-center" style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
                        {approved ? (
                          <span className="text-green-600 text-[11px] font-bold" title="承認済">&#x2713;</span>
                        ) : (
                          <span className="text-orange-300 text-[11px]">-</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-1 py-1 text-center border-l-2 border-orange-200 bg-orange-50" colSpan={2}></td>
                </tr>

                {/* ── Worker groups ── */}
                {groupedWorkers.map(group => (
                  <>
                    {/* Group header */}
                    <tr key={`group-${group.org}`} className="bg-gray-50">
                      <td
                        colSpan={2 + days.length + 2}
                        className="sticky left-0 z-20 px-2 py-1 font-bold text-[11px] text-hibi-navy border-t-2 border-hibi-navy"
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
                            className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium whitespace-nowrap text-gray-800 border-r border-gray-100"
                            style={{ minWidth: 220 }}
                          >
                            {worker.name}
                          </td>

                          {/* Org badge - sticky (colored by visa) */}
                          <td
                            className="sticky left-[220px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center border-r border-gray-200"
                            style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                          >
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${orgBadgeCls(worker.org, worker.visa)}`}>
                              {orgBadgeLabel(worker.org, worker.visa)}
                            </span>
                          </td>

                          {/* Day cells */}
                          {days.map(d => {
                            const entry = entries[d.day] || null
                            const workVal = getWorkValue(entry)
                            const otVal = entry?.o || 0
                            const canOt = entry && entry.w > 0 && entry.w !== 0.6
                            // 休日出勤判定: カレンダーがoff/holidayなのに出勤あり
                            const calDay = data.calendarDays?.[String(d.day)]
                            const isHolidayWork = calDay && (calDay === 'off' || calDay === 'holiday') && entry && entry.w > 0 && !entry.p
                            // Input source indicator
                            const source = entry?.s

                            return (
                              <td
                                key={d.day}
                                className={`px-0 py-0 border-l border-gray-100 relative ${dayColBg(data.year, data.month, d.day)}`}
                                style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                              >
                                {isHolidayWork && (
                                  <span className="absolute top-0 right-0.5 text-[8px] text-orange-500 font-bold leading-none" title="休日出勤">休出</span>
                                )}
                                {source === 'staff' && !isHolidayWork && (
                                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400" title="スタッフ入力" />
                                )}
                                {source === 'foreman' && !isHolidayWork && (
                                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-orange-400" title="職長入力" />
                                )}
                                <div className="flex flex-col">
                                  {/* Work dropdown - 大きめ */}
                                  <select
                                    value={workVal}
                                    onChange={e => handleWorkChange(wId, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-sm font-bold py-1 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${workVal === '1' ? 'text-green-700' : ''}
                                      ${workVal === '0.5' ? 'text-yellow-700' : ''}
                                      ${workVal === '0.6' ? 'text-purple-600' : ''}
                                      ${workVal === 'P' ? 'text-purple-600' : ''}
                                      ${workVal === '' ? 'text-gray-300 font-normal' : ''}
                                    `}
                                  >
                                    <option value="">-</option>
                                    <option value="1">1</option>
                                    <option value="0.5">0.5</option>
                                    <option value="0.6">.6</option>
                                    <option value="P">P</option>
                                  </select>

                                  {/* OT input - 小さめ */}
                                  <input
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    max="8"
                                    value={canOt && otVal > 0 ? otVal : ''}
                                    placeholder=""
                                    onChange={e => handleOtChange(wId, d.day, e.target.value)}
                                    disabled={isLocked || !canOt}
                                    className={`w-full text-center text-[10px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
                                      ${!canOt || isLocked ? 'opacity-20 cursor-not-allowed' : 'text-amber-600'}
                                    `}
                                  />
                                </div>
                              </td>
                            )
                          })}

                          {/* Totals */}
                          <td className="px-1 py-0.5 text-center font-bold text-hibi-navy tabular-nums border-l-2 border-gray-300 bg-gray-50">
                            <div>{totals.wSum > 0 ? totals.wSum : '-'}</div>
                            {(totals.compSum > 0 || totals.plSum > 0) && (
                              <div className="text-[9px] font-normal text-gray-500 leading-tight">
                                {[
                                  totals.compSum > 0 ? `補${totals.compSum % 1 === 0 ? totals.compSum : totals.compSum.toFixed(1)}` : '',
                                  totals.plSum > 0 ? `有${totals.plSum}` : '',
                                ].filter(Boolean).join(' ')}
                              </div>
                            )}
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
                        className="sticky left-0 z-20 px-2 py-1 font-bold text-[11px] text-amber-800 border-t-2 border-amber-400"
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
                            className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium whitespace-nowrap text-gray-800 border-r border-gray-100"
                            style={{ minWidth: 220 }}
                          >
{sc.name}
                          </td>

                          {/* Type badge - sticky */}
                          <td
                            className="sticky left-[220px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center border-r border-gray-200"
                            style={{ width: 48, minWidth: 48, maxWidth: 48 }}
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
                                style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                              >
                                <div className="flex flex-col">
                                  {/* People count - 大きめ */}
                                  <input
                                    type="number"
                                    step="1"
                                    min="0"
                                    value={nVal > 0 ? nVal : ''}
                                    placeholder="-"
                                    onChange={e => handleSubconNChange(sc.id, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-sm font-bold py-1 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none tabular-nums
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${nVal > 0 ? 'text-green-700' : 'text-gray-300 font-normal'}
                                    `}
                                  />

                                  {/* OT people count - 小さめ */}
                                  <input
                                    type="number"
                                    step="1"
                                    min="0"
                                    value={onVal > 0 ? onVal : ''}
                                    placeholder=""
                                    onChange={e => handleSubconOnChange(sc.id, d.day, e.target.value)}
                                    disabled={isLocked}
                                    className={`w-full text-center text-[10px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
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

                {/* ── Footer summary rows ── */}
                {/* Tobi Total */}
                <tr className="border-t-2 border-[#1B2A4A]">
                  <td
                    className="sticky left-0 z-20 bg-[#1B2A4A] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px] border-r border-gray-600"
                    style={{ minWidth: 220 }}
                  >
                    鳶 合計
                  </td>
                  <td className="sticky left-[220px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center border-r border-gray-600" style={{ width: 48, minWidth: 48, maxWidth: 48 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#1B2A4A] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                    >
                      {footerSums.tobi[d.day] > 0 ? footerSums.tobi[d.day] : '-'}
                    </td>
                  ))}
                  <td className="bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.tobiTotal > 0 ? footerSums.tobiTotal : '-'}
                  </td>
                  <td className="bg-[#1B2A4A] text-amber-300 px-1 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.tobiOtTotal > 0 ? footerSums.tobiOtTotal : '-'}
                  </td>
                </tr>

                {/* Doko Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#243656] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px] border-r border-gray-600"
                    style={{ minWidth: 220 }}
                  >
                    土工 合計
                  </td>
                  <td className="sticky left-[220px] z-20 bg-[#243656] text-white px-1 py-1.5 text-center border-r border-gray-600" style={{ width: 48, minWidth: 48, maxWidth: 48 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#243656] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                    >
                      {footerSums.doko[d.day] > 0 ? footerSums.doko[d.day] : '-'}
                    </td>
                  ))}
                  <td className="bg-[#243656] text-white px-1 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.dokoTotal > 0 ? footerSums.dokoTotal : '-'}
                  </td>
                  <td className="bg-[#243656] text-amber-300 px-1 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.dokoOtTotal > 0 ? footerSums.dokoOtTotal : '-'}
                  </td>
                </tr>

                {/* Grand Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#0F1D36] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px] border-r border-gray-600"
                    style={{ minWidth: 220 }}
                  >
                    総合計
                  </td>
                  <td className="sticky left-[220px] z-20 bg-[#0F1D36] text-white px-1 py-1.5 text-center border-r border-gray-600" style={{ width: 48, minWidth: 48, maxWidth: 48 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#0F1D36] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 48, minWidth: 48, maxWidth: 48 }}
                    >
                      {footerSums.grand[d.day] > 0 ? footerSums.grand[d.day] : '-'}
                    </td>
                  ))}
                  <td className="bg-[#0F1D36] text-amber-300 px-1 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.grandTotal > 0 ? footerSums.grandTotal : '-'}
                  </td>
                  <td className="bg-[#0F1D36] text-amber-300 px-1 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-[11px]" style={{ minWidth: 52 }}>
                    {footerSums.grandOtTotal > 0 ? footerSums.grandOtTotal : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 flex items-center gap-4 text-[10px] text-gray-500 dark:text-gray-400 flex-wrap">
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
            <span><strong className="text-purple-600">補</strong> = 0.6補償</span>
            <span><strong className="text-purple-600">P</strong> = 有給</span>
            <span className="text-amber-700">下段 = 残業h</span>
          </div>
        </div>
      )}

      {/* No data placeholder */}
      {!loading && !error && !data && !siteId && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-12 text-center text-gray-400">
          現場を選択してください
        </div>
      )}

      {/* ── Assignment Modal ── */}
      {showAssignModal && data && (
        <AssignModal
          siteName={data.site.name}
          currentWorkerIds={data.workers.map(w => w.id)}
          allWorkers={data.allWorkers || []}
          onSave={handleSaveAssign}
          onClose={() => setShowAssignModal(false)}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────
//  Assignment Modal Component
// ────────────────────────────────────────

function AssignModal({
  siteName,
  currentWorkerIds,
  allWorkers,
  onSave,
  onClose,
}: {
  siteName: string
  currentWorkerIds: number[]
  allWorkers: Worker[]
  onSave: (workerIds: number[]) => void
  onClose: () => void
}) {
  const [assignedIds, setAssignedIds] = useState<Set<number>>(new Set(currentWorkerIds))
  const [search, setSearch] = useState('')

  const unassigned = useMemo(() => {
    return allWorkers
      .filter(w => !assignedIds.has(w.id))
      .filter(w => !search || w.name.includes(search))
  }, [allWorkers, assignedIds, search])

  const assigned = useMemo(() => {
    return allWorkers.filter(w => assignedIds.has(w.id))
  }, [allWorkers, assignedIds])

  const addWorker = (id: number) => {
    setAssignedIds(prev => new Set([...prev, id]))
  }

  const removeWorker = (id: number) => {
    setAssignedIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleSave = () => {
    onSave(Array.from(assignedIds))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-hibi-navy">{siteName} 配置編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        {/* Modal body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Unassigned workers */}
          <div className="flex-1 border-r border-gray-200 flex flex-col">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
              <div className="text-xs font-bold text-gray-600 mb-1">未配置の作業員</div>
              <input
                type="text"
                placeholder="名前で検索..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {unassigned.length === 0 && (
                <div className="text-center text-gray-400 text-xs py-4">該当なし</div>
              )}
              {unassigned.map(w => (
                <button
                  key={w.id}
                  onClick={() => addWorker(w.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-blue-50 rounded transition"
                >
                  <span className="text-green-600 text-lg leading-none">+</span>
                  <span className="font-medium text-gray-800">{w.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${orgBadgeCls(w.org, w.visa)}`}>
                    {orgBadgeLabel(w.org, w.visa)}
                  </span>
                  {w.job && (
                    <span className="text-[10px] text-gray-400">
                      {w.job === 'tobi' ? '鳶' : w.job === 'doko' ? '土工' : w.job}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Assigned workers */}
          <div className="flex-1 flex flex-col">
            <div className="px-4 py-2 bg-blue-50 border-b border-gray-200">
              <div className="text-xs font-bold text-hibi-navy">配置済み ({assigned.length}名)</div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {assigned.length === 0 && (
                <div className="text-center text-gray-400 text-xs py-4">作業員が配置されていません</div>
              )}
              {assigned.map(w => (
                <div
                  key={w.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white rounded border border-gray-100"
                >
                  <span className="font-medium text-gray-800 flex-1">{w.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${orgBadgeCls(w.org, w.visa)}`}>
                    {orgBadgeLabel(w.org, w.visa)}
                  </span>
                  <button
                    onClick={() => removeWorker(w.id)}
                    className="text-red-400 hover:text-red-600 text-lg leading-none ml-1"
                    title="配置解除"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 rounded-lg border border-gray-300 hover:bg-gray-100 transition"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm text-white bg-hibi-navy rounded-lg hover:bg-[#243656] transition font-medium"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

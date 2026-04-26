'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { isTimeBasedMonth, calcActualHours } from '@/types'

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
  hk?: number   // 1=帰国中
  s?: string
  // 時間ベース入力（202605〜）
  st?: string   // 始業 "HH:MM"
  et?: string   // 終業 "HH:MM"
  b1?: number   // 午前休憩 1/0
  b2?: number   // 昼休み 1/0
  b3?: number   // 午後休憩 1/0
}

interface SubconDayEntry {
  n: number
  on: number
}

type DayType = 'work' | 'off' | 'holiday'

interface HomeLeaveInfo {
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
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
  approvals: Record<number, boolean>
  sites: SiteOption[]
  workDays: number | null
  siteWorkDays: number | null
  allWorkers: Worker[]
  foremanOverride: { name: string; note: string } | null
  calendarDays: Record<string, DayType> | null
  homeLeaves?: HomeLeaveInfo[]
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

function dayColBg(year: number, month: number, day: number, calDayType?: DayType | null): string {
  if (isToday(year, month, day)) return 'bg-amber-50'
  const dow = getDow(year, month, day)
  // 日曜・土曜は曜日色を常に優先
  if (dow === 0) return 'bg-red-50'
  if (dow === 6) return 'bg-blue-50'
  // 平日でカレンダー休日 → グレー
  if (calDayType === 'off' || calDayType === 'holiday') return 'bg-gray-100/60'
  return ''
}

function dayHeaderBg(year: number, month: number, day: number, calDayType?: DayType | null): string {
  if (isToday(year, month, day)) return 'bg-amber-100'
  const dow = getDow(year, month, day)
  // 日曜・土曜は曜日色を常に優先
  if (dow === 0) return 'bg-red-100'
  if (dow === 6) return 'bg-blue-100'
  // 平日でカレンダー休日 → グレー濃
  if (calDayType === 'off' || calDayType === 'holiday') return 'bg-gray-200'
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
  const [userRole, setUserRole] = useState('')
  const [userId, setUserId] = useState(0)
  const [ym, setYm] = useState(currentYm)
  const [siteId, _setSiteId] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('att_lastSiteId') || ''
    }
    return ''
  })
  const setSiteId = useCallback((id: string) => {
    _setSiteId(id)
    if (id) localStorage.setItem('att_lastSiteId', id)
  }, [])
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [allSites, setAllSites] = useState<{ id: string; name: string; archived?: boolean }[]>([])
  const [localApprovals, setLocalApprovals] = useState<Record<number, boolean>>({})

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

  const ymOptions = useMemo(() => getYmOptions(26), []) // 2024年4月まで遡れるように拡張

  // 時間ベース入力モード（202605〜）
  const useTimeBased = isTimeBasedMonth(ym)

  // 時間選択肢を生成
  const startTimeOptions = useMemo(() => {
    const opts: string[] = []
    for (let h = 6; h <= 12; h++) {
      opts.push(`${String(h).padStart(2, '0')}:00`)
      if (h < 12) opts.push(`${String(h).padStart(2, '0')}:30`)
    }
    return opts
  }, [])

  const endTimeOptions = useMemo(() => {
    const opts: string[] = []
    for (let h = 15; h <= 23; h++) {
      opts.push(`${String(h).padStart(2, '0')}:00`)
      if (h < 23) opts.push(`${String(h).padStart(2, '0')}:30`)
    }
    return opts
  }, [])

  // Read auth
  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw, user } = JSON.parse(stored)
        setPassword(pw)
        if (user) {
          setUserRole(user.role || '')
          setUserId(user.workerId || 0)
        }
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
      setLocalApprovals(json.approvals || {})
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
  }, [data, siteId, setSiteId])

  // Initial site load: fetch site list from sites API
  const sitesLoaded = useRef(false)
  useEffect(() => {
    if (!password || sitesLoaded.current) return
    sitesLoaded.current = true
    const loadSites = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/sites', {
          headers: { 'x-admin-password': password },
        })
        if (res.ok) {
          const json = await res.json()
          const sites = json.sites || []
          setAllSites(sites)
          // siteId が空、または保存値がサイトリストに存在しない場合のみデフォルト設定
          if (!siteId || !sites.some((s: { id: string }) => s.id === siteId)) {
            const activeSites = sites.filter((s: { archived?: boolean }) => !s.archived)
            if (activeSites.length > 0) {
              setSiteId(activeSites[0].id)
            }
          }
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    loadSites()
  }, [password, siteId, setSiteId])

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
      } else if (value === 'E') {
        // 試験（実習生年次試験など。現場出勤にはカウントしないが給与計算では出勤と同等扱い）
        entry = { w: 0, exam: 1 } as AttEntry
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
    else if (value === 'E') entry = { w: 0, exam: 1 } as AttEntry

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

  // ── Time-based cell handlers (202605〜) ──

  /** 時間ベース: 特殊ステータス変更（P/R/H/出勤/クリア） */
  const handleTimeStatusChange = useCallback((workerId: string, day: number, value: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }

      let entry: AttEntry | null = null
      if (value === 'P') {
        entry = { w: 0, p: 1, s: 'admin' }
      } else if (value === 'E') {
        // 試験: 実習生の年次試験など。現場出勤にはカウントしないが給与計算では出勤と同等扱い
        entry = { w: 0, exam: 1, s: 'admin' } as AttEntry
      } else if (value === 'R') {
        entry = { w: 0, r: 1, s: 'admin' }
      } else if (value === 'H') {
        entry = { w: 0, h: 1, s: 'admin' }
      } else if (value === 'W') {
        // 出勤: デフォルト時間で初期化
        entry = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
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
    if (value === 'P') entry = { w: 0, p: 1, s: 'admin' }
    else if (value === 'E') entry = { w: 0, exam: 1, s: 'admin' } as AttEntry
    else if (value === 'R') entry = { w: 0, r: 1, s: 'admin' }
    else if (value === 'H') entry = { w: 0, h: 1, s: 'admin' }
    else if (value === 'W') entry = { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }

    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry,
    })
  }, [scheduleSave])

  /** 時間ベース: 始業時間変更 */
  const handleStartTimeChange = useCallback((workerId: string, day: number, st: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, st, s: 'admin' }
      // 残業時間を再計算
      const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    // For save: get current entry and apply
    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, st, s: 'admin' }
    const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
    const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
    if (otH > 0) updated.o = otH; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
  }, [scheduleSave, workerEntries])

  /** 時間ベース: 終業時間変更 */
  const handleEndTimeChange = useCallback((workerId: string, day: number, et: string) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, et, s: 'admin' }
      const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, et, s: 'admin' }
    const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
    const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
    if (otH > 0) updated.o = otH; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
  }, [scheduleSave, workerEntries])

  /** 時間ベース: 休憩チェック変更 */
  const handleBreakChange = useCallback((workerId: string, day: number, breakKey: 'b1' | 'b2' | 'b3', checked: boolean) => {
    setWorkerEntries(prev => {
      const next = { ...prev }
      if (!next[workerId]) next[workerId] = {}
      const entries = { ...next[workerId] }
      const existing = entries[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
      const updated = { ...existing, [breakKey]: checked ? 1 : 0, s: 'admin' }
      const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, [breakKey]: checked ? 1 : 0, s: 'admin' }
    const actual = calcActualHours(updated as Parameters<typeof calcActualHours>[0])
    const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
    if (otH > 0) updated.o = otH; else delete updated.o
    scheduleSave(`w-${workerId}-${day}`, {
      type: 'worker', id: workerId, day, entry: updated,
    })
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
    // 外国人のみ時間ベース計算（202605〜かつvisaあり）
    const worker = data?.workers.find(w => String(w.id) === workerId)
    const isWorkerTimeBased = useTimeBased && !!worker?.visa && worker.visa !== 'none' && worker.visa !== ''
    let wSum = 0
    let oSum = 0
    let compSum = 0
    let plSum = 0
    let actualHoursSum = 0
    for (const e of Object.values(entries)) {
      if (e) {
        wSum += e.w || 0
        if (e.p && e.p > 0) plSum += 1
        if (isWorkerTimeBased && e.st && e.et) {
          const ah = calcActualHours(e as Parameters<typeof calcActualHours>[0])
          actualHoursSum += ah
          const ot = Math.max(0, ah - 7)
          oSum += ot
        } else {
          oSum += e.o || 0
          if (e.w === 0.6) compSum += 0.6
        }
      }
    }
    // 浮動小数点誤差を丸める（0.6 * 12 = 7.199... → 7.2）
    wSum = Math.round(wSum * 10) / 10
    oSum = Math.round(oSum * 10) / 10
    compSum = Math.round(compSum * 10) / 10
    actualHoursSum = Math.round(actualHoursSum * 10) / 10
    return { wSum, oSum, compSum, plSum, actualHoursSum }
  }, [workerEntries, useTimeBased, data])

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
      // 補償(0.6)は外国人の場合は人工数に含めない（compute()と同じルール）
      for (const w of data.workers) {
        const wId = String(w.id)
        const entry = workerEntries[wId]?.[d]
        if (entry && entry.w > 0 && !entry.p) {
          const isComp = entry.w === 0.6 && w.visa !== 'none'
          const workVal = isComp ? 0 : entry.w
          const otVal = isComp ? 0 : (entry.o || 0)
          if (w.job === 'tobi' || w.job === 'shokucho' || w.job === 'yakuin') {
            tobiDay += workVal
            tobiOtDay += otVal
          } else if (w.job === 'doko') {
            dokoDay += workVal
            dokoOtDay += otVal
          }
          grandDay += workVal
          grandOtDay += otVal
        }
      }

      // Add subcon counts to tobi/doko/grand totals
      for (const sc of data.subcons) {
        const entry = subconEntries[sc.id]?.[d]
        if (entry && entry.n > 0) {
          const isTobi = sc.type === 'tobi' || sc.type === '鳶業者' || sc.type === '鳶'
          const isDoko = sc.type === 'doko' || sc.type === '土工業者' || sc.type === '土工'
          if (isTobi) {
            tobiDay += entry.n
            tobiOtDay += entry.on || 0
          } else if (isDoko) {
            dokoDay += entry.n
            dokoOtDay += entry.on || 0
          }
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
    if (entry.hk && entry.hk > 0) return 'HK'
    if (entry.p && entry.p > 0) return 'P'
    if ((entry as { exam?: number }).exam && (entry as { exam?: number }).exam! > 0) return 'E'
    if (entry.w === 1) return '1'
    if (entry.w === 0.5) return '0.5'
    if (entry.w === 0.6) return '0.6'
    return ''
  }

  // ── Time-based status helper ──

  function getTimeStatusValue(entry: AttEntry | null | undefined): string {
    if (!entry) return ''
    if (entry.hk && entry.hk > 0) return 'HK'
    if (entry.p && entry.p > 0) return 'P'
    if ((entry as { exam?: number }).exam && (entry as { exam?: number }).exam! > 0) return 'E'
    if (entry.r && entry.r > 0) return 'R'
    if (entry.h && entry.h > 0) return 'H'
    if (entry.w > 0) return 'W'
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
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg sm:text-xl font-bold text-hibi-navy dark:text-white flex items-center gap-2">
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

        {/* 所定日数 input（5月以降はカレンダーで確定するため非表示） */}
        {data && !useTimeBased && (
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

        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:ml-auto">
          {/* Site selector */}
          <select
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none flex-1 min-w-0 sm:min-w-[180px]"
          >
            {(data?.sites || allSites).filter(s => showArchived || !(s as { archived?: boolean }).archived).map(s => (
              <option key={s.id} value={s.id}>{s.name}{(s as { archived?: boolean }).archived ? '（終了）' : ''}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="rounded" />
            終了現場
          </label>

          {/* Year/Month selector */}
          <select
            value={ym}
            onChange={e => setYm(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none shrink-0"
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

      {/* ── Home leave banner ── */}
      {data?.homeLeaves && data.homeLeaves.length > 0 && (
        <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-bold text-cyan-800 mb-1">
            ✈️ 帰国予定・帰国中 ({data.homeLeaves.length}件)
          </div>
          <div className="space-y-1">
            {data.homeLeaves.map((hl, i) => {
              const now = new Date().toISOString().slice(0, 10)
              const isCurrent = hl.startDate <= now && hl.endDate >= now
              const isFuture = hl.startDate > now
              return (
                <div key={i} className="flex items-center gap-2 text-xs text-cyan-700">
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    isCurrent ? 'bg-cyan-200 text-cyan-800' : isFuture ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {isCurrent ? '帰国中' : isFuture ? '予定' : '済'}
                  </span>
                  <span className="font-medium">{hl.workerName}</span>
                  <span>{hl.startDate.slice(5)} 〜 {hl.endDate.slice(5)}</span>
                  <span className="text-cyan-500">({hl.reason})</span>
                  {hl.status === 'foreman_approved' && (
                    <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">職長済・最終承認待ち</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Grid Table ── */}
      {!loading && data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden -mx-4 sm:mx-0 rounded-none sm:rounded-xl">
          <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
            <table className="text-xs border-collapse table-fixed" style={{ width: `${180 + days.length * 48 + 120}px` }}>
              <thead className="sticky top-0 z-30">
                {/* Day number row */}
                <tr className="border-b border-gray-200">
                  <th
                    className="sticky left-0 z-40 bg-[#1B2A4A] text-white px-2 py-1.5 text-left font-medium whitespace-nowrap"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    名前
                  </th>
                  <th
                    className="sticky left-[150px] z-40 bg-[#1B2A4A] text-white px-1 py-1.5 text-center font-medium"
                    style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                  >
                    所属
                  </th>
                  {days.map(d => {
                    const calDayType = data.calendarDays?.[String(d.day)]
                    const isCalOff = calDayType === 'off' || calDayType === 'holiday'
                    const isSunday = d.dow === 0
                    // 平日の休みだけ文字色をグレーに（日曜・土曜は曜日色維持）
                    const isWeekdayOff = isCalOff && d.dow !== 0 && d.dow !== 6
                    // 「休」マーク: 日曜以外でカレンダー休日の場合（土曜含む）
                    const showOffMark = isCalOff && !isSunday && data.calendarDays
                    return (
                    <th
                      key={d.day}
                      className={`px-0 py-1 text-center font-bold ${dayHeaderBg(data.year, data.month, d.day, calDayType)} ${isWeekdayOff ? 'text-gray-400' : dayTextColor(d.dow)} border-l border-gray-200`}
                      style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                      title={isCalOff ? 'カレンダー休日' : data.calendarDays ? 'カレンダー出勤日' : ''}
                    >
                      <div className="leading-tight">
                        <div className="text-[11px]">{d.day}</div>
                        <div className="text-[9px] opacity-70">{d.label}{showOffMark ? ' 休' : ''}</div>
                      </div>
                    </th>
                    )
                  })}
                  <th className="bg-[#1B2A4A] text-white px-2 py-1.5 text-center font-medium border-l-2 border-gray-400" style={{ width: 64, minWidth: 64 }}>
                    人工計
                  </th>
                  <th className="bg-[#1B2A4A] text-white px-2 py-1.5 text-center font-medium border-l border-gray-600" style={{ width: 56, minWidth: 56 }}>
                    残業h
                  </th>
                </tr>
              </thead>

              <tbody>
                {/* ── Foreman row (yellow) ── */}
                {data.site.foremanName && (
                  <tr className="bg-yellow-50 border-b border-yellow-200">
                    <td
                      className="sticky left-0 z-20 bg-yellow-50 px-2 py-1 font-bold text-yellow-800 whitespace-nowrap text-[11px]"
                      style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                    >
                      職長: {data.site.foremanName}{data.site.foremanNote ? <span className="text-[9px] text-gray-500 ml-1">({data.site.foremanNote})</span> : ''}
                    </td>
                    <td className="sticky left-[150px] z-20 bg-yellow-50 px-1 py-1 text-center" style={{ width: 56, minWidth: 56, maxWidth: 56 }}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-yellow-200 text-yellow-800">職長</span>
                    </td>
                    {days.map(d => (
                      <td key={d.day} className={`px-0 py-1 border-l border-yellow-100 bg-yellow-50 text-center text-[10px] text-yellow-600`} style={{ width: 56, minWidth: 56, maxWidth: 56 }}>
                        {/* placeholder: foreman presence can be derived from worker entries */}
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center border-l-2 border-yellow-200 bg-yellow-50" colSpan={2}></td>
                  </tr>
                )}

                {/* ── Approval row — admin/approver can click to approve (optimistic UI) ── */}
                <tr className="bg-orange-50 border-b border-orange-200">
                  <td
                    className="sticky left-0 z-20 bg-orange-50 px-2 py-1 font-bold text-orange-700 whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    承認
                    {(userRole === 'admin' || userRole === 'approver') && (() => {
                      const unapprovedDays = days.filter(d => !localApprovals[d.day])
                      return unapprovedDays.length > 0 ? (
                        <button
                          onClick={async () => {
                            // 楽観的UI: 全日を即座に承認表示
                            const updated = { ...localApprovals }
                            for (const d of unapprovedDays) updated[d.day] = true
                            setLocalApprovals(updated)
                            // バックグラウンドで全日を承認
                            for (const d of unapprovedDays) {
                              fetch('/api/attendance/grid', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                body: JSON.stringify({ action: 'approve', siteId, ym, day: d.day, approvedBy: userId }),
                              }).catch(() => {})
                            }
                          }}
                          className="ml-2 text-[9px] bg-green-600 text-white px-1.5 py-0.5 rounded hover:bg-green-700 transition"
                        >
                          一括承認
                        </button>
                      ) : (
                        <span className="ml-2 text-[9px] text-green-600">全承認済</span>
                      )
                    })()}
                  </td>
                  <td className="sticky left-[150px] z-20 bg-orange-50 px-1 py-1 text-center" style={{ width: 56, minWidth: 56, maxWidth: 56 }}></td>
                  {days.map(d => {
                    const approved = localApprovals[d.day]
                    const canApprove = userRole === 'admin' || userRole === 'approver'
                    return (
                      <td
                        key={d.day}
                        className={`px-0 py-1 border-l border-orange-100 bg-orange-50 text-center ${canApprove ? 'cursor-pointer hover:bg-orange-100' : ''}`}
                        style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                        onClick={canApprove ? () => {
                          // 楽観的UI: 即座にトグル
                          setLocalApprovals(prev => ({ ...prev, [d.day]: !prev[d.day] }))
                          // バックグラウンドでAPI
                          fetch('/api/attendance/grid', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                            body: JSON.stringify({
                              action: approved ? 'unapprove' : 'approve',
                              siteId, ym, day: d.day, approvedBy: userId,
                            }),
                          }).catch(() => {})
                        } : undefined}
                        title={canApprove ? (approved ? 'クリックで承認解除' : 'クリックで承認') : ''}
                      >
                        {approved ? (
                          <span className="text-green-600 text-[11px] font-bold">&#x2713;</span>
                        ) : (
                          <span className={`text-[11px] ${canApprove ? 'text-orange-400' : 'text-orange-300'}`}>-</span>
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
                        className="sticky left-0 z-20 bg-gray-50 px-2 py-1 font-bold text-[11px] text-hibi-navy border-t-2 border-hibi-navy"
                        style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                      >
                        {group.label} ({group.workers.length}名)
                      </td>
                      <td className="sticky left-[150px] z-20 bg-gray-50 border-t-2 border-hibi-navy" style={{ width: 56, minWidth: 56, maxWidth: 56 }} />
                      {days.map(d => <td key={d.day} className="border-t-2 border-hibi-navy bg-gray-50" />)}
                      <td className="border-t-2 border-hibi-navy bg-gray-50" />
                      <td className="border-t-2 border-hibi-navy bg-gray-50" />
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
                            className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium text-gray-800 text-xs"
                            style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                          >
                            {worker.name}
                          </td>

                          {/* Org badge - sticky (colored by visa) */}
                          <td
                            className="sticky left-[150px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center"
                            style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                          >
                            <span className={`text-[10px] px-1 py-0.5 rounded-full font-medium whitespace-nowrap ${orgBadgeCls(worker.org, worker.visa)}`}>
                              {orgBadgeLabel(worker.org, worker.visa)}
                            </span>
                          </td>

                          {/* Day cells */}
                          {days.map(d => {
                            let entry = entries[d.day] || null
                            // 帰国判定: homeLeaves の期間に含まれるか（出面に hk がない場合も対応）
                            if (!entry?.hk && data.homeLeaves?.length) {
                              const dateStr = `${data.year}-${String(data.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
                              const isOnLeave = data.homeLeaves.some(hl =>
                                String(hl.workerId) === wId && hl.status === 'approved' && dateStr >= hl.startDate && dateStr <= hl.endDate
                              )
                              if (isOnLeave) {
                                entry = { ...(entry || { w: 0 }), hk: 1 }
                              }
                            }
                            // 休日出勤判定: カレンダーがoff/holidayなのに出勤あり
                            const calDay = data.calendarDays?.[String(d.day)]
                            const isHolidayWork = calDay && (calDay === 'off' || calDay === 'holiday') && entry && entry.w > 0 && !entry.p && !entry.hk
                            // Input source indicator
                            const source = entry?.s
                            // 外国人のみ時間ベース（202605〜かつvisaあり）
                            const isWorkerTimeBased = useTimeBased && !!worker.visa && worker.visa !== 'none' && worker.visa !== ''

                            // ── 時間ベースモード（外国人 + 202605〜）──
                            if (isWorkerTimeBased) {
                              const statusVal = getTimeStatusValue(entry)

                              // 帰国中: 特別表示
                              if (statusVal === 'HK') {
                                return (
                                  <td key={d.day}
                                    className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                    style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                                  >
                                    <div className="flex items-center justify-center h-full py-2">
                                      <span className="text-[10px] font-bold text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded">✈帰国</span>
                                    </div>
                                  </td>
                                )
                              }

                              const isWorking = statusVal === 'W'
                              const st = entry?.st || '08:00'
                              const et = entry?.et || '17:00'
                              const b1 = entry?.b1 ?? 1
                              const b2 = entry?.b2 ?? 1
                              const b3 = entry?.b3 ?? 1
                              // 実時間計算
                              const actualH = isWorking && entry?.st && entry?.et
                                ? calcActualHours(entry as Parameters<typeof calcActualHours>[0])
                                : 0

                              return (
                                <td
                                  key={d.day}
                                  className={`px-0 py-0 border-l border-gray-100 relative ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                  style={{ width: 56, minWidth: 56, maxWidth: 56 }}
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
                                  <div className="flex flex-col items-center">
                                    {/* ステータス選択 */}
                                    <select
                                      value={statusVal}
                                      onChange={e => handleTimeStatusChange(wId, d.day, e.target.value)}
                                      disabled={isLocked}
                                      className={`w-full text-center text-[10px] font-bold py-0.5 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
                                        ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                        ${statusVal === 'W' ? 'text-green-700' : ''}
                                        ${statusVal === 'P' ? 'text-purple-600' : ''}
                                        ${statusVal === 'E' ? 'text-indigo-600' : ''}
                                        ${statusVal === 'R' ? 'text-red-500' : ''}
                                        ${statusVal === 'H' ? 'text-gray-500' : ''}
                                        ${statusVal === '' ? 'text-gray-300 font-normal' : ''}
                                      `}
                                    >
                                      <option value="">-</option>
                                      <option value="W">出</option>
                                      <option value="P">有</option>
                                      <option value="E">試</option>
                                      <option value="R">休</option>
                                      <option value="H">現</option>
                                    </select>

                                    {isWorking ? (
                                      <>
                                        {/* 始業・終業 */}
                                        <div className="flex items-center gap-0 w-full">
                                          <select
                                            value={st}
                                            onChange={e => handleStartTimeChange(wId, d.day, e.target.value)}
                                            disabled={isLocked}
                                            className="w-1/2 text-center text-[8px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700"
                                          >
                                            {startTimeOptions.map(t => <option key={t} value={t}>{t.replace(':00', '').replace(':30', ':3')}</option>)}
                                          </select>
                                          <select
                                            value={et}
                                            onChange={e => handleEndTimeChange(wId, d.day, e.target.value)}
                                            disabled={isLocked}
                                            className="w-1/2 text-center text-[8px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700"
                                          >
                                            {endTimeOptions.map(t => <option key={t} value={t}>{t.replace(':00', '').replace(':30', ':3')}</option>)}
                                          </select>
                                        </div>
                                        {/* 休憩チェック + 実時間 */}
                                        <div className="flex items-center justify-center gap-0.5 w-full px-0.5">
                                          <label className="flex items-center cursor-pointer" title="午前(10:00-10:30)">
                                            <input type="checkbox" checked={b1 === 1} onChange={e => handleBreakChange(wId, d.day, 'b1', e.target.checked)} disabled={isLocked} className="w-2.5 h-2.5 rounded" />
                                          </label>
                                          <label className="flex items-center cursor-pointer" title="午後(15:00-15:30)">
                                            <input type="checkbox" checked={b3 === 1} onChange={e => handleBreakChange(wId, d.day, 'b3', e.target.checked)} disabled={isLocked} className="w-2.5 h-2.5 rounded" />
                                          </label>
                                          <span className={`text-[8px] tabular-nums ml-auto font-bold ${actualH > 7 ? 'text-amber-600' : 'text-gray-500'}`}>
                                            {actualH.toFixed(1)}
                                          </span>
                                        </div>
                                      </>
                                    ) : statusVal !== '' ? (
                                      <div className="text-[9px] text-center py-0.5 font-medium text-gray-400">
                                        {statusVal === 'P' ? '有給' : statusVal === 'E' ? '試験' : statusVal === 'R' ? '休' : '現休'}
                                      </div>
                                    ) : null}
                                  </div>
                                </td>
                              )
                            }

                            // ── レガシーモード（日本人 or 〜202604） ──
                            const workVal = getWorkValue(entry)

                            // 帰国中: 特別表示
                            if (workVal === 'HK') {
                              return (
                                <td key={d.day}
                                  className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                  style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                                >
                                  <div className="flex items-center justify-center h-full py-2">
                                    <span className="text-[10px] font-bold text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded">✈帰国</span>
                                  </div>
                                </td>
                              )
                            }

                            const otVal = entry?.o || 0
                            const canOt = entry && entry.w > 0 && entry.w !== 0.6

                            return (
                              <td
                                key={d.day}
                                className={`px-0 py-0 border-l border-gray-100 relative ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                style={{ width: 56, minWidth: 56, maxWidth: 56 }}
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
                                      ${workVal === 'P' ? 'text-purple-600' : ''}
                                      ${workVal === 'E' ? 'text-indigo-600' : ''}
                                      ${workVal === '' ? 'text-gray-300 font-normal' : ''}
                                    `}
                                  >
                                    <option value="">-</option>
                                    <option value="1">1</option>
                                    <option value="0.5">0.5</option>
                                    <option value="P">有</option>
                                    <option value="E">試</option>
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

                          {/* Totals - 人工計 */}
                          <td className="px-2 py-1 text-center font-bold text-hibi-navy tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 64, minWidth: 64 }}>
                            <div className="text-sm">{totals.wSum > 0 ? totals.wSum : '-'}</div>
                            {(totals.compSum > 0 || totals.plSum > 0) && (
                              <div className="text-[9px] font-normal text-gray-400 leading-tight">
                                {[
                                  totals.compSum > 0 ? `補${Math.round(totals.compSum * 10) / 10}` : '',
                                  totals.plSum > 0 ? `有${totals.plSum}` : '',
                                ].filter(Boolean).join(' ')}
                              </div>
                            )}
                          </td>
                          {/* Totals - 残業計 */}
                          <td className="px-2 py-1 text-center font-bold text-amber-600 tabular-nums border-l border-gray-200 bg-gray-50" style={{ width: 56, minWidth: 56 }}>
                            <div className="text-sm">{totals.oSum > 0 ? totals.oSum : '-'}</div>
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
                        className="sticky left-0 z-20 bg-amber-50 px-2 py-1 font-bold text-[11px] text-amber-800 border-t-2 border-amber-400"
                        style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                      >
                        外注 ({data.subcons.length}社)
                      </td>
                      <td className="sticky left-[150px] z-20 bg-amber-50 border-t-2 border-amber-400" style={{ width: 56, minWidth: 56, maxWidth: 56 }} />
                      {days.map(d => <td key={d.day} className="border-t-2 border-amber-400 bg-amber-50" />)}
                      <td className="border-t-2 border-amber-400 bg-amber-50" />
                      <td className="border-t-2 border-amber-400 bg-amber-50" />
                    </tr>

                    {data.subcons.map(sc => {
                      const entries = subconEntries[sc.id] || {}
                      const totals = subconTotals(sc.id)
                      const isLocked = data.locked

                      return (
                        <tr key={sc.id} className="border-t border-gray-100 hover:bg-gray-50/50 group">
                          {/* Subcon name - sticky */}
                          <td
                            className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium text-gray-800 text-xs"
                            style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                          >
{sc.name}
                          </td>

                          {/* Type badge - sticky */}
                          <td
                            className="sticky left-[150px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center"
                            style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                          >
                            <span className="text-[10px] px-1 py-0.5 rounded-full font-medium whitespace-nowrap bg-amber-100 text-amber-700">
                              {sc.type === 'tobi' || sc.type === '鳶業者' ? '鳶' : sc.type === 'doko' || sc.type === '土工業者' ? '土工' : sc.type}
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
                                className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                style={{ width: 56, minWidth: 56, maxWidth: 56 }}
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

                          {/* Totals - 人工計 */}
                          <td className="px-2 py-1 text-center font-bold text-hibi-navy tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 64, minWidth: 64 }}>
                            <div className="text-sm">{totals.nSum > 0 ? totals.nSum : '-'}</div>
                          </td>
                          {/* Totals - 残業計 */}
                          <td className="px-2 py-1 text-center font-bold text-amber-600 tabular-nums border-l border-gray-200 bg-gray-50" style={{ width: 56, minWidth: 56 }}>
                            <div className="text-sm">{totals.onSum > 0 ? totals.onSum : '-'}</div>
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
                    className="sticky left-0 z-20 bg-[#1B2A4A] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    鳶 合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center" style={{ width: 56, minWidth: 56, maxWidth: 56 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#1B2A4A] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                    >
                      {footerSums.tobi[d.day] > 0 ? Math.round(footerSums.tobi[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  <td className="bg-[#1B2A4A] text-white px-2 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 64, minWidth: 64 }}>
                    {footerSums.tobiTotal > 0 ? footerSums.tobiTotal : '-'}
                  </td>
                  <td className="bg-[#1B2A4A] text-amber-300 px-2 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-sm" style={{ width: 56, minWidth: 56 }}>
                    {footerSums.tobiOtTotal > 0 ? footerSums.tobiOtTotal : '-'}
                  </td>
                </tr>

                {/* Doko Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#243656] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    土工 合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#243656] text-white px-1 py-1.5 text-center" style={{ width: 56, minWidth: 56, maxWidth: 56 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#243656] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                    >
                      {footerSums.doko[d.day] > 0 ? Math.round(footerSums.doko[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  <td className="bg-[#243656] text-white px-2 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 64, minWidth: 64 }}>
                    {footerSums.dokoTotal > 0 ? footerSums.dokoTotal : '-'}
                  </td>
                  <td className="bg-[#243656] text-amber-300 px-2 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-sm" style={{ width: 56, minWidth: 56 }}>
                    {footerSums.dokoOtTotal > 0 ? footerSums.dokoOtTotal : '-'}
                  </td>
                </tr>

                {/* Grand Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#0F1D36] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    総合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#0F1D36] text-white px-1 py-1.5 text-center" style={{ width: 56, minWidth: 56, maxWidth: 56 }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#0F1D36] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: 56, minWidth: 56, maxWidth: 56 }}
                    >
                      {footerSums.grand[d.day] > 0 ? Math.round(footerSums.grand[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  <td className="bg-[#0F1D36] text-white px-2 py-1.5 text-center font-bold tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 64, minWidth: 64 }}>
                    {footerSums.grandTotal > 0 ? footerSums.grandTotal : '-'}
                  </td>
                  <td className="bg-[#0F1D36] text-amber-300 px-2 py-1.5 text-center font-bold tabular-nums border-l border-gray-600 text-sm" style={{ width: 56, minWidth: 56 }}>
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
            <span><strong className="text-purple-600">有</strong> = 有給</span>
            <span className="text-amber-700">下段 = 残業h</span>
            {useTimeBased && data && data.workers.some(w => w.visa && w.visa !== 'none' && w.visa !== '') && (
              <>
                <span className="mx-2 border-l border-gray-300 h-3" />
                <span className="text-orange-600 font-medium">外国人:</span>
                <span><strong className="text-green-700">出</strong> = 時間入力</span>
                <span>休憩: ☐午前30分 / ☐午後30分（昼60分は固定）</span>
                <span className="text-amber-600">7h超=残業</span>
              </>
            )}
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

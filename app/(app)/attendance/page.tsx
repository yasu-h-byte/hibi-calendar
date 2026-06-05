'use client'

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { isTimeBasedMonth, calcActualHours } from '@/types'
import { isWorkingDay } from '@/lib/attendance'
import { isTobiGroup, jobShortLabel } from '@/lib/jobs'
import { visaBadge, orgBadgeCls, orgBadgeLabel } from '@/lib/labels'
import AttendanceActionBar from '@/components/AttendanceActionBar'
import HomeLeaveBanner from '@/components/attendance/HomeLeaveBanner'
import UpcomingRetirementsBanner from '@/components/attendance/UpcomingRetirementsBanner'
import NextMonthCalendarBanner from '@/components/attendance/NextMonthCalendarBanner'
import AttendanceWarningBanner from '@/components/attendance/AttendanceWarningBanner'
import AssignModal from '@/components/attendance/AssignModal'

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
  retired?: string  // YYYY-MM-DD 退職日（バッジ表示用）
}

// 退職予定リスト用（3ヶ月以内）
interface UpcomingRetirement {
  id: number
  name: string
  org: string
  visa: string
  retired: string  // YYYY-MM-DD
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
  approvals: Record<number, boolean>  // 後方互換: foreman 承認の有無 bool マップ
  foremanApprovals?: Record<number, { by: number; at: string }>
  finalApprovals?: Record<number, { by: number; at: string }>
  sites: SiteOption[]
  workDays: number | null
  siteWorkDays: number | null
  allWorkers: Worker[]
  allSubcons?: { id: string; name: string; type: string }[]
  foremanOverride: { name: string; note: string } | null
  calendarDays: Record<string, DayType> | null
  homeLeaves?: HomeLeaveInfo[]
  upcomingRetirements?: UpcomingRetirement[]
}

// visaBadge / orgBadgeCls / orgBadgeLabel は lib/labels.ts に集約済み

// 退職日バッジの色とラベルを返す
//   - 既に退職済（過去日）→ 赤・濃い「✅退職済」
//   - 30日以内 → 赤「🏁 5/15退職」
//   - 31〜90日 → オレンジ「🏁 6/30退職」
//   - それ以降 → null（バッジ表示なし）
function retirementBadge(retired: string | undefined): { label: string; cls: string; title: string } | null {
  if (!retired) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const retiredDate = new Date(retired + 'T00:00:00')
  const diffDays = Math.floor((retiredDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  const m = retiredDate.getMonth() + 1
  const d = retiredDate.getDate()
  if (diffDays < 0) {
    return { label: `✅${m}/${d}退職済`, cls: 'bg-gray-200 text-gray-700', title: `${retired} 退職済` }
  }
  if (diffDays <= 30) {
    return { label: `🏁${m}/${d}退職`, cls: 'bg-red-100 text-red-700 ring-1 ring-red-300', title: `${retired} 退職予定（あと${diffDays}日）` }
  }
  if (diffDays <= 90) {
    return { label: `🏁${m}/${d}退職`, cls: 'bg-orange-100 text-orange-700', title: `${retired} 退職予定（あと${diffDays}日）` }
  }
  return null
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
  const [userForemanSites, setUserForemanSites] = useState<string[]>([])
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
  const [localApprovals, setLocalApprovals] = useState<Record<number, boolean>>({})  // 後方互換: 職長承認 bool
  const [localFinalApprovals, setLocalFinalApprovals] = useState<Record<number, boolean>>({})

  // Save status: null | 'saving' | 'saved'
  const [saveStatus, setSaveStatus] = useState<null | 'saving' | 'saved' | 'error'>(null)
  const saveStatusTimer = useRef<NodeJS.Timeout | null>(null)

  // Local state for entries (for instant UI updates)
  const [workerEntries, setWorkerEntries] = useState<Record<string, Record<number, AttEntry | null>>>({})
  const [subconEntries, setSubconEntries] = useState<Record<string, Record<number, SubconDayEntry | null>>>({})

  // workDays input
  const [workDaysInput, setWorkDaysInput] = useState<string>('')

  // Assignment modal
  const [showAssignModal, setShowAssignModal] = useState(false)

  // 翌月カレンダー未確定アラート用（月末1週間前を過ぎたら全現場の status を取得）
  const [nextMonthCalCheck, setNextMonthCalCheck] = useState<{
    ym: string
    daysToMonthEnd: number
    sites: { siteId: string; siteName: string; status: string | null }[]
  } | null>(null)

  // Debounce queue
  const pendingSaves = useRef<Map<string, PendingSave>>(new Map())
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)

  const ymOptions = useMemo(() => getYmOptions(26), []) // 2024年4月まで遡れるように拡張

  // 時間ベース入力モード（202605〜）
  const useTimeBased = isTimeBasedMonth(ym)

  // 1日あたりのセル幅（px）
  // 時間ベース入力月は始業・終業・休憩など情報が多いため広めに
  const cellWidth = useTimeBased ? 76 : 56

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
          setUserForemanSites(user.foremanSites || [])
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
      // 最終承認は finalApprovals マップから bool マップを生成
      const finalBoolMap: Record<number, boolean> = {}
      const finalRaw = json.finalApprovals || {}
      for (const k of Object.keys(finalRaw)) {
        finalBoolMap[Number(k)] = true
      }
      setLocalFinalApprovals(finalBoolMap)
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

  // ── 翌月カレンダー未確定アラート ──
  // 月末1週間前を過ぎたら、翌月の siteCalendar status を全現場分取得して
  // 未確定（draft/未作成/rejected/submitted）の現場があればバナー表示。
  // ym 切替には依存させず、今日の日付ベースで一度だけチェック。
  useEffect(() => {
    if (!password) return
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const daysToMonthEnd = lastDayOfMonth - today.getDate()
    if (daysToMonthEnd > 7) {
      setNextMonthCalCheck(null)
      return
    }
    // 翌月の ym "YYYY-MM"
    const nm = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    const nextYm = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}`
    fetch(`/api/calendar/status?ym=${nextYm}`, {
      headers: { 'x-admin-password': password },
    })
      .then(r => r.ok ? r.json() : null)
      .then((json: { sites?: { siteId: string; siteName: string; status: string | null }[] } | null) => {
        if (!json || !json.sites) return
        setNextMonthCalCheck({
          ym: nextYm,
          daysToMonthEnd,
          sites: json.sites.map(s => ({
            siteId: s.siteId,
            siteName: s.siteName,
            status: s.status,
          })),
        })
      })
      .catch(() => {})
  }, [password])

  // ── Debounced save flush ──

  const flushSaves = useCallback(async () => {
    if (!password || !data || pendingSaves.current.size === 0) return

    setSaveStatus('saving')

    const saves = Array.from(pendingSaves.current.values())
    pendingSaves.current.clear()

    try {
      // Send all pending saves and inspect each response
      const promises = saves.map(async s => {
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
        const res = await fetch('/api/attendance/grid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': password,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          // エラーレスポンスから詳細を取得（保存失敗を握りつぶさない）
          let errMsg = `${res.status} ${res.statusText}`
          try {
            const errData = await res.json()
            if (errData?.error) errMsg = errData.error
          } catch { /* JSON でないレスポンスの場合 */ }
          return { ok: false, save: s, error: errMsg, status: res.status }
        }
        return { ok: true as const, save: s }
      })
      const results = await Promise.all(promises)
      const failures = results.filter(r => !r.ok) as { ok: false; save: PendingSave; error: string; status: number }[]

      if (failures.length === 0) {
        setSaveStatus('saved')
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
      } else {
        // ⚠️ 2026-05-11 修正: 旧コードはレスポンスを確認せず常に「保存しました」を表示
        //   していたため、API が 403/409/503 でエラーを返しても画面に出ず、データ消失と
        //   誤認される事案が発生。res.ok を厳密にチェックして失敗を alert で明示する。
        setSaveStatus('error')
        const sample = failures.slice(0, 5)
        const detail = sample.map(f => {
          const s = f.save
          const label = s.type === 'worker' ? `スタッフID:${s.id}` : `応援:${s.id}`
          return `  ${label} ${data.ym}/${s.day}: ${f.error}`
        }).join('\n')
        const more = failures.length > sample.length ? `\n  …他 ${failures.length - sample.length} 件` : ''
        alert(
          `❌ ${failures.length} 件の保存に失敗しました\n\n${detail}${more}\n\n` +
          `※ベトナム人スタッフの「出勤」を後付け入力することはできません\n` +
          `（スタッフ本人のスマホ入力が必要です）。\n` +
          `有給・帰国中は admin/職長が後付け入力可能です。`
        )
        if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
        saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 5000)
      }
    } catch (e) {
      console.error('Save error:', e)
      setSaveStatus('error')
      alert(`❌ 通信エラーで保存できませんでした\n\n${e instanceof Error ? e.message : String(e)}\n\nネットワーク状態を確認してもう一度お試しください。`)
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current)
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 5000)
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

  // Excel風キーボードナビゲーション: Enter で同じ日付列の次の人のステータスにジャンプ
  const focusNextWorkerStatus = useCallback((day: number, currentWorkerId: string, shiftKey: boolean) => {
    // 同じ日付列のステータスセル一覧を取得（disabled は自動的にスキップ）
    const cells = Array.from(
      document.querySelectorAll(`[data-att-status][data-att-day="${day}"]:not([disabled])`)
    ) as HTMLSelectElement[]
    const currentIdx = cells.findIndex(c => c.dataset.attRow === currentWorkerId)
    if (currentIdx < 0) {
      // フォールバック: 最初のセルへ
      cells[0]?.focus()
      return
    }
    const target = shiftKey ? cells[currentIdx - 1] : cells[currentIdx + 1]
    if (target) {
      target.focus()
      // セル全体が画面内に入るようにスクロール調整
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [])

  // 任意のキーボードイベントから呼び出すヘルパー
  const handleAttCellKeyDown = useCallback((e: React.KeyboardEvent, day: number, workerId: string) => {
    // 2026-06-XX 追加 (UI #5): 追加ショートカット
    //   Enter / Shift+Enter: 縦方向の移動 (既存)
    //   Esc: フォーカス解除（誤入力時の取り消し）
    //   Ctrl/Cmd+S: debounce 待たず即保存（後続処理は scheduleSave 側でハンドル）
    //   ※ select 要素では文字キーでオプションがジャンプ (W/P/R/E/H) — ブラウザ標準動作
    if (e.key === 'Enter') {
      e.preventDefault()
      focusNextWorkerStatus(day, workerId, e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      // ブラウザのページ保存ダイアログを抑制（debounce 内で自動保存されるので何もしなくて良い）
      e.preventDefault()
    }
  }, [focusNextWorkerStatus])

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
    // 並び順: 日本人（visa=none）を先に → 同区分内は ID 昇順
    //   ID 採番が帯域別（日本人=1-99 / 外国人=100-200番台 / 事務=300番台）になったため、
    //   素直に visa→id 昇順で並べると 入力しやすい順番（職人→ベトナム→事務）になる。
    const sortFn = (a: Worker, b: Worker) => {
      const aIsJp = !a.visa || a.visa === 'none'
      const bIsJp = !b.visa || b.visa === 'none'
      if (aIsJp !== bIsJp) return aIsJp ? -1 : 1
      return a.id - b.id
    }
    // filter() で既に新しい配列が返るため slice() は不要
    const hibi = data.workers.filter(w => w.org === 'hibi').sort(sortFn)
    const hfu = data.workers.filter(w => w.org === 'hfu').sort(sortFn)
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
      if (!e) continue
      // 有給日数は別カウント（残骸関係なく p flag で判定）
      if (e.p && e.p > 0) plSum += 1

      // ⚠️ 2026-05-09 修正: 「働いた日」のみ wSum / compSum / oSum / actualHours を加算する。
      //   isWorkingDay() で 5 ステータス (p/r/h/hk/exam) を一括チェック。
      //   旧コードは wSum を先に加算していたため、{w:1, p:1, ...} のような残骸データが
      //   人工計に水増し計上されていた（昨日のビンさん事案で発覚）。
      if (!isWorkingDay(e)) continue

      // 出勤日のみ集計対象
      wSum += e.w || 0
      if (e.w === 0.6) compSum += 0.6

      // 補償日 (w=0.6) の残業は、ベトナム人スタッフはカウントしない（フッターと整合）
      const isComp = e.w === 0.6 && !!worker?.visa && worker.visa !== 'none' && worker.visa !== ''
      if (isComp) continue

      if (isWorkerTimeBased && e.st && e.et) {
        const ah = calcActualHours(e as Parameters<typeof calcActualHours>[0])
        actualHoursSum += ah
        const ot = Math.max(0, ah - 7)
        oSum += ot
      } else {
        oSum += e.o || 0
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
      // ⚠️ 2026-05-09: isWorkingDay() で残骸データ対策（有給/休み/現場休/帰国中/試験 を除外）
      for (const w of data.workers) {
        const wId = String(w.id)
        const entry = workerEntries[wId]?.[d]
        if (entry && isWorkingDay(entry)) {
          const isComp = entry.w === 0.6 && w.visa !== 'none'
          const workVal = isComp ? 0 : entry.w
          const otVal = isComp ? 0 : (entry.o || 0)
          if (isTobiGroup(w.job)) {
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
    // ★ 優先順: P/E/R/H > HK
    //   帰国期間中の有給事後計上で p:1 + hk:1 の状態が一時的に発生しうるため、
    //   明示的なステータス（有給など）を帰国マーカーより優先表示する。
    if (entry.p && entry.p > 0) return 'P'
    if ((entry as { exam?: number }).exam && (entry as { exam?: number }).exam! > 0) return 'E'
    if (entry.hk && entry.hk > 0) return 'HK'
    if (entry.w === 1) return '1'
    if (entry.w === 0.5) return '0.5'
    if (entry.w === 0.6) return '0.6'
    return ''
  }

  // ── Time-based status helper ──

  function getTimeStatusValue(entry: AttEntry | null | undefined): string {
    if (!entry) return ''
    // ★ 優先順: P/E/R/H > HK（帰国期間中の有給事後計上対応）
    if (entry.p && entry.p > 0) return 'P'
    if ((entry as { exam?: number }).exam && (entry as { exam?: number }).exam! > 0) return 'E'
    if (entry.r && entry.r > 0) return 'R'
    if (entry.h && entry.h > 0) return 'H'
    if (entry.hk && entry.hk > 0) return 'HK'
    if (entry.w > 0) return 'W'
    return ''
  }

  // ── Assignment modal handlers ──

  const handleSaveAssign = useCallback(async (
    workerIds: number[],
    subconIds: string[],
    expectedSiteId: string,
    expectedYm: string,
  ) => {
    if (!password || !data) return
    // 🛡 多層防御: モーダル open 時点の siteId/ym と現在のものが食い違うと
    //   別現場/別月の配置データで上書きしてしまう。明示的に拒否してアラート。
    //   (2026-05-27 sasazuka → IHIメンバー上書き事案の再発防止)
    if (data.site.id !== expectedSiteId || ym !== expectedYm) {
      alert(
        `⚠️ 配置編集中にサイト/月が切り替わったため保存を中止しました。\n\n` +
        `編集開始時: ${expectedSiteId} / ${expectedYm}\n` +
        `現在: ${data.site.id} / ${ym}\n\n` +
        `モーダルを閉じてから再度開いて、編集をやり直してください。`
      )
      setShowAssignModal(false)
      return
    }
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
          ym,  // 2026-05-19: ym を必ず送って massign[siteId_ym] も更新させる
          workerIds,
          subconIds,
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
  }, [password, data, ym, fetchData])

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
          {/* 2026-06-XX 追加 (UI #5): キーボードショートカット案内 */}
          <span
            className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-normal bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full cursor-help"
            title={[
              '⌨️ キーボードショートカット',
              '',
              '【セル内】',
              ' W → 出勤 / P → 有給 / R → 休み',
              ' E → 試験 / H → 現場休',
              ' (select の標準動作: 文字キーで該当オプションへジャンプ)',
              '',
              '【ナビゲーション】',
              ' Enter → 同じ日の次のスタッフへ移動',
              ' Shift+Enter → 同じ日の前のスタッフへ移動',
              ' Tab → 同じ行の次のセル',
              ' Shift+Tab → 同じ行の前のセル',
              '',
              '【その他】',
              ' Esc → フォーカス解除（誤入力時）',
              ' Cmd+S (Mac) / Ctrl+S (Win) → 自動保存中なので何も起きません',
              '   （ブラウザのページ保存ダイアログを抑制）',
            ].join('\n')}
          >
            ⌨️ ショートカット
          </span>
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
          <span className={`text-xs flex items-center gap-1 font-bold px-2 py-1 rounded ${
            saveStatus === 'saving' ? 'text-hibi-navy' :
            saveStatus === 'saved' ? 'text-green-600' :
            'text-red-700 bg-red-100 dark:bg-red-900/40 dark:text-red-300'
          }`}>
            {saveStatus === 'saving' ? (
              <>
                <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                保存中...
              </>
            ) : saveStatus === 'saved' ? (
              <>&#x2713; 保存済み</>
            ) : (
              <>⚠️ 保存失敗 — 内容を確認してください</>
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

      {/* 翌月カレンダー未確定アラート（components/attendance/NextMonthCalendarBanner.tsx に集約） */}
      <NextMonthCalendarBanner check={nextMonthCalCheck} />

      {/* ── 勤怠申請のアクションバー（2026-05-18 追加） ── */}
      {/* 出面入力画面で有給承認・帰国承認まで完結できるようにする。スマホ操作前提。 */}
      {password && userRole && (
        <AttendanceActionBar
          password={password}
          userRole={userRole}
          userWorkerId={userId}
          userForemanSites={userForemanSites}
          onUpdate={fetchData}
        />
      )}

      {/* 日曜出勤・休日出勤の警告（components/attendance/AttendanceWarningBanner.tsx に集約） */}
      <AttendanceWarningBanner title="日曜出勤あり" items={sundayWarnings} tone="warning" />
      <AttendanceWarningBanner
        title="休日出勤あり"
        items={holidayWorkWarnings.map(w => ({ workerName: w.workerName, day: w.day, suffix: w.dayType }))}
        tone="orange"
      />

      {/* 帰国情報バナー（components/attendance/HomeLeaveBanner.tsx に集約） */}
      <HomeLeaveBanner homeLeaves={data?.homeLeaves} />

      {/* 退職予定バナー（components/attendance/UpcomingRetirementsBanner.tsx に集約） */}
      <UpcomingRetirementsBanner retirements={data?.upcomingRetirements} />

      {/* ── Grid Table ── */}
      {!loading && data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden -mx-4 sm:mx-0 rounded-none sm:rounded-xl">
          <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
            <table className="text-xs border-collapse table-fixed" style={{ width: `${180 + days.length * 48 + 80}px` }}>
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
                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                      title={isCalOff ? 'カレンダー休日' : data.calendarDays ? 'カレンダー出勤日' : ''}
                    >
                      <div className="leading-tight">
                        <div className="text-[11px]">{d.day}</div>
                        <div className="text-[9px] opacity-70">{d.label}{showOffMark ? ' 休' : ''}</div>
                      </div>
                    </th>
                    )
                  })}
                  <th className="bg-[#1B2A4A] text-white px-2 py-1.5 text-center font-medium border-l-2 border-gray-400" style={{ width: 80, minWidth: 80 }}>
                    <div>計</div>
                    <div className="text-[8px] opacity-70 font-normal">上:人工 / 下:残業h</div>
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
                    <td className="sticky left-[150px] z-20 bg-yellow-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-yellow-200 text-yellow-800">職長</span>
                    </td>
                    {days.map(d => (
                      <td key={d.day} className={`px-0 py-1 border-l border-yellow-100 bg-yellow-50 text-center text-[10px] text-yellow-600`} style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}>
                        {/* placeholder: foreman presence can be derived from worker entries */}
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center border-l-2 border-yellow-200 bg-yellow-50" style={{ width: 80, minWidth: 80 }}></td>
                  </tr>
                )}

                {/* ── 職長承認 row（1次承認: 担当現場の職長のみ） ── */}
                <tr className="bg-orange-50 border-b border-orange-100">
                  <td
                    className="sticky left-0 z-20 bg-orange-50 px-2 py-1 font-bold text-orange-700 whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    {data.site.foremanName ? `${data.site.foremanName} 職長承認` : '職長承認'}
                    {(userRole === 'foreman' && userForemanSites.includes(siteId)) && (() => {
                      const unapprovedDays = days.filter(d => !localApprovals[d.day])
                      return unapprovedDays.length > 0 ? (
                        <button
                          onClick={async () => {
                            const updated = { ...localApprovals }
                            for (const d of unapprovedDays) updated[d.day] = true
                            setLocalApprovals(updated)
                            for (const d of unapprovedDays) {
                              fetch('/api/attendance/grid', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                body: JSON.stringify({ action: 'approve_foreman', siteId, ym, day: d.day, approvedBy: userId }),
                              }).catch(() => {})
                            }
                          }}
                          className="ml-2 text-[9px] bg-orange-500 text-white px-1.5 py-0.5 rounded hover:bg-orange-600 transition"
                        >
                          一括承認
                        </button>
                      ) : (
                        <span className="ml-2 text-[9px] text-orange-600">全承認済</span>
                      )
                    })()}
                  </td>
                  <td className="sticky left-[150px] z-20 bg-orange-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => {
                    const approved = localApprovals[d.day]
                    // 職長承認は「該当現場の職長」のみ操作可。adminは閲覧のみ。
                    const canApprove = userRole === 'foreman' && userForemanSites.includes(siteId)
                    // 既に最終承認済みの場合は職長承認も解除できない（先に最終を外す必要）
                    const finalApproved = localFinalApprovals[d.day]
                    const cellLocked = approved && finalApproved
                    const clickable = canApprove && !cellLocked
                    return (
                      <td
                        key={d.day}
                        className={`px-0 py-1 border-l border-orange-100 bg-orange-50 text-center ${clickable ? 'cursor-pointer hover:bg-orange-100' : ''}`}
                        style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                        onClick={clickable ? () => {
                          setLocalApprovals(prev => ({ ...prev, [d.day]: !prev[d.day] }))
                          // 解除する場合は最終承認も画面上で消す（API側が連動して削除する）
                          if (approved) {
                            setLocalFinalApprovals(prev => {
                              const next = { ...prev }
                              delete next[d.day]
                              return next
                            })
                          }
                          fetch('/api/attendance/grid', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                            body: JSON.stringify({
                              action: approved ? 'unapprove_foreman' : 'approve_foreman',
                              siteId, ym, day: d.day, approvedBy: userId,
                            }),
                          }).catch(() => {})
                        } : undefined}
                        title={
                          cellLocked ? '最終承認済のため解除不可（先に最終承認を外す）'
                          : canApprove ? (approved ? 'クリックで承認解除' : 'クリックで職長承認')
                          : '担当現場の職長のみ操作可'
                        }
                      >
                        {approved ? (
                          <span className="text-orange-600 text-[11px] font-bold">&#x2713;</span>
                        ) : (
                          <span className={`text-[11px] ${clickable ? 'text-orange-400' : 'text-orange-300'}`}>-</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-1 py-1 text-center border-l-2 border-orange-200 bg-orange-50" style={{ width: 80, minWidth: 80 }}></td>
                </tr>

                {/* ── 最終承認 row（事業責任者・管理者: 職長承認後のみ操作可） ── */}
                <tr className="bg-indigo-50 border-b border-indigo-200">
                  <td
                    className="sticky left-0 z-20 bg-indigo-50 px-2 py-1 font-bold text-indigo-700 whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    最終承認
                    {(userRole === 'admin' || userRole === 'approver') && (() => {
                      // 職長承認済かつ最終未承認の日だけが対象
                      const finalizableDays = days.filter(d => localApprovals[d.day] && !localFinalApprovals[d.day])
                      return finalizableDays.length > 0 ? (
                        <button
                          onClick={async () => {
                            const updated = { ...localFinalApprovals }
                            for (const d of finalizableDays) updated[d.day] = true
                            setLocalFinalApprovals(updated)
                            for (const d of finalizableDays) {
                              fetch('/api/attendance/grid', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                                body: JSON.stringify({ action: 'approve_final', siteId, ym, day: d.day, approvedBy: userId }),
                              }).catch(() => {})
                            }
                          }}
                          className="ml-2 text-[9px] bg-indigo-600 text-white px-1.5 py-0.5 rounded hover:bg-indigo-700 transition"
                        >
                          一括最終承認
                        </button>
                      ) : null
                    })()}
                  </td>
                  <td className="sticky left-[150px] z-20 bg-indigo-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => {
                    const foremanApproved = localApprovals[d.day]
                    const finalApproved = localFinalApprovals[d.day]
                    const canFinalize = userRole === 'admin' || userRole === 'approver'
                    // 職長承認なしには最終承認は付けられない
                    const clickable = canFinalize && (finalApproved || foremanApproved)
                    return (
                      <td
                        key={d.day}
                        className={`px-0 py-1 border-l border-indigo-100 bg-indigo-50 text-center ${clickable ? 'cursor-pointer hover:bg-indigo-100' : ''}`}
                        style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                        onClick={clickable ? () => {
                          setLocalFinalApprovals(prev => ({ ...prev, [d.day]: !prev[d.day] }))
                          fetch('/api/attendance/grid', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                            body: JSON.stringify({
                              action: finalApproved ? 'unapprove_final' : 'approve_final',
                              siteId, ym, day: d.day, approvedBy: userId,
                            }),
                          }).catch(() => {})
                        } : undefined}
                        title={
                          finalApproved ? 'クリックで最終承認解除'
                          : !canFinalize ? '管理者・事業責任者のみ操作可'
                          : !foremanApproved ? '職長承認後に押せます'
                          : 'クリックで最終承認'
                        }
                      >
                        {finalApproved ? (
                          <span className="text-indigo-700 text-[11px] font-bold">&#x2713;&#x2713;</span>
                        ) : foremanApproved && canFinalize ? (
                          <span className="text-[11px] text-indigo-400">-</span>
                        ) : (
                          <span className="text-[11px] text-indigo-200">·</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-1 py-1 text-center border-l-2 border-indigo-200 bg-indigo-50" style={{ width: 80, minWidth: 80 }}></td>
                </tr>

                {/* ── Worker groups ── */}
                {groupedWorkers.map(group => (
                  <React.Fragment key={`group-${group.org}`}>
                    {/* Group header */}
                    <tr className="bg-gray-50">
                      <td
                        className="sticky left-0 z-20 bg-gray-50 px-2 py-1 font-bold text-[11px] text-hibi-navy border-t-2 border-hibi-navy"
                        style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                      >
                        {group.label} ({group.workers.length}名)
                      </td>
                      <td className="sticky left-[150px] z-20 bg-gray-50 border-t-2 border-hibi-navy" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
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
                        <tr key={worker.id} className="border-t-2 border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
                          {/* Worker name - sticky */}
                          <td
                            className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium text-gray-800 text-xs"
                            style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                          >
                            <div className="flex items-center gap-1 flex-wrap">
                              <span>{worker.name}</span>
                              {(() => {
                                const rb = retirementBadge(worker.retired)
                                if (!rb) return null
                                return (
                                  <span
                                    className={`text-[9px] px-1 py-0.5 rounded font-bold whitespace-nowrap ${rb.cls}`}
                                    title={rb.title}
                                  >
                                    {rb.label}
                                  </span>
                                )
                              })()}
                            </div>
                          </td>

                          {/* Org badge - sticky (colored by visa) */}
                          <td
                            className="sticky left-[150px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center"
                            style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                          >
                            <span className={`text-[10px] px-1 py-0.5 rounded-full font-medium whitespace-nowrap ${orgBadgeCls(worker.org, worker.visa)}`}>
                              {orgBadgeLabel(worker.org, worker.visa)}
                            </span>
                          </td>

                          {/* Day cells */}
                          {days.map(d => {
                            let entry = entries[d.day] || null
                            // 帰国判定: homeLeaves の期間に含まれるか（出面に hk がない場合も対応）
                            // ★ 明示的な他ステータス（有給P・欠勤R・現場休みH・試験Exam・出勤w>0）が
                            //   ある場合は帰国マーカーを上書きしない。
                            //   これにより「帰国期間中の有給事後計上」(p:1書き込み) が正しく
                            //   有給として表示される。
                            const hasExplicitStatus = entry && (
                              entry.p || entry.r || entry.h ||
                              (entry as { exam?: number }).exam ||
                              (entry.w !== undefined && entry.w > 0)
                            )
                            if (!entry?.hk && !hasExplicitStatus && data.homeLeaves?.length) {
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
                                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                                  >
                                    <div className="flex items-center justify-center h-full py-2">
                                      <span className="text-[10px] font-bold text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded">✈帰国</span>
                                    </div>
                                  </td>
                                )
                              }

                              // ベトナム人スタッフのスマホ入力待ち: admin/foreman は触れない (2026-05-08)
                              // entry が無い場合はスタッフ本人のスマホからの入力を待つ
                              if (!entry) {
                                return (
                                  <td key={d.day}
                                    className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                                    title="スタッフ本人のスマホ入力待ち"
                                  >
                                    <div className="flex items-center justify-center h-full py-2 opacity-50">
                                      <span className="text-[10px] text-gray-400">📱待機中</span>
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
                                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                                      onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)}
                                      data-att-status="1"
                                      data-att-day={d.day}
                                      data-att-row={wId}
                                      disabled={isLocked}
                                      className={`w-full text-center text-xs font-bold py-0.5 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
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
                                        {/* 始業・終業（時刻フル表示） */}
                                        <div className="flex items-center gap-0 w-full">
                                          <select
                                            value={st}
                                            onChange={e => handleStartTimeChange(wId, d.day, e.target.value)}
                                            onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)}
                                            disabled={isLocked}
                                            className="w-1/2 text-center text-[11px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700 tabular-nums"
                                          >
                                            {startTimeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                                          </select>
                                          <select
                                            value={et}
                                            onChange={e => handleEndTimeChange(wId, d.day, e.target.value)}
                                            onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)}
                                            disabled={isLocked}
                                            className="w-1/2 text-center text-[11px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700 tabular-nums"
                                          >
                                            {endTimeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                                          </select>
                                        </div>
                                        {/* 休憩チェック + 実時間 */}
                                        <div className="flex items-center justify-center gap-1 w-full px-0.5">
                                          <label className="flex items-center cursor-pointer" title="午前(10:00-10:30)">
                                            <input type="checkbox" checked={b1 === 1} onChange={e => handleBreakChange(wId, d.day, 'b1', e.target.checked)} onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)} disabled={isLocked} className="w-3 h-3 rounded" />
                                          </label>
                                          <label className="flex items-center cursor-pointer" title="午後(15:00-15:30)">
                                            <input type="checkbox" checked={b3 === 1} onChange={e => handleBreakChange(wId, d.day, 'b3', e.target.checked)} onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)} disabled={isLocked} className="w-3 h-3 rounded" />
                                          </label>
                                          <span className={`text-[10px] tabular-nums ml-auto font-bold ${actualH > 7 ? 'text-amber-600' : 'text-gray-500'}`}>
                                            {actualH.toFixed(1)}
                                          </span>
                                        </div>
                                      </>
                                    ) : statusVal !== '' ? (
                                      <div className="text-[11px] text-center py-0.5 font-medium text-gray-400">
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
                                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                                style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                                    onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)}
                                    data-att-status="1"
                                    data-att-day={d.day}
                                    data-att-row={wId}
                                    disabled={isLocked}
                                    className={`w-full text-center text-sm font-bold py-1 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
                                      ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                      ${workVal === '1' ? 'text-green-700' : ''}
                                      ${workVal === '0.5' ? 'text-yellow-700' : ''}
                                      ${workVal === '0.6' ? 'text-orange-600' : ''}
                                      ${workVal === 'P' ? 'text-purple-600' : ''}
                                      ${workVal === 'E' ? 'text-indigo-600' : ''}
                                      ${workVal === '' ? 'text-gray-300 font-normal' : ''}
                                    `}
                                  >
                                    <option value="">-</option>
                                    <option value="1">1</option>
                                    <option value="0.5">0.5</option>
                                    <option value="0.6">0.6補</option>
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
                                    onKeyDown={e => handleAttCellKeyDown(e, d.day, wId)}
                                    disabled={isLocked || !canOt}
                                    className={`w-full text-center text-[10px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
                                      ${!canOt || isLocked ? 'opacity-20 cursor-not-allowed' : 'text-amber-600'}
                                    `}
                                  />
                                </div>
                              </td>
                            )
                          })}

                          {/* Totals - 人工計 + 残業 を 1 列に縦並び表示 (上: 人工, 下: 残業h) */}
                          <td className="px-2 py-1 text-center tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 80, minWidth: 80 }}>
                            <div className="font-bold text-sm text-hibi-navy">{totals.wSum > 0 ? totals.wSum : '-'}</div>
                            {(totals.compSum > 0 || totals.plSum > 0) && (
                              <div className="text-[9px] font-normal text-gray-400 leading-tight">
                                {[
                                  totals.compSum > 0 ? `補${Math.round(totals.compSum * 10) / 10}` : '',
                                  totals.plSum > 0 ? `有${totals.plSum}` : '',
                                ].filter(Boolean).join(' ')}
                              </div>
                            )}
                            <div className="font-bold text-sm text-amber-600 mt-0.5 border-t border-gray-200 pt-0.5">
                              {totals.oSum > 0 ? `${totals.oSum}h` : '-'}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </React.Fragment>
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
                      <td className="sticky left-[150px] z-20 bg-amber-50 border-t-2 border-amber-400" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
                      {days.map(d => <td key={d.day} className="border-t-2 border-amber-400 bg-amber-50" />)}
                      <td className="border-t-2 border-amber-400 bg-amber-50" />
                      <td className="border-t-2 border-amber-400 bg-amber-50" />
                    </tr>

                    {data.subcons.map(sc => {
                      const entries = subconEntries[sc.id] || {}
                      const totals = subconTotals(sc.id)
                      const isLocked = data.locked

                      return (
                        <tr key={sc.id} className="border-t-2 border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
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
                            style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                                style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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

                          {/* Totals - 人工計 + 残業計 を 1 列に縦並び表示 */}
                          <td className="px-2 py-1 text-center tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 80, minWidth: 80 }}>
                            <div className="font-bold text-sm text-hibi-navy">{totals.nSum > 0 ? totals.nSum : '-'}</div>
                            <div className="font-bold text-sm text-amber-600 mt-0.5 border-t border-gray-200 pt-0.5">
                              {totals.onSum > 0 ? `${totals.onSum}h` : '-'}
                            </div>
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
                  <td className="sticky left-[150px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#1B2A4A] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.tobi[d.day] > 0 ? Math.round(footerSums.tobi[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  {/* 鳶合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
                  <td className="bg-[#1B2A4A] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                    <div className="text-white font-bold">{footerSums.tobiTotal > 0 ? footerSums.tobiTotal : '-'}</div>
                    <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                      {footerSums.tobiOtTotal > 0 ? `${footerSums.tobiOtTotal}h` : '-'}
                    </div>
                  </td>
                </tr>

                {/* 鳶 残業合計（日ごと縦集計） */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#1B2A4A] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#2A3B5C]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    鳶 残業合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#1B2A4A] px-1 py-1 text-center border-t border-[#2A3B5C]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#1B2A4A] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#2A3B5C]"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.tobiOt[d.day] > 0 ? `${Math.round(footerSums.tobiOt[d.day] * 10) / 10}h` : '-'}
                    </td>
                  ))}
                  {/* 月計は鳶合計行に既に表示済みのため空白 */}
                  <td className="bg-[#1B2A4A] px-2 py-1 border-l-2 border-gray-400 border-t border-[#2A3B5C]" style={{ width: 80, minWidth: 80 }}></td>
                </tr>

                {/* Doko Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#243656] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    土工 合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#243656] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#243656] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.doko[d.day] > 0 ? Math.round(footerSums.doko[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  {/* 土工合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
                  <td className="bg-[#243656] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                    <div className="text-white font-bold">{footerSums.dokoTotal > 0 ? footerSums.dokoTotal : '-'}</div>
                    <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                      {footerSums.dokoOtTotal > 0 ? `${footerSums.dokoOtTotal}h` : '-'}
                    </div>
                  </td>
                </tr>

                {/* 土工 残業合計（日ごと縦集計） */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#243656] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#324867]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    土工 残業合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#243656] px-1 py-1 text-center border-t border-[#324867]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#243656] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#324867]"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.dokoOt[d.day] > 0 ? `${Math.round(footerSums.dokoOt[d.day] * 10) / 10}h` : '-'}
                    </td>
                  ))}
                  {/* 月計は土工合計行に既に表示済みのため空白 */}
                  <td className="bg-[#243656] px-2 py-1 border-l-2 border-gray-400 border-t border-[#324867]" style={{ width: 80, minWidth: 80 }}></td>
                </tr>

                {/* Grand Total */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#0F1D36] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    総合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#0F1D36] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#0F1D36] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.grand[d.day] > 0 ? Math.round(footerSums.grand[d.day] * 10) / 10 : '-'}
                    </td>
                  ))}
                  {/* 総合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
                  <td className="bg-[#0F1D36] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                    <div className="text-white font-bold">{footerSums.grandTotal > 0 ? footerSums.grandTotal : '-'}</div>
                    <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                      {footerSums.grandOtTotal > 0 ? `${footerSums.grandOtTotal}h` : '-'}
                    </div>
                  </td>
                </tr>

                {/* 総 残業合計（日ごと縦集計） */}
                <tr>
                  <td
                    className="sticky left-0 z-20 bg-[#0F1D36] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#1F2D44]"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    総 残業合計
                  </td>
                  <td className="sticky left-[150px] z-20 bg-[#0F1D36] px-1 py-1 text-center border-t border-[#1F2D44]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
                  {days.map(d => (
                    <td
                      key={d.day}
                      className="bg-[#0F1D36] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#1F2D44]"
                      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    >
                      {footerSums.grandOt[d.day] > 0 ? `${Math.round(footerSums.grandOt[d.day] * 10) / 10}h` : '-'}
                    </td>
                  ))}
                  {/* 月計は総合計行に既に表示済みのため空白 */}
                  <td className="bg-[#0F1D36] px-2 py-1 border-l-2 border-gray-400 border-t border-[#1F2D44]" style={{ width: 80, minWidth: 80 }}></td>
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
        // 🛡 重要: key に siteId+ym を含めることで、開いている間にサイト・月が
        // 切り替わった場合に強制 re-mount し、内部 state を新しい配置で初期化する。
        // これをしないと、サイト切替後に古いサイトの workers がそのまま新しい
        // サイトに保存されるバグが起きる（2026-05-27 sasazuka → IHIメンバー上書き事案）。
        <AssignModal
          key={`assign-modal-${data.site.id}-${ym}`}
          siteId={data.site.id}
          ym={ym}
          siteName={data.site.name}
          currentWorkerIds={data.workers.map(w => w.id)}
          allWorkers={data.allWorkers || []}
          currentSubconIds={data.subcons.map(sc => sc.id)}
          allSubcons={data.allSubcons || []}
          onSave={handleSaveAssign}
          onClose={() => setShowAssignModal(false)}
        />
      )}
    </div>
  )
}

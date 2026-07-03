'use client'

// 出面入力ページ（司令塔）
// データ取得・入力状態・デバウンス保存・承認ハンドラを担当し、表示は
// components/ 配下（画面固有）と components/attendance/ 配下（バナー類・配置モーダル）に委譲。
// 純粋な計算（フッター合計・警告収集・退職バッジ等）は lib/attendance-grid.ts を参照。

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { isTimeBasedMonth, calcActualHours } from '@/types'
import {
  currentYm, getYmOptions, getDow, DOW_JA,
  computeWorkerTotals, computeSubconTotals, computeFooterSums, EMPTY_FOOTER_SUMS,
  collectSundayWarnings, collectHolidayWorkWarnings,
} from '@/lib/attendance-grid'
import AttendanceActionBar from '@/components/AttendanceActionBar'
import HomeLeaveBanner from '@/components/attendance/HomeLeaveBanner'
import UpcomingRetirementsBanner from '@/components/attendance/UpcomingRetirementsBanner'
import NextMonthCalendarBanner from '@/components/attendance/NextMonthCalendarBanner'
import AttendanceWarningBanner from '@/components/attendance/AttendanceWarningBanner'
import AssignModal from '@/components/attendance/AssignModal'
import { GridData, AttEntry, SubconDayEntry, PendingSave, Worker } from './types'
import HeaderBar from './components/HeaderBar'
import AttendanceGrid from './components/AttendanceGrid'

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

  // Save status: null | 'saving' | 'saved' | 'error'
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
        entry = { w: 0, exam: 1 }
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
    else if (value === 'E') entry = { w: 0, exam: 1 }

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
        entry = { w: 0, exam: 1, s: 'admin' }
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
    else if (value === 'E') entry = { w: 0, exam: 1, s: 'admin' }
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
      const actual = calcActualHours(updated)
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    // For save: get current entry and apply
    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, st, s: 'admin' }
    const actual = calcActualHours(updated)
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
      const actual = calcActualHours(updated)
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, et, s: 'admin' }
    const actual = calcActualHours(updated)
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
      const actual = calcActualHours(updated)
      const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
      updated.o = otH > 0 ? otH : undefined
      entries[day] = updated
      next[workerId] = entries
      return next
    })

    const current = workerEntries[workerId]?.[day] || { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: 'admin' }
    const updated = { ...current, [breakKey]: checked ? 1 : 0, s: 'admin' }
    const actual = calcActualHours(updated)
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

  // ── Approval handlers（楽観的UI） ──

  // 職長承認は「該当現場の職長」のみ操作可。adminは閲覧のみ。
  const canForemanApprove = userRole === 'foreman' && userForemanSites.includes(siteId)
  const canFinalize = userRole === 'admin' || userRole === 'approver'

  const handleForemanApproveAll = useCallback(() => {
    if (!data) return
    const unapprovedDays = Array.from({ length: data.daysInMonth }, (_, i) => i + 1)
      .filter(d => !localApprovals[d])
    const updated = { ...localApprovals }
    for (const d of unapprovedDays) updated[d] = true
    setLocalApprovals(updated)
    for (const d of unapprovedDays) {
      fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'approve_foreman', siteId, ym, day: d, approvedBy: userId }),
      }).catch(() => {})
    }
  }, [data, localApprovals, password, siteId, ym, userId])

  const handleToggleForemanApproval = useCallback((day: number) => {
    const approved = localApprovals[day]
    setLocalApprovals(prev => ({ ...prev, [day]: !prev[day] }))
    // 解除する場合は最終承認も画面上で消す（API側が連動して削除する）
    if (approved) {
      setLocalFinalApprovals(prev => {
        const next = { ...prev }
        delete next[day]
        return next
      })
    }
    fetch('/api/attendance/grid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        action: approved ? 'unapprove_foreman' : 'approve_foreman',
        siteId, ym, day, approvedBy: userId,
      }),
    }).catch(() => {})
  }, [localApprovals, password, siteId, ym, userId])

  const handleFinalApproveAll = useCallback(() => {
    if (!data) return
    // 職長承認済かつ最終未承認の日だけが対象
    const finalizableDays = Array.from({ length: data.daysInMonth }, (_, i) => i + 1)
      .filter(d => localApprovals[d] && !localFinalApprovals[d])
    const updated = { ...localFinalApprovals }
    for (const d of finalizableDays) updated[d] = true
    setLocalFinalApprovals(updated)
    for (const d of finalizableDays) {
      fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'approve_final', siteId, ym, day: d, approvedBy: userId }),
      }).catch(() => {})
    }
  }, [data, localApprovals, localFinalApprovals, password, siteId, ym, userId])

  const handleToggleFinalApproval = useCallback((day: number) => {
    const finalApproved = localFinalApprovals[day]
    setLocalFinalApprovals(prev => ({ ...prev, [day]: !prev[day] }))
    fetch('/api/attendance/grid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        action: finalApproved ? 'unapprove_final' : 'approve_final',
        siteId, ym, day, approvedBy: userId,
      }),
    }).catch(() => {})
  }, [localFinalApprovals, password, siteId, ym, userId])

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

  // ── Computed: worker/subcon totals ──

  const workerTotals = useCallback((workerId: string) => {
    const entries = workerEntries[workerId] || {}
    // 外国人のみ時間ベース計算（202605〜かつvisaあり）
    // 2026-06-13: 旧契約継続者(フン等)はレガシー日数ベース計算なので時間ベースから除外
    const worker = data?.workers.find(w => String(w.id) === workerId)
    const foreign = !!worker?.visa && worker.visa !== 'none' && worker.visa !== ''
    const timeBased = useTimeBased && foreign && !worker?.useOldRules
    return computeWorkerTotals(entries, { timeBased, foreign })
  }, [workerEntries, useTimeBased, data])

  const subconTotals = useCallback((subconId: string) => {
    return computeSubconTotals(subconEntries[subconId] || {})
  }, [subconEntries])

  // ── Computed: footer summary rows ──

  const footerSums = useMemo(() => {
    if (!data) return EMPTY_FOOTER_SUMS
    return computeFooterSums(data.daysInMonth, data.workers, data.subcons, workerEntries, subconEntries)
  }, [data, workerEntries, subconEntries])

  // ── Computed: validation warnings ──

  const sundayWarnings = useMemo(() => {
    if (!data) return []
    return collectSundayWarnings(data.year, data.month, data.daysInMonth, data.workers, workerEntries)
  }, [data, workerEntries])

  const holidayWorkWarnings = useMemo(() => {
    if (!data) return []
    return collectHolidayWorkWarnings(data.daysInMonth, data.calendarDays, data.workers, workerEntries)
  }, [data, workerEntries])

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
      <HeaderBar
        data={data}
        useTimeBased={useTimeBased}
        saveStatus={saveStatus}
        workDaysInput={workDaysInput}
        siteId={siteId}
        ym={ym}
        showArchived={showArchived}
        allSites={allSites}
        ymOptions={ymOptions}
        onOpenAssign={() => setShowAssignModal(true)}
        onWorkDaysChange={handleWorkDaysChange}
        onSiteChange={setSiteId}
        onYmChange={setYm}
        onShowArchivedChange={setShowArchived}
      />

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-12 text-center text-gray-400">
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
        <AttendanceGrid
          data={data}
          days={days}
          cellWidth={cellWidth}
          useTimeBased={useTimeBased}
          groupedWorkers={groupedWorkers}
          workerEntries={workerEntries}
          subconEntries={subconEntries}
          footerSums={footerSums}
          localApprovals={localApprovals}
          localFinalApprovals={localFinalApprovals}
          canForemanApprove={canForemanApprove}
          canFinalize={canFinalize}
          startTimeOptions={startTimeOptions}
          endTimeOptions={endTimeOptions}
          workerTotals={workerTotals}
          subconTotals={subconTotals}
          onWorkChange={handleWorkChange}
          onOtChange={handleOtChange}
          onTimeStatusChange={handleTimeStatusChange}
          onStartTimeChange={handleStartTimeChange}
          onEndTimeChange={handleEndTimeChange}
          onBreakChange={handleBreakChange}
          onSubconNChange={handleSubconNChange}
          onSubconOnChange={handleSubconOnChange}
          onCellKeyDown={handleAttCellKeyDown}
          onForemanApproveAll={handleForemanApproveAll}
          onToggleForemanApproval={handleToggleForemanApproval}
          onFinalApproveAll={handleFinalApproveAll}
          onToggleFinalApproval={handleToggleFinalApproval}
        />
      )}

      {/* No data placeholder */}
      {!loading && !error && !data && !siteId && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-12 text-center text-gray-400">
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

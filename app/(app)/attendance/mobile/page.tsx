'use client'

/**
 * 職長スマホ画面（ログイン版・2026-09-02 追加）
 *
 * 職長がスマホだけで日常業務を完結できるようにするページ。タブ構成:
 *   出面   … 日別の出面入力（日本人・ベトナム人・外注人数）＋職長確認（承認/取り消し）
 *   申請   … 有給申請・帰国申請の職長承認（第1段階。最終承認は政仁さん）
 *   休日   … 就業カレンダーの休日設定 → 保存 → 政仁さんへ提出
 *   自分   … 自分の有給残・道具代残（詳細と申請はマイページへ）
 *
 * データと権限は既存 API をそのまま使う（このページ専用のAPIは作らない）:
 *   /api/attendance/grid      … 出面の取得・保存・職長承認（月次ロック/有給残/多現場ガード込み）
 *   /api/leave-request        … 有給申請の一覧・職長承認・却下
 *   /api/home-long-leave      … 帰国申請の一覧・職長承認・却下
 *   /api/calendar/status      … 就業カレンダーの取得
 *   /api/calendar/save-days   … 休日設定の保存（承認後修正の再確認フローもサーバ側で処理）
 *   /api/calendar/submit      … 政仁さんへ提出
 *   /api/mypage, /api/tool-budget … 自分の有給・道具代（token）
 *
 * ベトナム人の新規入力は本人スマホが原則（サーバ側 canAdminEditEntry が強制）。
 * この画面では PC グリッドと同じく「有給・欠勤・0.6補の後付け」と「既存エントリの修正」だけ許す。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AttendanceEntry, DayType,
  calcDayShiftHours, isTimeBasedMonth,
  DAY_START_OPTIONS, DAY_END_OPTIONS,
} from '@/types'
import { getWorkValue, getTimeStatusValue, DOW_JA } from '@/lib/attendance-grid'
import { generateDefaultDays } from '@/lib/calendar'

// ── 型 ──

interface GridWorker {
  id: number
  name: string
  org: string
  visa?: string
  job?: string
  useOldRules?: boolean
  retired?: string
}
interface GridSubcon { id: string; name: string }
interface GridData {
  site: { id: string; name: string }
  year: number
  month: number
  daysInMonth: number
  ym: string
  workers: GridWorker[]
  subcons: GridSubcon[]
  workerEntries: Record<string, Record<number, AttendanceEntry>>
  subconEntries: Record<string, Record<number, { n: number; on: number }>>
  lockedHibi: boolean
  lockedHfu: boolean
  foremanApprovals: Record<number, unknown>
  finalApprovals: Record<number, unknown>
  calendarDays: Record<string, DayType> | null
  sites: { id: string; name: string; archived?: boolean }[]
  homeLeaves: { workerId: number; startDate: string; endDate: string }[]
}

interface LeaveReq {
  id: string
  workerId: number
  workerName: string
  date: string
  ym: string
  siteId: string
  reason: string
  status: string
  requestedAt: string
}
interface HomeReq {
  id: string
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  note?: string
  status: string
}

type CalDays = Record<string, DayType>
interface CalInfo {
  days: CalDays | null
  status: string | null
  rejectedReason: string | null
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export default function ForemanMobilePage() {
  // ── 認証 ──
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState('')
  const [userId, setUserId] = useState(0)
  const [userToken, setUserToken] = useState('')
  const [foremanSites, setForemanSites] = useState<string[]>([])

  // ── 表示状態 ──
  const [tab, setTab] = useState<'day' | 'requests' | 'calendar' | 'me'>('day')
  const [siteId, setSiteId] = useState('')
  const today = new Date()
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()))
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(0)   // 進行中の保存数

  const y = viewDate.getFullYear()
  const m = viewDate.getMonth() + 1
  const day = viewDate.getDate()
  const ym = `${y}${pad2(m)}`
  const dateIso = `${y}-${pad2(m)}-${pad2(day)}`
  const source = userRole === 'foreman' ? 'foreman' : 'admin'

  // ── 認証読み込み ──
  useEffect(() => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { password: pw, user } = JSON.parse(stored)
        setPassword(pw)
        if (user) {
          setUserRole(user.role || '')
          setUserId(user.workerId || 0)
          setUserToken(user.token || '')
          setForemanSites(user.foremanSites || [])
          const saved = localStorage.getItem('hibi_mobile_site')
          const fs: string[] = user.foremanSites || []
          if (saved && (fs.includes(saved) || fs.length === 0)) setSiteId(saved)
          else if (fs.length > 0) setSiteId(fs[0])
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 管理者で担当現場が無い場合: カレンダーAPIから現場一覧を取って先頭を選ぶ
  useEffect(() => {
    if (!password || siteId || foremanSites.length > 0) return
    fetch(`/api/calendar/status?ym=${y}-${pad2(m)}`, { headers: { 'x-admin-password': password } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const first = d?.sites?.[0]?.siteId
        if (first) setSiteId(first)
      })
      .catch(() => {})
  }, [password, siteId, foremanSites, y, m])

  // ── 出面データ取得 ──
  const fetchGrid = useCallback(async () => {
    if (!password || !siteId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/attendance/grid?siteId=${siteId}&ym=${ym}`, {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) { setError(await res.text().catch(() => '') || 'データ取得に失敗しました'); return }
      setData(await res.json())
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, siteId, ym])

  useEffect(() => { fetchGrid() }, [fetchGrid])

  // ── 出面保存（楽観更新 + 失敗時に再取得で復元） ──
  const postGrid = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(s => s + 1)
    try {
      let res = await fetch('/api/attendance/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym, ...body }),
      })
      if (res.status === 409) {
        const errData = await res.clone().json().catch(() => null)
        if (errData?.code === 'LEAVE_OVERDRAFT') {
          const b = errData.balance
          const msg = b?.noGrant
            ? `${errData.workerName} さんには有給が付与されていません。\n\nこのまま有給として登録しますか？`
            : `${errData.workerName} さんの有給残は 0 日です（枠 ${b?.total}日 / 消化 ${b?.used}日）。\n\n残数を超えて登録しますか？（記録に残ります）`
          if (!confirm(msg)) { fetchGrid(); return false }
          res = await fetch('/api/attendance/grid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
            body: JSON.stringify({ siteId, ym, ...body, allowOverdraft: true }),
          })
        }
      }
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || `保存に失敗しました (${res.status})`)
        fetchGrid()
        return false
      }
      return true
    } catch {
      alert('通信エラーで保存できませんでした')
      fetchGrid()
      return false
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, siteId, ym, fetchGrid])

  const applyLocal = useCallback((workerId: number, entry: AttendanceEntry | null) => {
    setData(prev => {
      if (!prev) return prev
      const we = { ...prev.workerEntries }
      const mine = { ...(we[workerId] || {}) }
      if (entry) mine[day] = entry
      else delete mine[day]
      we[workerId] = mine
      return { ...prev, workerEntries: we }
    })
  }, [day])

  const saveEntry = useCallback((workerId: number, entry: AttendanceEntry | null) => {
    applyLocal(workerId, entry)
    postGrid({ day, workerId, entry })
  }, [applyLocal, postGrid, day])

  // ── エントリ構築（PCグリッドと同じ規則） ──
  const buildTimeStatus = useCallback((value: string): AttendanceEntry | null => {
    if (value === 'P') return { w: 0, p: 1, s: source }
    if (value === 'E') return { w: 0, exam: 1, s: source }
    if (value === 'R') return { w: 0, r: 1, s: source }
    if (value === 'H') return { w: 0, h: 1, s: source }
    if (value === 'C') return { w: 0.6, s: source }
    if (value === 'W') return { w: 1, st: '08:00', et: '17:00', b1: 1, b2: 1, b3: 1, s: source }
    return null
  }, [source])

  const withRecalcOt = (e: AttendanceEntry): AttendanceEntry => {
    // 残業h = 実働 − 7h（夜勤ブロックは含めない。PC グリッドと同一ルール）
    const actual = calcDayShiftHours(e)
    const otH = Math.max(0, Math.round((actual - 7) * 10) / 10)
    return { ...e, o: otH > 0 ? otH : undefined }
  }

  const changeTimeField = useCallback((workerId: number, patch: Partial<AttendanceEntry>) => {
    const existing = data?.workerEntries[workerId]?.[day]
    if (!existing) return
    const updated = withRecalcOt({ ...existing, ...patch, s: source })
    saveEntry(workerId, updated)
  }, [data, day, source, saveEntry])

  const buildLegacyWork = useCallback((value: string, existing: AttendanceEntry | undefined): AttendanceEntry | null => {
    let entry: AttendanceEntry | null = null
    if (value === '1') entry = { w: 1, s: source }
    else if (value === '0.5') entry = { w: 0.5, s: source }
    else if (value === '0.6') entry = { w: 0.6, s: source }
    else if (value === 'P') entry = { w: 0, p: 1, s: source }
    else if (value === 'E') entry = { w: 0, exam: 1, s: source }
    else if (value === 'R') entry = { w: 0, r: 1, s: source }
    if (entry && entry.w > 0 && entry.w !== 0.6 && existing?.o) entry.o = existing.o
    return entry
  }, [source])

  // ── 外注 ──
  const saveSubcon = useCallback((subconId: string, n: number, on: number) => {
    setData(prev => {
      if (!prev) return prev
      const se = { ...prev.subconEntries }
      const mine = { ...(se[subconId] || {}) }
      if (n > 0 || on > 0) mine[day] = { n, on }
      else delete mine[day]
      se[subconId] = mine
      return { ...prev, subconEntries: se }
    })
    postGrid({ day, subconId, subconEntry: n > 0 || on > 0 ? { n, on } : null })
  }, [postGrid, day])

  // ── 日別の派生情報 ──
  const dayType: DayType | null = data?.calendarDays ? (data.calendarDays[String(day)] || 'work') : null
  const isRestDay = dayType !== null && dayType !== 'work'
  const finalApproved = !!data?.finalApprovals?.[day]
  const foremanApproved = !!data?.foremanApprovals?.[day]
  const timeBasedMonth = isTimeBasedMonth(ym)

  const isHomeLeave = useCallback((wid: number) => {
    return (data?.homeLeaves || []).some(hl =>
      hl.workerId === wid && hl.startDate <= dateIso && dateIso <= hl.endDate)
  }, [data, dateIso])

  const lockedFor = useCallback((w: GridWorker) => {
    if (finalApproved) return true
    const org = (w.org || '').toLowerCase() === 'hfu' ? 'hfu' : 'hibi'
    return org === 'hfu' ? !!data?.lockedHfu : !!data?.lockedHibi
  }, [finalApproved, data])

  const missingWorkers = useMemo(() => {
    if (!data) return []
    return data.workers.filter(w =>
      !data.workerEntries[w.id]?.[day] && !isHomeLeave(w.id))
  }, [data, day, isHomeLeave])

  // ── 職長確認（承認 / 取り消し） ──
  const handleApprove = useCallback(async () => {
    if (!data) return
    if (missingWorkers.length === data.workers.length && data.workers.length > 0) {
      alert('この日はまだ誰も入力していません。入力してから確認してください。')
      return
    }
    if (missingWorkers.length > 0 && !confirm(
      `まだ ${missingWorkers.length}名 が未入力です（${missingWorkers.map(w => w.name).join('・')}）。\n`
      + `確認するとこの日はロックされ、スタッフは入力できなくなります。\n\n本当に確認済みにしますか？`
    )) return
    const ok = await postGrid({ action: 'approve_foreman', day, approvedBy: userId })
    if (ok) fetchGrid()
  }, [data, missingWorkers, postGrid, day, userId, fetchGrid])

  const handleUnapprove = useCallback(async () => {
    if (finalApproved) { alert('最終承認済みのため取り消せません。管理者に連絡してください。'); return }
    if (!confirm('この日の職長確認を取り消します。スタッフが再び入力できるようになります。よろしいですか？')) return
    const ok = await postGrid({ action: 'unapprove_foreman', day })
    if (ok) fetchGrid()
  }, [finalApproved, postGrid, day, fetchGrid])

  // ── 月の俯瞰（確認状況） ──
  const monthOverview = useMemo(() => {
    if (!data) return []
    const isCurMonth = today.getFullYear() === y && today.getMonth() + 1 === m
    const lastDay = isCurMonth ? today.getDate() : (new Date(y, m - 1, 1) < today ? data.daysInMonth : 0)
    const out: { d: number; isWork: boolean; approved: boolean; missing: number }[] = []
    for (let d = 1; d <= lastDay; d++) {
      const dt: DayType = data.calendarDays ? (data.calendarDays[String(d)] || 'work') : (new Date(y, m - 1, d).getDay() !== 0 ? 'work' : 'off')
      const missing = dt === 'work'
        ? data.workers.filter(w => !data.workerEntries[w.id]?.[d]
            && !(data.homeLeaves || []).some(hl => hl.workerId === w.id && hl.startDate <= `${y}-${pad2(m)}-${pad2(d)}` && `${y}-${pad2(m)}-${pad2(d)}` <= hl.endDate)).length
        : 0
      out.push({ d, isWork: dt === 'work', approved: !!data.foremanApprovals?.[d], missing })
    }
    return out
  }, [data, y, m, today])

  // ══════════ 申請タブ ══════════
  const [leaveReqs, setLeaveReqs] = useState<LeaveReq[]>([])
  const [homeReqs, setHomeReqs] = useState<HomeReq[]>([])
  const [reqLoading, setReqLoading] = useState(false)

  const fetchRequests = useCallback(async () => {
    if (!password || !siteId) return
    setReqLoading(true)
    try {
      const nextYm = m === 12 ? `${y + 1}01` : `${y}${pad2(m + 1)}`
      const [lr1, lr2, hr] = await Promise.all([
        fetch(`/api/leave-request?ym=${ym}`, { headers: { 'x-admin-password': password } }).then(r => r.ok ? r.json() : null),
        fetch(`/api/leave-request?ym=${nextYm}`, { headers: { 'x-admin-password': password } }).then(r => r.ok ? r.json() : null),
        fetch('/api/home-long-leave', { headers: { 'x-admin-password': password } }).then(r => r.ok ? r.json() : null),
      ])
      const all: LeaveReq[] = [...(lr1?.requests || []), ...(lr2?.requests || [])]
      setLeaveReqs(all
        .filter(r => r.siteId === siteId && (r.status === 'pending' || r.status === 'foreman_approved'))
        .sort((a, b) => a.date.localeCompare(b.date)))
      const siteWids = new Set((data?.workers || []).map(w => w.id))
      setHomeReqs(((hr?.requests || []) as HomeReq[])
        .filter(r => (r.status === 'pending' || r.status === 'foreman_approved') && siteWids.has(r.workerId))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)))
    } catch { /* ignore */ } finally {
      setReqLoading(false)
    }
  }, [password, siteId, ym, y, m, data])

  useEffect(() => { if (tab === 'requests') fetchRequests() }, [tab, fetchRequests])

  const pendingCount = leaveReqs.filter(r => r.status === 'pending').length
    + homeReqs.filter(r => r.status === 'pending').length

  const actOnRequest = useCallback(async (
    api: string, action: string, requestId: string, extra: Record<string, unknown> = {},
  ) => {
    setSaving(s => s + 1)
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action, requestId, ...extra }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || `処理に失敗しました (${res.status})`)
      }
      fetchRequests()
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, fetchRequests])

  // ══════════ 休日カレンダータブ ══════════
  const [calYmDate, setCalYmDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const calY = calYmDate.getFullYear()
  const calM = calYmDate.getMonth() + 1
  const calYm7 = `${calY}-${pad2(calM)}`
  const [calInfo, setCalInfo] = useState<CalInfo | null>(null)
  const [calDaysLocal, setCalDaysLocal] = useState<CalDays>({})
  const [calDirty, setCalDirty] = useState(false)
  const [calLoading, setCalLoading] = useState(false)
  const approvedEditWarned = useRef(false)

  const fetchCal = useCallback(async () => {
    if (!password || !siteId) return
    setCalLoading(true)
    try {
      const res = await fetch(`/api/calendar/status?ym=${calYm7}`, { headers: { 'x-admin-password': password } })
      const d = res.ok ? await res.json() : null
      const mine = d?.sites?.find((s: { siteId: string }) => s.siteId === siteId)
      const info: CalInfo = mine
        ? { days: mine.days, status: mine.status, rejectedReason: mine.rejectedReason }
        : { days: null, status: null, rejectedReason: null }
      setCalInfo(info)
      // 未作成の月は PC 画面と同じ既定値（日曜=off・祝日=holiday・それ以外=work）
      const defaults = generateDefaultDays(calY, calM)
      const init: CalDays = { ...defaults, ...(info.days || {}) }
      setCalDaysLocal(init)
      setCalDirty(false)
      approvedEditWarned.current = false
    } catch { /* ignore */ } finally {
      setCalLoading(false)
    }
  }, [password, siteId, calYm7, calY, calM])

  useEffect(() => { if (tab === 'calendar') fetchCal() }, [tab, fetchCal])

  const toggleCalDay = useCallback((d: number) => {
    if (calInfo?.status === 'approved' && !approvedEditWarned.current) {
      if (!confirm('このカレンダーは承認済みです。変更して保存すると「承認後修正」となり、スタッフの再確認（再署名）が必要になります。変更しますか？')) return
      approvedEditWarned.current = true
    }
    setCalDaysLocal(prev => ({ ...prev, [String(d)]: prev[String(d)] === 'work' ? 'off' : 'work' }))
    setCalDirty(true)
  }, [calInfo])

  const saveCal = useCallback(async (): Promise<boolean> => {
    setSaving(s => s + 1)
    try {
      const res = await fetch('/api/calendar/save-days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym: calYm7, days: calDaysLocal, updatedBy: userId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || '保存に失敗しました')
        return false
      }
      setCalDirty(false)
      return true
    } finally {
      setSaving(s => s - 1)
    }
  }, [password, siteId, calYm7, calDaysLocal, userId])

  const submitCal = useCallback(async () => {
    if (!confirm(`${calY}年${calM}月の休日設定を政仁さんへ提出します。よろしいですか？`)) return
    if (!(await saveCal())) return
    setSaving(s => s + 1)
    try {
      const res = await fetch('/api/calendar/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ siteId, ym: calYm7, submittedBy: userId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        alert(d?.error || '提出に失敗しました')
      }
      fetchCal()
    } finally {
      setSaving(s => s - 1)
    }
  }, [calY, calM, saveCal, password, siteId, calYm7, userId, fetchCal])

  // ══════════ 自分タブ ══════════
  const [myData, setMyData] = useState<{
    leave?: { noGrant: boolean; grantDate: string | null; periodEnd: string; total: number; used: number; remaining: number; fiveDayShortfall: number }
    tool?: { budget: number; used: number; remaining: number; period?: unknown }
  } | null>(null)

  useEffect(() => {
    if (tab !== 'me' || !userToken || myData) return
    Promise.all([
      fetch(`/api/mypage?token=${userToken}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/tool-budget?token=${userToken}`).then(r => r.ok ? r.json() : null),
    ]).then(([mp, tb]) => {
      setMyData({ leave: mp?.leave, tool: tb || undefined })
    }).catch(() => setMyData({}))
  }, [tab, userToken, myData])

  // ══════════ 描画 ══════════

  if (!password) {
    return <div className="p-6 text-center text-gray-500">ログイン情報が見つかりません。再ログインしてください。</div>
  }

  const siteOptions = (data?.sites || [])
    .filter(s => !s.archived && (foremanSites.length === 0 || foremanSites.includes(s.id)))

  const dow = new Date(y, m - 1, day).getDay()

  const navDay = (diff: number) => {
    const nd = new Date(y, m - 1, day + diff)
    if (nd > today) return
    setViewDate(nd)
  }

  const tabBtn = (key: typeof tab, label: string, badge?: number) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`relative flex-1 py-2.5 text-sm font-bold rounded-lg transition-colors ${
        tab === key ? 'bg-hibi-navy text-white' : 'bg-white text-gray-500 border border-gray-200'
      }`}
    >
      {label}
      {!!badge && (
        <span className="absolute -top-1.5 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  )

  return (
    <div className="max-w-md mx-auto px-3 pb-24">
      {/* 現場切替 */}
      {siteOptions.length > 1 && (
        <select
          value={siteId}
          onChange={e => { setSiteId(e.target.value); localStorage.setItem('hibi_mobile_site', e.target.value) }}
          className="w-full mt-3 rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold bg-white"
        >
          {siteOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <div className="flex items-center justify-between mt-3">
        {siteOptions.length <= 1 && data
          ? <div className="text-sm font-bold text-gray-700">{data.site.name}</div>
          : <div />}
        <a href="/attendance" className="text-xs font-bold text-blue-600 border border-blue-200 rounded-lg px-2 py-1 bg-white">🖥 PC版画面へ</a>
      </div>

      {/* タブバー */}
      <div className="flex gap-1.5 mt-3 sticky top-0 z-20 bg-gray-50 py-1.5">
        {tabBtn('day', '出面')}
        {tabBtn('requests', '申請', pendingCount)}
        {tabBtn('calendar', '休日')}
        {tabBtn('me', '自分')}
      </div>

      {saving > 0 && (
        <div className="fixed top-2 right-2 z-50 bg-amber-500 text-white text-xs font-bold px-2 py-1 rounded shadow">保存中…</div>
      )}
      {error && <div className="mt-3 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

      {/* ═══ 出面タブ ═══ */}
      {tab === 'day' && (
        <>
          {/* 日付ナビ */}
          <div className="flex items-center justify-between mt-3 bg-white rounded-xl border border-gray-200 px-2 py-2">
            <button onClick={() => navDay(-1)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">◀ 前日</button>
            <div className="text-center">
              <div className="font-bold">
                {m}月{day}日（{DOW_JA[dow]}）
                {isRestDay && <span className="ml-1 text-xs text-orange-600 font-bold">休日</span>}
              </div>
              {dateIso !== `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}` && (
                <button onClick={() => setViewDate(new Date(today.getFullYear(), today.getMonth(), today.getDate()))} className="text-[11px] text-blue-600 underline">今日へ</button>
              )}
            </div>
            <button
              onClick={() => navDay(1)}
              disabled={dateIso >= `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold disabled:opacity-30"
            >翌日 ▶</button>
          </div>

          {loading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}

          {!loading && data && (
            <>
              {/* 確認状態バナー */}
              {finalApproved ? (
                <div className="mt-3 p-2.5 rounded-lg bg-gray-100 text-gray-600 text-sm font-bold text-center">🔒 最終承認済み（編集できません）</div>
              ) : foremanApproved ? (
                <div className="mt-3 p-2.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-bold text-center">✅ 職長確認済み</div>
              ) : missingWorkers.length > 0 && !isRestDay ? (
                <div className="mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                  ⚠️ <b>{missingWorkers.length}名が未入力</b>: {missingWorkers.map(w => w.name).join('・')}
                </div>
              ) : null}

              {/* スタッフ一覧 */}
              <div className="mt-3 space-y-2">
                {data.workers.map(w => {
                  const entry = data.workerEntries[w.id]?.[day]
                  const locked = lockedFor(w)
                  const isVn = !!w.visa && w.visa !== 'none' && w.visa !== ''
                  const isTime = timeBasedMonth && isVn && !w.useOldRules
                  if (isHomeLeave(w.id)) {
                    return (
                      <div key={w.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 flex items-center justify-between">
                        <span className="font-bold text-sm">{w.name}</span>
                        <span className="text-xs font-bold text-cyan-700 bg-cyan-50 px-2 py-1 rounded-md">✈ 帰国中</span>
                      </div>
                    )
                  }
                  return (
                    <div key={w.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">
                          {w.name}
                          {entry?.s === 'staff' && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-blue-400" title="スタッフ入力" />}
                          {entry?.s === 'foreman' && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-orange-400" title="職長入力" />}
                        </span>
                        {isTime ? (
                          entry ? (
                            <select
                              value={getTimeStatusValue(entry)}
                              disabled={locked}
                              onChange={e => saveEntry(w.id, buildTimeStatus(e.target.value))}
                              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-bold bg-white"
                            >
                              <option value="">−（削除）</option>
                              <option value="W">出勤</option>
                              <option value="P">有給</option>
                              <option value="E">試験</option>
                              <option value="R">欠勤</option>
                              <option value="H">現場休</option>
                              <option value="C">0.6補</option>
                            </select>
                          ) : (
                            <span className="text-xs text-gray-400">📱 スマホ入力待ち</span>
                          )
                        ) : (
                          <select
                            value={getWorkValue(entry || null)}
                            disabled={locked}
                            onChange={e => saveEntry(w.id, buildLegacyWork(e.target.value, entry))}
                            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-bold bg-white"
                          >
                            <option value="">−</option>
                            <option value="1">出勤 1</option>
                            <option value="0.5">半日 0.5</option>
                            <option value="0.6">0.6補</option>
                            <option value="P">有給</option>
                            <option value="E">試験</option>
                            <option value="R">欠勤</option>
                          </select>
                        )}
                      </div>

                      {/* ベトナム人・未入力: 後付けできるステータスだけボタンで出す */}
                      {isTime && !entry && !locked && (
                        <div className="flex gap-1.5 mt-2">
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('C'))} className="flex-1 py-1.5 rounded-lg border border-orange-300 text-orange-600 text-xs font-bold">0.6補</button>
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('P'))} className="flex-1 py-1.5 rounded-lg border border-violet-300 text-violet-600 text-xs font-bold">有給</button>
                          <button onClick={() => saveEntry(w.id, buildTimeStatus('R'))} className="flex-1 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-bold">欠勤</button>
                        </div>
                      )}

                      {/* 時間ベース・出勤: 時刻と休憩 */}
                      {isTime && entry && getTimeStatusValue(entry) === 'W' && !entry.nonly && (
                        <div className="flex items-center gap-2 mt-2">
                          <select value={entry.st || '08:00'} disabled={locked} onChange={e => changeTimeField(w.id, { st: e.target.value })} className="rounded-lg border border-gray-300 px-1.5 py-1 text-sm tabular-nums bg-white">
                            {DAY_START_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <span className="text-gray-400">〜</span>
                          <select value={entry.et || '17:00'} disabled={locked} onChange={e => changeTimeField(w.id, { et: e.target.value })} className="rounded-lg border border-gray-300 px-1.5 py-1 text-sm tabular-nums bg-white">
                            {DAY_END_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <label className="flex items-center gap-0.5 text-[11px] text-gray-500">
                            <input type="checkbox" checked={(entry.b1 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b1: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午前
                          </label>
                          <label className="flex items-center gap-0.5 text-[11px] text-gray-500">
                            <input type="checkbox" checked={(entry.b3 ?? 1) === 1} disabled={locked} onChange={e => changeTimeField(w.id, { b3: e.target.checked ? 1 : 0 })} className="w-4 h-4" />午後
                          </label>
                          <span className="ml-auto text-xs font-bold tabular-nums text-gray-600">{calcDayShiftHours(entry).toFixed(1)}h</span>
                        </div>
                      )}
                      {isTime && entry && !!entry.nonly && (
                        <div className="mt-2 text-xs font-bold text-indigo-700 bg-indigo-50 rounded-md px-2 py-1 inline-block">夜勤のみ（編集はPC画面から）</div>
                      )}

                      {/* レガシー・出勤: 残業h */}
                      {!isTime && entry && entry.w > 0 && entry.w !== 0.6 && (
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-gray-500">残業</span>
                          <select
                            value={String(entry.o || 0)}
                            disabled={locked}
                            onChange={e => {
                              const v = parseFloat(e.target.value)
                              saveEntry(w.id, { ...entry, o: v > 0 ? v : undefined, s: source })
                            }}
                            className="rounded-lg border border-gray-300 px-2 py-1 text-sm tabular-nums bg-white"
                          >
                            {[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8].map(v => (
                              <option key={v} value={v}>{v === 0 ? 'なし' : `${v}h`}</option>
                            ))}
                          </select>
                          {!!entry.ns && <span className="text-[11px] font-bold text-indigo-600">夜勤あり（編集はPC）</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* 外注（応援）人数 */}
              {data.subcons.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-bold text-gray-500 mb-1.5">外注（応援）</div>
                  <div className="space-y-2">
                    {data.subcons.map(sc => {
                      const se = data.subconEntries[sc.id]?.[day]
                      const n = se?.n || 0
                      const on = se?.on || 0
                      const locked = finalApproved || (data.lockedHibi && data.lockedHfu)
                      return (
                        <div key={sc.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 flex items-center justify-between gap-2">
                          <span className="font-bold text-sm truncate">{sc.name}</span>
                          <div className="flex items-center gap-1.5">
                            <button disabled={locked || n <= 0} onClick={() => saveSubcon(sc.id, n - 1, on)} className="w-9 h-9 rounded-lg border border-gray-300 font-bold text-lg disabled:opacity-30">−</button>
                            <span className="w-8 text-center font-bold tabular-nums">{n}<span className="text-[10px] text-gray-400">人</span></span>
                            <button disabled={locked} onClick={() => saveSubcon(sc.id, n + 1, on)} className="w-9 h-9 rounded-lg border border-gray-300 font-bold text-lg disabled:opacity-30">＋</button>
                            <select
                              value={String(on)}
                              disabled={locked || n <= 0}
                              onChange={e => saveSubcon(sc.id, n, parseFloat(e.target.value))}
                              className="rounded-lg border border-gray-300 px-1 py-1.5 text-xs tabular-nums bg-white"
                              title="残業h"
                            >
                              {[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map(v => (
                                <option key={v} value={v}>{v === 0 ? '残業なし' : `残業${v}h`}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 職長確認 */}
              {!finalApproved && (
                <div className="mt-4">
                  {foremanApproved ? (
                    <button onClick={handleUnapprove} className="w-full rounded-xl py-3 text-sm font-bold bg-white border-2 border-red-300 text-red-600">↩️ この日の確認を取り消す</button>
                  ) : (
                    <button onClick={handleApprove} className="w-full rounded-xl py-3 text-sm font-bold bg-amber-500 text-white shadow">✅ この日を確認する（職長承認）</button>
                  )}
                </div>
              )}

              {/* 月の確認状況 */}
              <div className="mt-6">
                <div className="text-xs font-bold text-gray-500 mb-1.5">{m}月の確認状況</div>
                <div className="grid grid-cols-7 gap-1">
                  {monthOverview.map(o => (
                    <button
                      key={o.d}
                      onClick={() => setViewDate(new Date(y, m - 1, o.d))}
                      className={`rounded-lg py-1.5 text-center border ${
                        o.d === day ? 'ring-2 ring-hibi-navy ' : ''
                      }${
                        !o.isWork ? 'bg-gray-100 text-gray-400 border-gray-200'
                        : o.approved ? 'bg-green-50 text-green-700 border-green-200'
                        : o.missing > 0 ? 'bg-red-50 text-red-600 border-red-200'
                        : 'bg-white text-gray-700 border-gray-200'
                      }`}
                    >
                      <div className="text-xs font-bold tabular-nums">{o.d}</div>
                      <div className="text-[9px] leading-none">
                        {!o.isWork ? '休' : o.approved ? '✅' : o.missing > 0 ? `未${o.missing}` : '—'}
                      </div>
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-gray-400 mt-1">✅=確認済み ／ 未N=未入力N名 ／ タップでその日へ</div>
              </div>
            </>
          )}
        </>
      )}

      {/* ═══ 申請タブ ═══ */}
      {tab === 'requests' && (
        <div className="mt-3">
          {reqLoading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}
          {!reqLoading && (
            <>
              <div className="text-xs font-bold text-gray-500 mb-1.5">🌴 有給申請</div>
              {leaveReqs.length === 0 && <div className="bg-white rounded-xl border border-gray-200 p-3 text-sm text-gray-400 text-center">承認待ちの有給申請はありません</div>}
              <div className="space-y-2">
                {leaveReqs.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm">{r.workerName}</span>
                      <span className="text-sm font-bold tabular-nums">{r.date.slice(5).replace('-', '/')}</span>
                    </div>
                    {r.reason && <div className="text-xs text-gray-500 mt-0.5">{r.reason}</div>}
                    <div className="flex gap-2 mt-2">
                      {r.status === 'pending' ? (
                        <>
                          <button
                            onClick={() => actOnRequest('/api/leave-request', 'foreman_approve', r.id)}
                            className="flex-1 py-2 rounded-lg bg-hibi-navy text-white text-xs font-bold"
                          >職長承認する</button>
                          <button
                            onClick={() => {
                              const reason = prompt('却下の理由を入力してください')
                              if (reason !== null) actOnRequest('/api/leave-request', 'reject', r.id, { reason, rejectedBy: userId })
                            }}
                            className="py-2 px-3 rounded-lg border border-red-300 text-red-600 text-xs font-bold"
                          >却下</button>
                        </>
                      ) : (
                        <span className="text-xs font-bold text-blue-600 bg-blue-50 rounded-md px-2 py-1">職長承認済み → 政仁さんの最終承認待ち</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-xs font-bold text-gray-500 mb-1.5 mt-5">✈️ 帰国申請</div>
              {homeReqs.length === 0 && <div className="bg-white rounded-xl border border-gray-200 p-3 text-sm text-gray-400 text-center">承認待ちの帰国申請はありません</div>}
              <div className="space-y-2">
                {homeReqs.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm">{r.workerName}</span>
                      <span className="text-xs font-bold tabular-nums">{r.startDate.slice(5).replace('-', '/')} 〜 {r.endDate.slice(5).replace('-', '/')}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{r.reason}{r.note ? `（${r.note}）` : ''}</div>
                    <div className="flex gap-2 mt-2">
                      {r.status === 'pending' ? (
                        <>
                          <button
                            onClick={() => actOnRequest('/api/home-long-leave', 'foreman_approve', r.id)}
                            className="flex-1 py-2 rounded-lg bg-hibi-navy text-white text-xs font-bold"
                          >職長承認する</button>
                          <button
                            onClick={() => {
                              const reason = prompt('却下の理由を入力してください')
                              if (reason !== null) actOnRequest('/api/home-long-leave', 'reject', r.id, { reason })
                            }}
                            className="py-2 px-3 rounded-lg border border-red-300 text-red-600 text-xs font-bold"
                          >却下</button>
                        </>
                      ) : (
                        <span className="text-xs font-bold text-blue-600 bg-blue-50 rounded-md px-2 py-1">職長承認済み → 政仁さんの最終承認待ち</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-[10px] text-gray-400 mt-4">
                欠勤の届はスタッフが出面に直接「欠勤」で記録します（承認手続きはありません）。出面タブで確認してください。
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══ 休日カレンダータブ ═══ */}
      {tab === 'calendar' && (
        <div className="mt-3">
          <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-2 py-2">
            <button onClick={() => setCalYmDate(new Date(calY, calM - 2, 1))} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">◀</button>
            <div className="font-bold">{calY}年{calM}月</div>
            <button onClick={() => setCalYmDate(new Date(calY, calM, 1))} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold">▶</button>
          </div>

          {calLoading && <div className="py-10 text-center text-gray-400">読み込み中…</div>}

          {!calLoading && calInfo && (
            <>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-bold rounded-md px-2 py-1 ${
                  calInfo.status === 'approved' ? 'bg-green-50 text-green-700'
                  : calInfo.status === 'submitted' ? 'bg-blue-50 text-blue-700'
                  : calInfo.status === 'rejected' ? 'bg-red-50 text-red-700'
                  : calInfo.status === 'draft' ? 'bg-amber-50 text-amber-700'
                  : 'bg-gray-100 text-gray-500'
                }`}>
                  {calInfo.status === 'approved' ? '✅ 承認済み'
                    : calInfo.status === 'submitted' ? '📤 提出済み（承認待ち）'
                    : calInfo.status === 'rejected' ? '❌ 差し戻し'
                    : calInfo.status === 'draft' ? '📝 下書き'
                    : '未作成'}
                </span>
                <span className="text-xs text-gray-500">
                  休日 {Object.values(calDaysLocal).filter(v => v !== 'work').length}日
                </span>
              </div>
              {calInfo.status === 'rejected' && calInfo.rejectedReason && (
                <div className="mt-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs">差し戻し理由: {calInfo.rejectedReason}</div>
              )}

              {/* 月グリッド（タップで 稼働⇄休み 切替） */}
              <div className="mt-3 grid grid-cols-7 gap-1">
                {DOW_JA.map((d, i) => (
                  <div key={d} className={`text-center text-[10px] font-bold ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-400'}`}>{d}</div>
                ))}
                {Array.from({ length: new Date(calY, calM - 1, 1).getDay() }).map((_, i) => <div key={`sp${i}`} />)}
                {Array.from({ length: new Date(calY, calM, 0).getDate() }, (_, i) => i + 1).map(d => {
                  const rest = calDaysLocal[String(d)] !== 'work'
                  return (
                    <button
                      key={d}
                      onClick={() => toggleCalDay(d)}
                      className={`rounded-lg py-2 text-center border font-bold text-sm tabular-nums ${
                        rest ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-gray-700 border-gray-200'
                      }`}
                    >
                      {d}
                      <div className="text-[9px] leading-none font-normal">{rest ? '休' : ''}</div>
                    </button>
                  )
                })}
              </div>
              <div className="text-[10px] text-gray-400 mt-1.5">日付をタップすると 稼働 ⇄ 休み が切り替わります</div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={saveCal}
                  disabled={!calDirty}
                  className="flex-1 rounded-xl py-3 text-sm font-bold bg-white border-2 border-hibi-navy text-hibi-navy disabled:opacity-30"
                >保存する</button>
                {calInfo.status !== 'approved' && calInfo.status !== 'submitted' && (
                  <button
                    onClick={submitCal}
                    className="flex-1 rounded-xl py-3 text-sm font-bold bg-hibi-navy text-white"
                  >政仁さんへ提出</button>
                )}
              </div>
              {calInfo.status === 'approved' && (
                <div className="text-[10px] text-gray-400 mt-2">
                  承認済みのカレンダーを変更して保存すると「承認後修正」となり、スタッフの再確認が必要になります。
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ 自分タブ ═══ */}
      {tab === 'me' && (
        <div className="mt-3 space-y-3">
          {!userToken ? (
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-gray-500">
              スマホ用トークンが未発行のため表示できません。管理者に「人員マスタ → スマホURL発行」を依頼してください。
            </div>
          ) : !myData ? (
            <div className="py-10 text-center text-gray-400">読み込み中…</div>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-xs font-bold text-gray-500">🌴 自分の有給</div>
                {myData.leave && !myData.leave.noGrant ? (
                  <>
                    <div className="mt-1 flex items-baseline gap-1">
                      <span className="text-3xl font-bold tabular-nums text-hibi-navy">{myData.leave.remaining}</span>
                      <span className="text-sm text-gray-500">日 残っています（枠 {myData.leave.total}日 / 使用 {myData.leave.used}日）</span>
                    </div>
                    {myData.leave.grantDate && (
                      <div className="text-[11px] text-gray-400 mt-1">期間: {myData.leave.grantDate} 〜 {myData.leave.periodEnd}</div>
                    )}
                    {myData.leave.fiveDayShortfall > 0 && (
                      <div className="mt-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs font-bold">
                        ⚠️ 年5日の取得義務まで あと{myData.leave.fiveDayShortfall}日 足りません
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-1 text-sm text-gray-400">有給の付与情報がありません</div>
                )}
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-xs font-bold text-gray-500">🔧 道具代補助の残額</div>
                {myData.tool && typeof myData.tool.remaining === 'number' ? (
                  <div className="mt-1">
                    <span className="text-2xl font-bold tabular-nums text-hibi-navy">¥{myData.tool.remaining.toLocaleString()}</span>
                    <span className="text-xs text-gray-500 ml-2">年間 ¥{(myData.tool.budget || 0).toLocaleString()} のうち ¥{(myData.tool.used || 0).toLocaleString()} 使用</span>
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-gray-400">道具代の設定がありません</div>
                )}
              </div>

              <a
                href={`/mypage/${userToken}`}
                className="block w-full text-center rounded-xl py-3 text-sm font-bold bg-hibi-navy text-white"
              >有給の申請・詳細はマイページへ →</a>
            </>
          )}
        </div>
      )}
    </div>
  )
}

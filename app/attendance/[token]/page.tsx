'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { AttendanceEntry, AttendanceStatus, isTimeBasedMobile, isTimeBasedEntry } from '@/types'

interface SiteInfo { id: string; name: string }
interface AvailableSite { id: string; name: string; primary: boolean }

interface StaffData {
  worker: { id: number; name: string; nameVi?: string }
  site: SiteInfo
  allSites: SiteInfo[]
  availableSites?: AvailableSite[]
  today: { year: number; month: number; day: number; ym: string; dateLabel: string }
  currentEntry: AttendanceEntry | null
  currentStatus: AttendanceStatus
  todayLocked: boolean
  pastDays: {
    date: string; year: number; month: number; day: number
    entry: AttendanceEntry | null; status: AttendanceStatus
    locked: boolean; dayOffset: number
    siteName?: string
  }[]
}

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  work: 'しゅっきん', overtime: 'しゅっきん', rest: 'やすみ',
  leave: 'ゆうきゅう', site_off: 'げんばやすみ', none: 'みにゅうりょく',
}
const STATUS_EMOJI: Record<AttendanceStatus, string> = {
  work: '🔨', overtime: '🔨', rest: '🏠', leave: '🌴', site_off: '🚧', none: '—',
}
const STATUS_COLORS: Record<AttendanceStatus, string> = {
  work: 'bg-blue-100 text-blue-700', overtime: 'bg-orange-100 text-orange-700',
  rest: 'bg-gray-200 text-gray-600', leave: 'bg-green-100 text-green-700',
  site_off: 'bg-yellow-100 text-yellow-700', none: 'bg-red-50 text-red-400',
}

interface LeaveRequestData {
  id: string
  date: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  rejectedReason?: string
  requestedAt: string
}

export default function StaffAttendancePage() {
  const params = useParams()
  const token = params.token as string

  const [data, setData] = useState<StaffData | null>(null)
  const [siteId, setSiteId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOT, setShowOT] = useState(false)
  const [otHours, setOtHours] = useState(1.0)
  const [editingPast, setEditingPast] = useState<number | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [leaveDate, setLeaveDate] = useState('')
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestData[]>([])
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [leaveSuccess, setLeaveSuccess] = useState<string | null>(null)

  // Time-based input state (202605~)
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('17:00')
  const [break1, setBreak1] = useState(true)  // 10:00-10:30
  const break2 = true  // 12:00-13:00 昼休憩は必ず取得（固定）
  const [break3, setBreak3] = useState(true)  // 15:00-15:30

  // Time-based input for past day editing
  const [pastStartTime, setPastStartTime] = useState('08:00')
  const [pastEndTime, setPastEndTime] = useState('17:00')
  const [pastBreak1, setPastBreak1] = useState(true)
  const pastBreak2 = true  // 昼休憩は必ず取得（固定）
  const [pastBreak3, setPastBreak3] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const url = siteId
        ? `/api/attendance/staff?token=${token}&siteId=${siteId}`
        : `/api/attendance/staff?token=${token}`
      const res = await fetch(url)
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'エラー')
        return
      }
      const d: StaffData = await res.json()
      setData(d)
      setSiteId(d.site.id)

      // Restore OT state from current entry
      if (d.currentEntry?.w === 1 && d.currentEntry.o && d.currentEntry.o > 0) {
        setShowOT(true)
        setOtHours(d.currentEntry.o)
      } else {
        setShowOT(false)
        setOtHours(1.0)
      }

      // Restore time-based state from current entry
      if (d.currentEntry && isTimeBasedEntry(d.currentEntry)) {
        setStartTime(d.currentEntry.st || '08:00')
        setEndTime(d.currentEntry.et || '17:00')
        setBreak1(d.currentEntry.b1 === 1)
        // break2 is always true (lunch break is mandatory)
        setBreak3(d.currentEntry.b3 === 1)
      } else {
        setStartTime('08:00')
        setEndTime('17:00')
        setBreak1(true)
        // break2 is always true
        setBreak3(true)
      }
    } catch {
      setError('つうしん エラー')
    } finally {
      setLoading(false)
    }
  }, [token, siteId])

  useEffect(() => { fetchData() }, [fetchData])

  // Fetch leave requests when modal opens
  const fetchLeaveRequests = useCallback(async () => {
    try {
      const res = await fetch(`/api/leave-request?token=${token}`)
      if (res.ok) {
        const d = await res.json()
        setLeaveRequests(d.requests || [])
      }
    } catch { /* ignore */ }
  }, [token])

  // Initialize past day time state when edit modal opens
  useEffect(() => {
    if (editingPast !== null && data?.pastDays[editingPast]) {
      const pd = data.pastDays[editingPast]
      if (pd.entry && isTimeBasedEntry(pd.entry)) {
        setPastStartTime(pd.entry.st || '08:00')
        setPastEndTime(pd.entry.et || '17:00')
        setPastBreak1(pd.entry.b1 === 1)
        // pastBreak2 is always true
        setPastBreak3(pd.entry.b3 === 1)
      } else {
        setPastStartTime('08:00')
        setPastEndTime('17:00')
        setPastBreak1(true)
        // pastBreak2 is always true
        setPastBreak3(true)
      }
    }
  }, [editingPast, data])

  useEffect(() => {
    if (showLeaveModal) {
      fetchLeaveRequests()
      // Set default date to tomorrow
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const y = tomorrow.getFullYear()
      const m = String(tomorrow.getMonth() + 1).padStart(2, '0')
      const d = String(tomorrow.getDate()).padStart(2, '0')
      setLeaveDate(`${y}-${m}-${d}`)
      setLeaveReason('')
      setLeaveError(null)
      setLeaveSuccess(null)
    }
  }, [showLeaveModal, fetchLeaveRequests])

  const submitLeaveRequest = async () => {
    if (!data || leaveSubmitting || !leaveDate) return
    setLeaveSubmitting(true)
    setLeaveError(null)
    setLeaveSuccess(null)
    try {
      const res = await fetch('/api/leave-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          token,
          date: leaveDate,
          siteId: data.site.id,
          reason: leaveReason,
        }),
      })
      if (res.ok) {
        setLeaveSuccess('OK')
        setLeaveDate('')
        setLeaveReason('')
        fetchLeaveRequests()
        setTimeout(() => setLeaveSuccess(null), 2000)
      } else {
        const d = await res.json()
        const msg = d.error === 'Already requested' ? 'Already requested / Da gui roi'
          : d.error === 'No remaining leave' ? 'ゆうきゅう の こり 0 にち です / Khong con ngay phep'
          : d.error === 'Date must be in the future' ? 'Select a future date / Chon ngay trong tuong lai'
          : d.error || 'Error'
        setLeaveError(msg)
        setTimeout(() => setLeaveError(null), 3000)
      }
    } catch {
      setLeaveError('Error')
      setTimeout(() => setLeaveError(null), 3000)
    } finally {
      setLeaveSubmitting(false)
    }
  }

  const getMinDate = () => {
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  const formatLeaveDate = (dateStr: string) => {
    const [, m, d] = dateStr.split('-')
    return `${parseInt(m)}/${parseInt(d)}`
  }

  const submitEntry = async (
    choice: string,
    ot: number = 0,
    year?: number,
    month?: number,
    day?: number
  ) => {
    if (!data || saving) return
    setSaving(true)
    setSuccessMsg(null)
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          siteId: data.site.id,
          year: year || data.today.year,
          month: month || data.today.month,
          day: day || data.today.day,
          choice,
          overtimeHours: ot,
        }),
      })
      if (res.ok) {
        setSuccessMsg('✓')
        setTimeout(() => setSuccessMsg(null), 1500)
        setEditingPast(null)
        fetchData()
      } else {
        const d = await res.json()
        setError(d.error || 'エラー')
        setTimeout(() => setError(null), 3000)
      }
    } catch {
      setError('つうしん エラー')
      setTimeout(() => setError(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  const handleTimeBasedSubmit = async (
    choice: string,
    year?: number,
    month?: number,
    day?: number,
    overrideStartTime?: string,
    overrideEndTime?: string,
    overrideBreak1?: boolean,
    overrideBreak2?: boolean,
    overrideBreak3?: boolean,
  ) => {
    if (!data || saving) return
    setSaving(true)
    setSuccessMsg(null)
    const body: Record<string, unknown> = {
      token,
      siteId: data.site.id,
      year: year || data.today.year,
      month: month || data.today.month,
      day: day || data.today.day,
      choice,
    }
    if (choice === 'work') {
      body.startTime = overrideStartTime ?? startTime
      body.endTime = overrideEndTime ?? endTime
      body.break1 = (overrideBreak1 ?? break1) ? 1 : 0
      body.break2 = (overrideBreak2 ?? break2) ? 1 : 0
      body.break3 = (overrideBreak3 ?? break3) ? 1 : 0
    }
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setSuccessMsg('✓')
        setTimeout(() => setSuccessMsg(null), 1500)
        setEditingPast(null)
        fetchData()
      } else {
        const d = await res.json()
        setError(d.error || 'エラー')
        setTimeout(() => setError(null), 3000)
      }
    } catch {
      setError('つうしん エラー')
      setTimeout(() => setError(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  const handleChoice = (choice: string) => {
    if (choice === 'work') {
      submitEntry('work', showOT ? otHours : 0)
    } else if (choice === 'leave') {
      // 有給は申請モーダルを開く
      setShowOT(false)
      setShowLeaveModal(true)
    } else {
      setShowOT(false)
      submitEntry(choice)
    }
  }

  const toggleOT = () => {
    if (!data?.currentEntry || data.currentEntry.w !== 1) return
    if (showOT) {
      setShowOT(false)
      submitEntry('work', 0)
    } else {
      setShowOT(true)
      setOtHours(1.0)
      submitEntry('work', 1.0)
    }
  }

  const stepOT = (delta: number) => {
    const newVal = Math.max(0.5, Math.min(8, otHours + delta))
    setOtHours(newVal)
    submitEntry('work', newVal)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-hibi-navy text-lg">よみこみちゅう...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-xl shadow p-6 text-center max-w-sm w-full">
          <div className="text-red-500 text-lg font-bold mb-2">エラー</div>
          <div className="text-gray-700">{error}</div>
        </div>
      </div>
    )
  }

  if (!data) return null

  const currentStatus = data.currentStatus
  const currentYm = data.today.ym
  const useTimeBased = isTimeBasedMobile(currentYm)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-xl font-bold">{data.worker.name} さん</div>
          <div className="text-sm opacity-60 mt-1">{data.today.dateLabel}</div>
        </div>
      </div>

      {/* Site selector dropdown */}
      <div className="bg-white border-b px-4 py-3">
        <div className="max-w-lg mx-auto">
          <label className="text-xs text-gray-500 block mb-1">げんば / Công trường</label>
          <select
            value={data.site.id}
            onChange={(e) => { setSiteId(e.target.value); setLoading(true) }}
            className="w-full bg-gray-50 border border-gray-300 rounded-lg px-3 py-2.5 text-base text-hibi-navy font-bold appearance-none"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23666' stroke-width='2'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
          >
            {(data.availableSites || data.allSites.map(s => ({ ...s, primary: true }))).map(s => (
              <option key={s.id} value={s.id}>
                {s.primary ? '\u2605 ' : ''}{s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Success / Error */}
        {successMsg && (
          <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold text-lg animate-pulse">
            {successMsg}
          </div>
        )}
        {error && data && (
          <div className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm">
            {error}
          </div>
        )}

        {/* Today's status */}
        {data.todayLocked ? (
          <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 text-center">
            <div className="text-green-700 font-bold text-lg">🔒 かくにんずみ</div>
            <div className="text-green-600 text-sm mt-1">
              {STATUS_EMOJI[currentStatus]} {STATUS_LABELS[currentStatus]}
              {currentStatus === 'overtime' && data.currentEntry?.o ? ` +${data.currentEntry.o}h` : ''}
              {data.currentEntry?.st && data.currentEntry?.et && (
                <span className="block text-xs mt-0.5">{data.currentEntry.st}〜{data.currentEntry.et}</span>
              )}
            </div>
          </div>
        ) : useTimeBased ? (
          /* Time-based input (202605~) */
          <div className="space-y-4">
            {/* Start/End time pickers */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">始業 / Bat dau</p>
                <select value={startTime} onChange={e => setStartTime(e.target.value)}
                  className="text-2xl font-bold text-hibi-navy text-center w-full border-none bg-transparent">
                  {Array.from({length: 13}, (_, i) => {
                    const h = 6 + Math.floor(i / 2)
                    const m = i % 2 === 0 ? '00' : '30'
                    const val = `${String(h).padStart(2,'0')}:${m}`
                    return <option key={val} value={val}>{val}</option>
                  })}
                </select>
              </div>
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">終業 / Ket thuc</p>
                <select value={endTime} onChange={e => setEndTime(e.target.value)}
                  className="text-2xl font-bold text-hibi-navy text-center w-full border-none bg-transparent">
                  {Array.from({length: 17}, (_, i) => {
                    const h = 15 + Math.floor(i / 2)
                    const m = i % 2 === 0 ? '00' : '30'
                    const val = `${String(h).padStart(2,'0')}:${m}`
                    return <option key={val} value={val}>{val}</option>
                  })}
                </select>
              </div>
            </div>

            {/* Break checkboxes */}
            <div className="bg-white rounded-xl shadow p-4">
              <p className="text-xs text-gray-500 mb-2">休憩 / Nghỉ giải lao</p>
              <div className="space-y-2">
                {[
                  { id: 'b1', label: '10:00〜10:30（30分）', checked: break1, set: setBreak1 },
                  { id: 'b3', label: '15:00〜15:30（30分）', checked: break3, set: setBreak3 },
                ].map(b => (
                  <label key={b.id} className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={b.checked} onChange={e => b.set(e.target.checked)}
                      className="w-5 h-5 rounded text-hibi-navy" />
                    <span className={`text-sm ${b.checked ? 'text-gray-700' : 'text-red-500 font-bold'}`}>
                      {b.label}
                      {!b.checked && ' ← 未取得 / Không nghỉ'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Actual hours display */}
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">実労働時間 / Gio lam thuc te</p>
              <p className="text-3xl font-bold text-hibi-navy">
                {(() => {
                  const start = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1])
                  const end = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1])
                  let mins = end - start
                  if (break1) mins -= 30
                  if (break2) mins -= 60
                  if (break3) mins -= 30
                  const hours = Math.max(0, mins / 60)
                  return `${Math.floor(hours)}時間${Math.round((hours % 1) * 60)}分`
                })()}
              </p>
              {(() => {
                const start = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1])
                const end = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1])
                let mins = end - start
                if (break1) mins -= 30
                if (break2) mins -= 60
                if (break3) mins -= 30
                const ot = Math.max(0, mins / 60 - 7)
                return ot > 0 ? <p className="text-sm text-orange-600 mt-1">うち所定外: {ot.toFixed(1)}h</p> : null
              })()}
            </div>

            {/* Submit button */}
            <button
              onClick={() => handleTimeBasedSubmit('work')}
              disabled={saving}
              className="w-full bg-hibi-navy text-white rounded-2xl py-4 text-lg font-bold active:bg-hibi-light transition disabled:opacity-50"
            >
              出勤登録 / Xac nhan di lam
            </button>

            {/* Rest / Leave buttons */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => handleTimeBasedSubmit('rest')}
                disabled={saving}
                className="bg-gray-200 text-gray-700 rounded-2xl py-3 text-base font-bold active:bg-gray-300 transition disabled:opacity-50">
                休み / Nghi
              </button>
              <button onClick={() => setShowLeaveModal(true)}
                disabled={saving}
                className="bg-green-100 text-green-700 rounded-2xl py-3 text-base font-bold active:bg-green-200 transition disabled:opacity-50">
                有給申請 / Xin phep
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 4 Buttons (legacy: ~202604) */}
            <div className="grid grid-cols-3 gap-3">
              {([
                { choice: 'work', emoji: '🔨', label: 'しゅっきん', color: 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' },
                { choice: 'rest', emoji: '🏠', label: 'やすみ', color: 'bg-gray-400 hover:bg-gray-500 active:bg-gray-600' },
                { choice: 'leave', emoji: '🌴', label: 'ゆうきゅう\nしんせい', color: 'bg-green-500 hover:bg-green-600 active:bg-green-700' },
                // site_off（げんばやすみ）は変形労働時間制導入により非表示
                // 過去データの表示・集計には影響なし
              ] as const).map(btn => {
                const isActive = (
                  (btn.choice === 'work' && (currentStatus === 'work' || currentStatus === 'overtime')) ||
                  (btn.choice === 'rest' && currentStatus === 'rest') ||
                  (btn.choice === 'leave' && currentStatus === 'leave')
                )
                return (
                  <button
                    key={btn.choice}
                    onClick={() => handleChoice(btn.choice)}
                    disabled={saving}
                    className={`${btn.color} text-white rounded-xl py-5 text-center transition active:scale-95 disabled:opacity-50 ${
                      isActive ? 'ring-4 ring-offset-2 ring-hibi-navy' : ''
                    }`}
                  >
                    <div className="text-3xl mb-1">{btn.emoji}</div>
                    <div className="text-sm font-bold whitespace-pre-line leading-tight">{btn.label}</div>
                  </button>
                )
              })}
            </div>

            {/* Overtime section */}
            {(currentStatus === 'work' || currentStatus === 'overtime') && (
              <div className="bg-white rounded-xl shadow p-4">
                <div className="text-sm text-gray-600 mb-2 text-center">ざんぎょう ある？</div>
                <div className="flex items-center justify-center gap-4">
                  <button
                    onClick={toggleOT}
                    className={`px-6 py-2 rounded-lg font-bold text-sm transition ${
                      showOT ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-600'
                    }`}
                  >
                    {showOT ? 'あり' : 'なし'}
                  </button>
                  {showOT && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => stepOT(-0.5)}
                        className="w-11 h-11 bg-gray-200 rounded-lg text-xl font-bold active:bg-gray-300"
                      >
                        −
                      </button>
                      <span className="text-xl font-bold text-orange-600 w-16 text-center">
                        {otHours.toFixed(1)}h
                      </span>
                      <button
                        onClick={() => stepOT(0.5)}
                        className="w-11 h-11 bg-gray-200 rounded-lg text-xl font-bold active:bg-gray-300"
                      >
                        ＋
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Past 5 days */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-sm text-gray-500 mb-3 font-bold">さいきん 5にち</div>
          <div className="space-y-1.5">
            {data.pastDays.map((pd, i) => (
              <div
                key={i}
                className={`flex items-center justify-between py-2 px-3 rounded-lg ${
                  pd.locked ? 'bg-gray-50' : 'hover:bg-gray-50 cursor-pointer active:bg-gray-100'
                }`}
                onClick={() => !pd.locked && setEditingPast(i)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-gray-600 whitespace-nowrap">{pd.date}</span>
                  {pd.siteName && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 truncate">{pd.siteName}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {pd.entry?.st && pd.entry?.et ? (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      {STATUS_EMOJI[pd.status]} {pd.entry.st}〜{pd.entry.et}
                    </span>
                  ) : (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      {STATUS_EMOJI[pd.status]} {STATUS_LABELS[pd.status]}
                      {pd.status === 'overtime' && pd.entry?.o ? ` +${pd.entry.o}h` : ''}
                    </span>
                  )}
                  {pd.locked && <span className="text-xs">🔒</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-gray-400 py-2">
          まいにち いれてね！
        </div>
      </div>

      {/* Past day edit modal */}
      {editingPast !== null && data.pastDays[editingPast] && (() => {
        const pd = data.pastDays[editingPast]
        const pastYm = `${pd.year}${String(pd.month).padStart(2, '0')}`
        const pastTimeBased = isTimeBasedMobile(pastYm)
        return (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setEditingPast(null)}>
            <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center">
                {pd.date}
              </h3>
              <p className="text-sm text-gray-500 mb-4 text-center">なおす</p>

              {pastTimeBased ? (
                <div className="space-y-4">
                  {/* Start/End time pickers */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-gray-500 mb-1">始業</p>
                      <select value={pastStartTime} onChange={e => setPastStartTime(e.target.value)}
                        className="text-xl font-bold text-hibi-navy text-center w-full border-none bg-transparent">
                        {Array.from({length: 13}, (_, i) => {
                          const h = 6 + Math.floor(i / 2)
                          const m = i % 2 === 0 ? '00' : '30'
                          const val = `${String(h).padStart(2,'0')}:${m}`
                          return <option key={val} value={val}>{val}</option>
                        })}
                      </select>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-xs text-gray-500 mb-1">終業</p>
                      <select value={pastEndTime} onChange={e => setPastEndTime(e.target.value)}
                        className="text-xl font-bold text-hibi-navy text-center w-full border-none bg-transparent">
                        {Array.from({length: 17}, (_, i) => {
                          const h = 15 + Math.floor(i / 2)
                          const m = i % 2 === 0 ? '00' : '30'
                          const val = `${String(h).padStart(2,'0')}:${m}`
                          return <option key={val} value={val}>{val}</option>
                        })}
                      </select>
                    </div>
                  </div>

                  {/* Break checkboxes */}
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-500 mb-2">休憩</p>
                    <div className="space-y-2">
                      {[
                        { id: 'pb1', label: '10:00〜10:30（30分）', checked: pastBreak1, set: setPastBreak1 },
                        { id: 'pb3', label: '15:00〜15:30（30分）', checked: pastBreak3, set: setPastBreak3 },
                      ].map(b => (
                        <label key={b.id} className="flex items-center gap-3 cursor-pointer">
                          <input type="checkbox" checked={b.checked} onChange={e => b.set(e.target.checked)}
                            className="w-5 h-5 rounded text-hibi-navy" />
                          <span className={`text-sm ${b.checked ? 'text-gray-700' : 'text-red-500 font-bold'}`}>
                            {b.label}{!b.checked && ' ← 未取得'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Submit work with times */}
                  <button
                    onClick={() => handleTimeBasedSubmit('work', pd.year, pd.month, pd.day, pastStartTime, pastEndTime, pastBreak1, pastBreak2, pastBreak3)}
                    disabled={saving}
                    className="w-full bg-hibi-navy text-white rounded-xl py-3 font-bold active:scale-95 disabled:opacity-50"
                  >
                    出勤登録
                  </button>

                  {/* Rest button */}
                  <button
                    onClick={() => handleTimeBasedSubmit('rest', pd.year, pd.month, pd.day)}
                    disabled={saving}
                    className="w-full bg-gray-200 text-gray-700 rounded-xl py-3 font-bold active:scale-95 disabled:opacity-50"
                  >
                    休み / Nghi
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { choice: 'work', emoji: '🔨', label: 'しゅっきん', color: 'bg-blue-500' },
                    { choice: 'rest', emoji: '🏠', label: 'やすみ', color: 'bg-gray-400' },
                    // 有給は申請フロー経由のため過去日の直接入力は不可
                    // 管理者がPC出面入力画面から修正する
                  ] as const).map(btn => (
                    <button
                      key={btn.choice}
                      onClick={() => submitEntry(btn.choice, 0, pd.year, pd.month, pd.day)}
                      className={`${btn.color} text-white rounded-xl py-4 text-center active:scale-95`}
                    >
                      <div className="text-2xl mb-1">{btn.emoji}</div>
                      <div className="text-sm font-bold">{btn.label}</div>
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => setEditingPast(null)}
                className="w-full mt-3 bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
              >
                やめる
              </button>
            </div>
          </div>
        )
      })()}

      {/* Leave request modal */}
      {showLeaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setShowLeaveModal(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4 text-center">
              ゆうきゅう しんせい / Xin nghi phep
            </h3>

            {leaveSuccess && (
              <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold mb-3 animate-pulse">
                しんせい しました / Da gui don
              </div>
            )}
            {leaveError && (
              <div className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm mb-3">
                {leaveError}
              </div>
            )}

            {/* Date picker */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 block mb-1">
                ひにち をえらんでください / Chon ngay nghi
              </label>
              <input
                type="date"
                value={leaveDate}
                min={getMinDate()}
                onChange={e => setLeaveDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
              <p className="text-xs text-gray-400 mt-1">
                あした いこう / Tu ngay mai tro di
              </p>
            </div>

            {/* Reason */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 block mb-1">
                りゆう（にんい）/ Ly do (tuy chon)
              </label>
              <input
                type="text"
                value={leaveReason}
                onChange={e => setLeaveReason(e.target.value)}
                placeholder="つういん、よてい など"
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
            </div>

            {/* Submit */}
            <button
              onClick={submitLeaveRequest}
              disabled={leaveSubmitting || !leaveDate}
              className="w-full bg-green-500 hover:bg-green-600 active:bg-green-700 text-white rounded-xl py-3 font-bold text-base transition disabled:opacity-50 active:scale-95"
            >
              {leaveSubmitting ? '...' : 'しんせい する / Gui don'}
            </button>

            {/* Request history */}
            {leaveRequests.length > 0 && (
              <div className="mt-6">
                <div className="text-sm text-gray-500 font-bold mb-2">
                  しんせい りれき / Lich su don
                </div>
                <div className="space-y-2">
                  {leaveRequests.map(req => (
                    <div key={req.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50">
                      <span className="text-sm text-gray-700 font-medium">
                        {formatLeaveDate(req.date)}
                      </span>
                      <div className="flex items-center gap-2">
                        {req.status === 'approved' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-bold">
                            OK / Da duyet
                          </span>
                        )}
                        {req.status === 'pending' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                            まち / Dang cho
                          </span>
                        )}
                        {req.status === 'rejected' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold" title={req.rejectedReason || ''}>
                            NG / Tu choi
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setShowLeaveModal(false)}
              className="w-full mt-4 bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
            >
              とじる / Dong
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

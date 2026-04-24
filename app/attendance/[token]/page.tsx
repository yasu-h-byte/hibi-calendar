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
  toolBudgetRemaining: number | null
  toolBudgetPeriodEnd: string | null
  plRemaining: number | null
  plExpiryDate: string | null
  // Phase 8: FIFO内訳
  plCarryOverRemaining?: number | null
  plCarryOverExpiryDate?: string | null
  plCarryOverExpiryStatus?: 'ok' | 'warning' | 'expired' | null
  plGrantRemaining?: number | null
  plGrantExpiryDate?: string | null
  pastDays: {
    date: string; year: number; month: number; day: number
    entry: AttendanceEntry | null; status: AttendanceStatus
    locked: boolean; dayOffset: number
    siteName?: string
  }[]
}

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  work: '出勤', overtime: '出勤', rest: '休み',
  leave: '有給', site_off: '現場休み', none: '未入力',
}
const STATUS_EMOJI: Record<AttendanceStatus, string> = {
  work: '🔨', overtime: '🔨', rest: '🏠', leave: '🌴', site_off: '🚧', none: '—',
}
const STATUS_COLORS: Record<AttendanceStatus, string> = {
  work: 'bg-blue-100 text-blue-700', overtime: 'bg-orange-100 text-orange-700',
  rest: 'bg-gray-200 text-gray-600', leave: 'bg-green-100 text-green-700',
  site_off: 'bg-yellow-100 text-yellow-700', none: 'bg-red-50 text-red-400',
}

const REST_REASONS = [
  { value: 'sick', label: '体調不良', vi: 'Bị ốm' },
  { value: 'hospital', label: '通院', vi: 'Đi khám bệnh' },
  { value: 'personal', label: '私用', vi: 'Việc riêng' },
  { value: 'family', label: '家族の事情', vi: 'Việc gia đình' },
  { value: 'homeCountry', label: '帰国関連', vi: 'Liên quan về nước' },
  { value: 'other', label: 'その他', vi: 'Khác' },
]

interface LeaveRequestData {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected'
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
  const [leaveDateFrom, setLeaveDateFrom] = useState('')
  const [leaveDateTo, setLeaveDateTo] = useState('')
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestData[]>([])
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [leaveSuccess, setLeaveSuccess] = useState<string | null>(null)

  // Home long leave modal state
  const [showHomeLongLeaveModal, setShowHomeLongLeaveModal] = useState(false)
  const [hlStartDate, setHlStartDate] = useState('')
  const [hlEndDate, setHlEndDate] = useState('')
  const [hlReason, setHlReason] = useState('一時帰国')
  const [hlNote, setHlNote] = useState('')
  const [hlRequests, setHlRequests] = useState<{id:string;startDate:string;endDate:string;reason:string;status:string}[]>([])
  const [hlSubmitting, setHlSubmitting] = useState(false)
  const [hlError, setHlError] = useState<string | null>(null)
  const [hlSuccess, setHlSuccess] = useState<string | null>(null)

  // Absence report modal state
  const [showRestModal, setShowRestModal] = useState(false)
  const [restReason, setRestReason] = useState('sick')
  const [restNote, setRestNote] = useState('')

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
      // Set default date to 5 days from now
      const minD = new Date()
      minD.setDate(minD.getDate() + 5)
      const y = minD.getFullYear()
      const m = String(minD.getMonth() + 1).padStart(2, '0')
      const d = String(minD.getDate()).padStart(2, '0')
      setLeaveDateFrom(`${y}-${m}-${d}`)
      setLeaveDateTo(`${y}-${m}-${d}`)
      setLeaveReason('')
      setLeaveError(null)
      setLeaveSuccess(null)
    }
  }, [showLeaveModal, fetchLeaveRequests])

  // Fetch home long leave requests when modal opens
  const fetchHlRequests = useCallback(async () => {
    try {
      const res = await fetch(`/api/home-long-leave?token=${token}`)
      if (res.ok) {
        const d = await res.json()
        setHlRequests(d.requests || [])
      }
    } catch { /* ignore */ }
  }, [token])

  useEffect(() => {
    if (showHomeLongLeaveModal) {
      fetchHlRequests()
      // Set default start date to 14 days from now
      const minD = new Date()
      minD.setDate(minD.getDate() + 14)
      const y = minD.getFullYear()
      const m = String(minD.getMonth() + 1).padStart(2, '0')
      const d = String(minD.getDate()).padStart(2, '0')
      setHlStartDate(`${y}-${m}-${d}`)
      // Set default end date to 28 days from now
      const endD = new Date()
      endD.setDate(endD.getDate() + 28)
      setHlEndDate(`${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`)
      setHlReason('一時帰国')
      setHlNote('')
      setHlError(null)
      setHlSuccess(null)
    }
  }, [showHomeLongLeaveModal, fetchHlRequests])

  const submitHomeLongLeave = async () => {
    if (!data || hlSubmitting || !hlStartDate || !hlEndDate) return
    setHlSubmitting(true)
    setHlError(null)
    setHlSuccess(null)
    try {
      const res = await fetch('/api/home-long-leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          token,
          startDate: hlStartDate,
          endDate: hlEndDate,
          reason: hlReason,
          note: hlNote || undefined,
        }),
      })
      if (res.ok) {
        setHlSuccess('申請完了 / Đã gửi đơn')
        setHlStartDate('')
        setHlEndDate('')
        setHlReason('一時帰国')
        setHlNote('')
        fetchHlRequests()
        setTimeout(() => setHlSuccess(null), 3000)
      } else {
        const d = await res.json()
        const msg = d.error === 'Already requested' ? '申請済みです / Đã gửi rồi'
          : d.error === 'Start date must be at least 90 days ahead' ? '原則3ヶ月以上先の日付を選んでください / Chọn ngày ít nhất 3 tháng sau'
          : d.error || 'Error'
        setHlError(msg)
        setTimeout(() => setHlError(null), 3000)
      }
    } catch {
      setHlError('Error')
      setTimeout(() => setHlError(null), 3000)
    } finally {
      setHlSubmitting(false)
    }
  }

  const getHlMinDate = () => {
    const minD = new Date()
    minD.setDate(minD.getDate() + 90)
    return `${minD.getFullYear()}-${String(minD.getMonth() + 1).padStart(2, '0')}-${String(minD.getDate()).padStart(2, '0')}`
  }

  // 帰国申請用の日付選択肢を生成（minDateから180日間）
  const getHlDateOptions = (minDateStr?: string) => {
    const min = minDateStr || getHlMinDate()
    const start = new Date(min + 'T00:00:00')
    const options: { value: string; label: string }[] = []
    const dowLabel = ['日', '月', '火', '水', '木', '金', '土']
    for (let i = 0; i < 180; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${dowLabel[d.getDay()]}）`
      options.push({ value: val, label })
    }
    return options
  }

  const submitLeaveRequest = async () => {
    if (!data || leaveSubmitting || !leaveDateFrom) return
    setLeaveSubmitting(true)
    setLeaveError(null)
    setLeaveSuccess(null)
    try {
      // Build list of dates (from ~ to)
      const dates: string[] = []
      const from = new Date(leaveDateFrom + 'T00:00:00')
      const to = leaveDateTo ? new Date(leaveDateTo + 'T00:00:00') : from
      const current = new Date(from)
      while (current <= to) {
        const dow = current.getDay()
        if (dow !== 0) { // 日曜を除く
          dates.push(`${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`)
        }
        current.setDate(current.getDate() + 1)
      }
      if (dates.length === 0) { setLeaveError('日付を選択してください'); setLeaveSubmitting(false); return }

      // Submit each date
      let successCount = 0
      let lastError = ''
      for (const date of dates) {
        const res = await fetch('/api/leave-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'request',
            token,
            date,
            siteId: data.site.id,
            reason: leaveReason,
          }),
        })
        if (res.ok) {
          successCount++
        } else {
          const d = await res.json()
          lastError = d.error || 'Error'
        }
      }

      if (successCount > 0) {
        setLeaveSuccess(`${successCount}日分の申請完了 / Đã gửi ${successCount} ngày`)
        setLeaveDateFrom('')
        setLeaveDateTo('')
        setLeaveReason('')
        fetchLeaveRequests()
        setTimeout(() => setLeaveSuccess(null), 3000)
      }
      if (lastError && successCount < dates.length) {
        const msg = lastError === 'Already requested' ? '一部は申請済みです / Một số đã gửi rồi'
          : lastError === 'No remaining leave' ? '有給の残りがありません / Không còn ngày phép'
          : lastError
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
    const minD = new Date()
    minD.setDate(minD.getDate() + 5)
    const y = minD.getFullYear()
    const m = String(minD.getMonth() + 1).padStart(2, '0')
    const d = String(minD.getDate()).padStart(2, '0')
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
    } else if (choice === 'rest') {
      // 欠勤届モーダルを開く
      setShowOT(false)
      setShowRestModal(true)
    } else {
      setShowOT(false)
      submitEntry(choice)
    }
  }

  const handleRestSubmit = async () => {
    if (!data || saving) return
    setSaving(true)
    setSuccessMsg(null)
    const body: Record<string, unknown> = {
      token,
      siteId: data.site.id,
      year: data.today.year,
      month: data.today.month,
      day: data.today.day,
      choice: 'rest',
      restReason,
      restNote: restReason === 'other' ? restNote : undefined,
    }
    try {
      const res = await fetch('/api/attendance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setShowRestModal(false)
        setRestReason('sick')
        setRestNote('')
        setSuccessMsg('✓')
        setTimeout(() => setSuccessMsg(null), 1500)
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
              <button onClick={() => setShowRestModal(true)}
                disabled={saving}
                className="bg-gray-200 text-gray-700 rounded-2xl py-3 text-base font-bold active:bg-gray-300 transition disabled:opacity-50">
                欠勤届 / Xin nghi
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
                { choice: 'work', emoji: '🔨', label: '出勤 / Đi làm', color: 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' },
                { choice: 'rest', emoji: '🏠', label: '欠勤届\nXin nghi', color: 'bg-gray-400 hover:bg-gray-500 active:bg-gray-600' },
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

        {/* Leave request status (visible on main screen) */}
        {leaveRequests.length > 0 && leaveRequests.some(r => r.status === 'pending' || r.status === 'foreman_approved') && (
          <div className="bg-white rounded-xl shadow p-4">
            <div className="text-sm text-gray-500 mb-2 font-bold">有給申請の状況 / Trạng thái nghỉ phép</div>
            <div className="space-y-1.5">
              {leaveRequests.filter(r => r.status === 'pending' || r.status === 'foreman_approved').map(req => (
                <div key={req.id} className={`flex items-center justify-between py-2 px-3 rounded-lg ${req.status === 'pending' ? 'bg-yellow-50' : 'bg-blue-50'}`}>
                  <span className="text-sm font-medium text-gray-700">{formatLeaveDate(req.date)}</span>
                  {req.status === 'pending' && (
                    <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                      ⏳ 承認待ち / Đang chờ
                    </span>
                  )}
                  {req.status === 'foreman_approved' && (
                    <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                      🔵 職長済 / Đốc công đã duyệt
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info cards: PL remaining + Tool budget */}
        {(data.plRemaining !== null || data.toolBudgetRemaining !== null) && (
          <div className="grid grid-cols-2 gap-3">
            {data.plRemaining !== null && (
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-xs text-gray-400 mb-1">🌴 有給残り / Nghỉ phép còn</div>
                <div className="text-2xl font-bold text-green-600">{data.plRemaining}<span className="text-sm font-normal text-gray-400 ml-1">日</span></div>
                {/* Phase 8: FIFO内訳表示（繰越分と当期付与分） */}
                {((data.plCarryOverRemaining ?? 0) > 0 || (data.plGrantRemaining ?? 0) > 0) ? (
                  <div className="text-[10px] text-gray-500 mt-1 space-y-0.5">
                    {(data.plCarryOverRemaining ?? 0) > 0 && (
                      <div className={data.plCarryOverExpiryStatus === 'warning' ? 'text-orange-600 font-bold' : ''}>
                        {data.plCarryOverExpiryStatus === 'warning' && '⏰ '}
                        繰越 / Chuyển sang: <strong>{data.plCarryOverRemaining}日</strong>
                        {data.plCarryOverExpiryDate && (
                          <div className="text-[9px]">
                            〜{data.plCarryOverExpiryDate.replace(/-/g, '/')}
                          </div>
                        )}
                      </div>
                    )}
                    {(data.plGrantRemaining ?? 0) > 0 && (
                      <div>
                        当期 / Hiện tại: <strong>{data.plGrantRemaining}日</strong>
                        {data.plGrantExpiryDate && (
                          <div className="text-[9px]">
                            〜{data.plGrantExpiryDate.replace(/-/g, '/')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : data.plExpiryDate ? (
                  <div className="text-[11px] text-gray-500 mt-1">
                    〜{data.plExpiryDate.replace(/-/g, '/')}まで
                  </div>
                ) : (
                  <div className="text-[11px] text-gray-400">{data.plRemaining} ngày</div>
                )}
              </div>
            )}
            {data.toolBudgetRemaining !== null && (
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-xs text-gray-400 mb-1">🔧 道具代残り / Tiền dụng cụ còn</div>
                <div className="text-2xl font-bold text-blue-600">¥{data.toolBudgetRemaining.toLocaleString()}</div>
                {data.toolBudgetPeriodEnd && (
                  <div className="text-[11px] text-gray-500 mt-1">
                    {data.toolBudgetPeriodEnd.slice(5).replace('-', '/')}まで / đến {data.toolBudgetPeriodEnd.slice(5).replace('-', '/')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Past 5 days */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-sm text-gray-500 mb-3 font-bold">最近5日 / 5 ngày gần đây</div>
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
                      {pd.entry.st}〜{pd.entry.et}
                      {(() => {
                        const s = parseInt(pd.entry.st.split(':')[0]) * 60 + parseInt(pd.entry.st.split(':')[1] || '0')
                        const e = parseInt(pd.entry.et.split(':')[0]) * 60 + parseInt(pd.entry.et.split(':')[1] || '0')
                        let m = e - s - 60
                        if (pd.entry.b1) m -= 30
                        if (pd.entry.b3) m -= 30
                        const h = Math.max(0, Math.round(m / 6) / 10)
                        return ` (${h}h)`
                      })()}
                    </span>
                  ) : pd.status === 'none' ? (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      — 未入力
                    </span>
                  ) : (
                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                      {STATUS_EMOJI[pd.status]} {STATUS_LABELS[pd.status]}
                      {(pd.status === 'work' || pd.status === 'overtime') && pd.entry?.o ? ` +${pd.entry.o}h` : ''}
                    </span>
                  )}
                  {pd.locked && <span className="text-xs">🔒</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Home long leave button */}
        <div className="text-center py-3">
          <button onClick={() => {
              const min = getHlMinDate()
              if (!hlStartDate || hlStartDate < min) {
                setHlStartDate(min)
                const d = new Date(min + 'T00:00:00')
                d.setDate(d.getDate() + 14)
                setHlEndDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
              }
              setShowHomeLongLeaveModal(true)
            }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-purple-50 text-purple-700 rounded-xl text-sm font-medium hover:bg-purple-100 transition border border-purple-200">
            ✈️ 帰国申請 / Xin về nước
          </button>
        </div>

        {/* Guide link */}
        <div className="text-center py-3">
          <a href="/briefing-20260419.html" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-100 transition">
            📖 給与・勤怠ガイド / Hướng dẫn lương & chấm công
          </a>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-gray-400 py-2">
          毎日入力してください / Hãy nhập mỗi ngày
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
              <p className="text-sm text-gray-500 mb-4 text-center">修正</p>

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
                    onClick={async () => {
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
                            year: pd.year,
                            month: pd.month,
                            day: pd.day,
                            choice: 'rest',
                            restReason: 'personal',
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
                    }}
                    disabled={saving}
                    className="w-full bg-gray-200 text-gray-700 rounded-xl py-3 font-bold active:scale-95 disabled:opacity-50"
                  >
                    休み / Nghi
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { choice: 'work', emoji: '🔨', label: '出勤', color: 'bg-blue-500' },
                    { choice: 'rest', emoji: '🏠', label: 'やすみ', color: 'bg-gray-400' },
                    // 有給は申請フロー経由のため過去日の直接入力は不可
                    // 管理者がPC出面入力画面から修正する
                  ] as const).map(btn => (
                    <button
                      key={btn.choice}
                      onClick={async () => {
                        if (btn.choice === 'rest') {
                          // 過去日の休みはrestReason='personal'をデフォルト送信
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
                                year: pd.year,
                                month: pd.month,
                                day: pd.day,
                                choice: 'rest',
                                restReason: 'personal',
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
                        } else {
                          submitEntry(btn.choice, 0, pd.year, pd.month, pd.day)
                        }
                      }}
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

      {/* Absence report modal */}
      {showRestModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setShowRestModal(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center">
              欠勤届 / Đơn xin nghỉ
            </h3>
            <p className="text-xs text-gray-400 text-center mb-4">
              出勤日に休む場合の届出です / Đơn nghỉ khi ngày đi làm
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-600 font-bold block mb-2">
                  理由 / Lý do
                </label>
                <div className="space-y-2">
                  {REST_REASONS.map(r => (
                    <label key={r.value} className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition ${
                      restReason === r.value ? 'bg-hibi-navy text-white' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                    }`}>
                      <input type="radio" name="restReason" value={r.value}
                        checked={restReason === r.value}
                        onChange={() => setRestReason(r.value)}
                        className="hidden" />
                      <span className="font-medium">{r.label}</span>
                      <span className={`text-sm ${restReason === r.value ? 'text-white/70' : 'text-gray-400'}`}>/ {r.vi}</span>
                    </label>
                  ))}
                </div>
              </div>

              {restReason === 'other' && (
                <div>
                  <label className="text-sm text-gray-600 font-bold block mb-1">
                    補足 / Chi tiết
                  </label>
                  <input type="text" value={restNote} onChange={e => setRestNote(e.target.value)}
                    placeholder="理由を入力 / Nhập lý do"
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                </div>
              )}

              <button onClick={handleRestSubmit}
                disabled={saving}
                className="w-full bg-gray-700 text-white rounded-2xl py-4 text-base font-bold active:bg-gray-800 transition disabled:opacity-50">
                欠勤届を提出 / Gửi đơn xin nghỉ
              </button>

              <button onClick={() => setShowRestModal(false)}
                className="w-full bg-gray-200 text-gray-600 rounded-xl py-3 text-sm">
                戻る / Quay lại
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leave request modal */}
      {/* Leave Request Modal */}
      {showLeaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setShowLeaveModal(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4 text-center">
              有給申請 / Xin nghỉ phép
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

            {/* Date picker (range) */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 font-bold block mb-2">
                日付を選んでください / Chọn ngày nghỉ
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">開始日 / Từ ngày</label>
                  <input
                    type="date"
                    value={leaveDateFrom}
                    min={getMinDate()}
                    onChange={e => {
                      setLeaveDateFrom(e.target.value)
                      if (!leaveDateTo || e.target.value > leaveDateTo) setLeaveDateTo(e.target.value)
                    }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">終了日 / Đến ngày</label>
                  <input
                    type="date"
                    value={leaveDateTo}
                    min={leaveDateFrom || getMinDate()}
                    onChange={e => setLeaveDateTo(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
                  />
                </div>
              </div>
              {leaveDateFrom && leaveDateTo && leaveDateFrom !== leaveDateTo && (
                <p className="text-xs text-blue-600 mt-2 font-bold">
                  {(() => {
                    const from = new Date(leaveDateFrom + 'T00:00:00')
                    const to = new Date(leaveDateTo + 'T00:00:00')
                    let count = 0
                    const c = new Date(from)
                    while (c <= to) { if (c.getDay() !== 0) count++; c.setDate(c.getDate() + 1) }
                    return `${count}日分の申請になります / Sẽ gửi ${count} ngày`
                  })()}
                </p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                ※ 5日前から選べます / Chọn được từ 5 ngày trước
              </p>
            </div>

            {/* Reason */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 block mb-1">
                理由（任意）/ Lý do (tùy chọn)
              </label>
              <input
                type="text"
                value={leaveReason}
                onChange={e => setLeaveReason(e.target.value)}
                placeholder="通院、予定など"
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
            </div>

            {/* Submit */}
            <button
              onClick={submitLeaveRequest}
              disabled={leaveSubmitting || !leaveDateFrom}
              className="w-full bg-green-500 hover:bg-green-600 active:bg-green-700 text-white rounded-xl py-3 font-bold text-base transition disabled:opacity-50 active:scale-95"
            >
              {leaveSubmitting ? '送信中...' : '有給を申請する / Gửi đơn nghỉ phép'}
            </button>

            {/* Request history */}
            {leaveRequests.length > 0 && (
              <div className="mt-6">
                <div className="text-sm text-gray-500 font-bold mb-2">
                  申請の状況 / Trạng thái đơn
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
                            ✅ 承認済 / Đã duyệt
                          </span>
                        )}
                        {req.status === 'foreman_approved' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                            🔵 職長済 / Đốc công đã duyệt
                          </span>
                        )}
                        {req.status === 'pending' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                            ⏳ 承認待ち / Đang chờ
                          </span>
                        )}
                        {req.status === 'rejected' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold" title={req.rejectedReason || ''}>
                            ❌ 却下 / Từ chối
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
              閉じる / Đóng
            </button>
          </div>
        </div>
      )}

      {/* Home Long Leave Modal */}
      {showHomeLongLeaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setShowHomeLongLeaveModal(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-4 text-center">
              帰国申請 / Xin về nước
            </h3>

            {hlSuccess && (
              <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold mb-3 animate-pulse">
                {hlSuccess}
              </div>
            )}
            {hlError && (
              <div className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm mb-3">
                {hlError}
              </div>
            )}

            {/* Date range picker */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 font-bold block mb-2">
                期間を選んでください / Chọn thời gian
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">出発日 / Ngày đi</label>
                  <select
                    value={hlStartDate}
                    onChange={e => {
                      const val = e.target.value
                      setHlError(null)
                      setHlStartDate(val)
                      if (!hlEndDate || val >= hlEndDate) {
                        const d = new Date(val + 'T00:00:00')
                        d.setDate(d.getDate() + 14)
                        setHlEndDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
                      }
                    }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base bg-white"
                  >
                    {getHlDateOptions().map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">帰国日 / Ngày về</label>
                  <select
                    value={hlEndDate}
                    onChange={e => setHlEndDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base bg-white"
                  >
                    {hlStartDate && getHlDateOptions(hlStartDate).slice(1).map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                ※ 原則3ヶ月前までに申請してください / Nguyên tắc nộp đơn trước 3 tháng<br/>
                <span style={{ fontSize: 11, color: '#999' }}>（緊急の場合は会社に相談してください / Trường hợp khẩn cấp hãy liên hệ công ty）</span>
              </p>
            </div>

            {/* Reason radio buttons */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 font-bold block mb-2">
                理由 / Lý do
              </label>
              <div className="space-y-2">
                {[
                  { value: '一時帰国', label: '一時帰国', vi: 'Về nước tạm thời' },
                  { value: 'ビザ更新帰国', label: 'ビザ更新帰国', vi: 'Về nước gia hạn visa' },
                  { value: 'その他', label: 'その他', vi: 'Khác' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-3 cursor-pointer py-1.5 px-3 rounded-lg hover:bg-gray-50">
                    <input
                      type="radio"
                      name="hlReason"
                      value={opt.value}
                      checked={hlReason === opt.value}
                      onChange={e => setHlReason(e.target.value)}
                      className="w-5 h-5 text-purple-600"
                    />
                    <span className="text-sm text-gray-700">{opt.label} / {opt.vi}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Note */}
            <div className="mb-4">
              <label className="text-sm text-gray-600 block mb-1">
                備考（任意）/ Ghi chú (tùy chọn)
              </label>
              <input
                type="text"
                value={hlNote}
                onChange={e => setHlNote(e.target.value)}
                placeholder="飛行機の予定など"
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
            </div>

            {/* Submit */}
            <button
              onClick={submitHomeLongLeave}
              disabled={hlSubmitting || !hlStartDate || !hlEndDate || hlStartDate < getHlMinDate()}
              className="w-full bg-purple-500 hover:bg-purple-600 active:bg-purple-700 text-white rounded-xl py-3 font-bold text-base transition disabled:opacity-50 active:scale-95"
            >
              {hlSubmitting ? '送信中...' : '帰国を申請する / Gửi đơn xin về nước'}
            </button>

            {/* Request history */}
            {hlRequests.length > 0 && (
              <div className="mt-6">
                <div className="text-sm text-gray-500 font-bold mb-2">
                  申請の状況 / Trạng thái đơn
                </div>
                <div className="space-y-2">
                  {hlRequests.map(req => (
                    <div key={req.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50">
                      <div className="min-w-0">
                        <span className="text-sm text-gray-700 font-medium">
                          {(() => { const [,m,d] = req.startDate.split('-'); return `${parseInt(m)}/${parseInt(d)}` })()}
                          〜
                          {(() => { const [,m,d] = req.endDate.split('-'); return `${parseInt(m)}/${parseInt(d)}` })()}
                        </span>
                        <span className="text-xs text-gray-400 ml-2">{req.reason}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {req.status === 'approved' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-bold">
                            承認済 / Đã duyệt
                          </span>
                        )}
                        {req.status === 'foreman_approved' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                            職長済 / Đốc công đã duyệt
                          </span>
                        )}
                        {req.status === 'pending' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                            承認待ち / Đang chờ
                          </span>
                        )}
                        {req.status === 'rejected' && (
                          <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold">
                            却下 / Từ chối
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setShowHomeLongLeaveModal(false)}
              className="w-full mt-4 bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
            >
              閉じる / Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { AttendanceEntry, AttendanceStatus } from '@/types'

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
    } catch {
      setError('つうしん エラー')
    } finally {
      setLoading(false)
    }
  }, [token, siteId])

  useEffect(() => { fetchData() }, [fetchData])

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

  const handleChoice = (choice: string) => {
    if (choice === 'work') {
      submitEntry('work', showOT ? otHours : 0)
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
            </div>
          </div>
        ) : (
          <>
            {/* 4 Buttons */}
            <div className="grid grid-cols-3 gap-3">
              {([
                { choice: 'work', emoji: '🔨', label: 'しゅっきん', color: 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' },
                { choice: 'rest', emoji: '🏠', label: 'やすみ', color: 'bg-gray-400 hover:bg-gray-500 active:bg-gray-600' },
                { choice: 'leave', emoji: '🌴', label: 'ゆうきゅう', color: 'bg-green-500 hover:bg-green-600 active:bg-green-700' },
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
                    <div className="text-base font-bold">{btn.label}</div>
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

        {/* Past 3 days */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-sm text-gray-500 mb-3 font-bold">さいきん</div>
          <div className="space-y-2">
            {data.pastDays.map((pd, i) => (
              <div
                key={i}
                className={`flex items-center justify-between py-2 px-3 rounded-lg ${
                  pd.locked ? 'bg-gray-50' : 'hover:bg-gray-50 cursor-pointer active:bg-gray-100'
                }`}
                onClick={() => !pd.locked && setEditingPast(i)}
              >
                <span className="text-sm text-gray-600">{pd.date}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full font-bold ${STATUS_COLORS[pd.status]}`}>
                    {STATUS_EMOJI[pd.status]} {STATUS_LABELS[pd.status]}
                    {pd.status === 'overtime' && pd.entry?.o ? ` +${pd.entry.o}h` : ''}
                  </span>
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
      {editingPast !== null && data.pastDays[editingPast] && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setEditingPast(null)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center">
              {data.pastDays[editingPast].date}
            </h3>
            <p className="text-sm text-gray-500 mb-4 text-center">なおす</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { choice: 'work', emoji: '🔨', label: 'しゅっきん', color: 'bg-blue-500' },
                { choice: 'rest', emoji: '🏠', label: 'やすみ', color: 'bg-gray-400' },
                { choice: 'leave', emoji: '🌴', label: 'ゆうきゅう', color: 'bg-green-500' },
                { choice: 'site_off', emoji: '🚧', label: 'げんばやすみ', color: 'bg-yellow-500' },
              ] as const).map(btn => (
                <button
                  key={btn.choice}
                  onClick={() => {
                    const pd = data.pastDays[editingPast!]
                    submitEntry(btn.choice, 0, pd.year, pd.month, pd.day)
                  }}
                  className={`${btn.color} text-white rounded-xl py-4 text-center active:scale-95`}
                >
                  <div className="text-2xl mb-1">{btn.emoji}</div>
                  <div className="text-sm font-bold">{btn.label}</div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setEditingPast(null)}
              className="w-full mt-3 bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
            >
              やめる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

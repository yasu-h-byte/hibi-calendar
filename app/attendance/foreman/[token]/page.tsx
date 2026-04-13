'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { AttendanceEntry, AttendanceStatus } from '@/types'

interface ForemanData {
  foreman: { id: number; name: string }
  site: { id: string; name: string }
  date: { year: number; month: number; day: number; ym: string; dateLabel: string; dateISO: string }
  workers: { id: number; name: string; entry: AttendanceEntry | null; status: AttendanceStatus }[]
  summary: { workCount: number; noneCount: number; totalCount: number }
  approved: boolean
  pastDays: { date: string; dateISO: string; approved: boolean }[]
}

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  work: '出勤', overtime: '残業あり', rest: '休み',
  leave: '有給', site_off: '現場休み', none: '未入力',
}
const STATUS_EMOJI: Record<AttendanceStatus, string> = {
  work: '🔨', overtime: '⏰', rest: '🏠', leave: '🌴', site_off: '🚧', none: '❓',
}
const STATUS_COLORS: Record<AttendanceStatus, string> = {
  work: 'bg-blue-100 text-blue-700', overtime: 'bg-orange-100 text-orange-700',
  rest: 'bg-gray-200 text-gray-600', leave: 'bg-green-100 text-green-700',
  site_off: 'bg-yellow-100 text-yellow-700', none: 'bg-red-50 text-red-400',
}

export default function ForemanAttendancePage() {
  const params = useParams()
  const token = params.token as string

  const [data, setData] = useState<ForemanData | null>(null)
  const [dateISO, setDateISO] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingWorker, setEditingWorker] = useState<{ id: number; name: string } | null>(null)
  const [editOT, setEditOT] = useState(0)
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const url = dateISO
        ? `/api/attendance/foreman?token=${token}&date=${dateISO}`
        : `/api/attendance/foreman?token=${token}`
      const res = await fetch(url)
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'エラー')
        return
      }
      const d: ForemanData = await res.json()
      setData(d)
      if (!dateISO) setDateISO(d.date.dateISO)
    } catch {
      setError('通信エラー')
    } finally {
      setLoading(false)
    }
  }, [token, dateISO])

  useEffect(() => { fetchData() }, [fetchData])

  const navDay = (delta: number) => {
    if (!data) return
    const current = new Date(data.date.dateISO + 'T00:00:00')
    current.setDate(current.getDate() + delta)
    const today = new Date()
    if (current > today) return
    const iso = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`
    setDateISO(iso)
  }

  const isToday = data ? data.date.dateISO === (() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })() : false

  const handleApprove = async () => {
    if (!data || saving) return
    setSaving(true)
    try {
      await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'approve',
          year: data.date.year,
          month: data.date.month,
          day: data.date.day,
        }),
      })
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = async (choice: string) => {
    if (!data || !editingWorker || saving) return
    setSaving(true)
    try {
      await fetch('/api/attendance/foreman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'edit',
          workerId: editingWorker.id,
          year: data.date.year,
          month: data.date.month,
          day: data.date.day,
          choice,
          overtimeHours: choice === 'work' ? editOT : 0,
        }),
      })
      setEditingWorker(null)
      setEditOT(0)
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-hibi-navy text-lg">読み込み中...</div>
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-sm opacity-70">職長</div>
          <div className="text-lg sm:text-xl font-bold truncate">{data.foreman.name}</div>
          <div className="text-sm opacity-80 mt-1 truncate">{data.site.name}</div>
        </div>
      </div>

      {/* Date nav */}
      <div className="bg-white border-b px-3 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <button
            onClick={() => navDay(-1)}
            className="px-3 py-2 bg-gray-100 rounded-lg text-sm font-bold active:bg-gray-200 shrink-0"
          >
            ◀ 前日
          </button>
          <div className="text-center min-w-0">
            <div className="text-sm sm:text-base font-bold text-hibi-navy truncate">{data.date.dateLabel}</div>
          </div>
          <button
            onClick={() => navDay(1)}
            disabled={isToday}
            className="px-3 py-2 bg-gray-100 rounded-lg text-sm font-bold active:bg-gray-200 disabled:opacity-30 shrink-0"
          >
            翌日 ▶
          </button>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-blue-50 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-blue-600">{data.summary.workCount}</div>
            <div className="text-xs text-blue-500">出勤</div>
          </div>
          <div className="bg-red-50 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-red-400">{data.summary.noneCount}</div>
            <div className="text-xs text-red-400">未入力</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-gray-600">{data.summary.totalCount}</div>
            <div className="text-xs text-gray-500">全員</div>
          </div>
        </div>

        {/* Approve button */}
        <button
          onClick={handleApprove}
          disabled={data.approved || saving}
          className={`w-full rounded-xl py-4 text-base font-bold transition ${
            data.approved
              ? 'bg-green-100 text-green-700 border-2 border-green-300'
              : 'bg-hibi-navy text-white active:bg-hibi-light'
          } disabled:opacity-70`}
        >
          {data.approved ? '✅ 確認済み' : '✅ この日を確認する'}
        </button>

        {/* Worker list */}
        <div className="bg-white rounded-xl shadow overflow-hidden">
          {data.workers.length === 0 ? (
            <div className="p-4 text-center text-gray-400">スタッフがいません</div>
          ) : (
            data.workers.map(w => (
              <div
                key={w.id}
                className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 last:border-0 active:bg-gray-50 cursor-pointer"
                onClick={() => { setEditingWorker({ id: w.id, name: w.name }); setEditOT(w.entry?.o || 0) }}
              >
                <span className="text-sm font-medium text-gray-800 truncate min-w-0">{w.name}</span>
                <span className={`text-xs px-2 py-1 rounded-full font-bold whitespace-nowrap shrink-0 ${STATUS_COLORS[w.status]}`}>
                  {STATUS_EMOJI[w.status]} {STATUS_LABELS[w.status]}
                  {w.status === 'overtime' && w.entry?.o ? ` +${w.entry.o}h` : ''}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Past days */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-sm text-gray-500 mb-2 font-bold">過去の確認状況</div>
          {data.pastDays.map((pd, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 py-2 cursor-pointer"
              onClick={() => setDateISO(pd.dateISO)}
            >
              <span className="text-sm text-gray-600 truncate min-w-0">{pd.date}</span>
              <span className={`text-xs px-2 py-1 rounded-full font-bold whitespace-nowrap shrink-0 ${
                pd.approved ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {pd.approved ? '✅ 確認済み' : '— 未確認'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Edit worker modal */}
      {editingWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setEditingWorker(null)}>
          <div className="bg-white rounded-t-2xl w-full max-w-lg px-4 sm:px-6 pt-5 pb-[env(safe-area-inset-bottom,8px)]" onClick={e => e.stopPropagation()} style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
            <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center truncate">{editingWorker.name}</h3>
            <p className="text-sm text-gray-500 mb-4 text-center">{data.date.dateLabel}</p>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
              {([
                { choice: 'work', emoji: '🔨', label: '出勤', color: 'bg-blue-500' },
                { choice: 'rest', emoji: '🏠', label: '休み', color: 'bg-gray-400' },
                { choice: 'leave', emoji: '🌴', label: '有給', color: 'bg-green-500' },
                // site_off（現場休み）は変形労働時間制導入により非表示
              ] as const).map(btn => (
                <button
                  key={btn.choice}
                  onClick={() => handleEdit(btn.choice)}
                  disabled={saving}
                  className={`${btn.color} text-white rounded-xl py-3 sm:py-4 text-center active:scale-95 disabled:opacity-50`}
                >
                  <div className="text-xl sm:text-2xl mb-1">{btn.emoji}</div>
                  <div className="text-xs sm:text-sm font-bold">{btn.label}</div>
                </button>
              ))}
            </div>

            {/* OT input for work */}
            <div className="bg-gray-50 rounded-xl p-3 mb-4">
              <div className="text-xs text-gray-500 text-center mb-2">残業時間（出勤の場合）</div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setEditOT(Math.max(0, editOT - 0.5))}
                  className="w-10 h-10 bg-gray-200 rounded-lg text-lg font-bold"
                >−</button>
                <span className="text-lg font-bold w-14 text-center text-orange-600">
                  {editOT.toFixed(1)}h
                </span>
                <button
                  onClick={() => setEditOT(Math.min(8, editOT + 0.5))}
                  className="w-10 h-10 bg-gray-200 rounded-lg text-lg font-bold"
                >＋</button>
              </div>
            </div>

            <button
              onClick={() => setEditingWorker(null)}
              className="w-full bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

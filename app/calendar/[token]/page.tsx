'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { generateCalendar, getNextMonth, CALENDAR_PATTERNS } from '@/lib/calendar'
import { CalendarDay } from '@/types'

interface WorkerInfo {
  id: number
  name: string
  nameVi?: string
}

export default function CalendarSignPage() {
  const params = useParams()
  const token = params.token as string
  const { year, month, ym } = getNextMonth()

  const [worker, setWorker] = useState<WorkerInfo | null>(null)
  const [patternId, setPatternId] = useState<string | null>(null)
  const [signed, setSigned] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState<CalendarDay[]>([])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/calendar/worker-status?token=${token}&ym=${ym}`)
      if (!res.ok) {
        if (res.status === 401) {
          setError('無効なトークンです / Token không hợp lệ')
        } else {
          setError('データの取得に失敗しました / Không thể tải dữ liệu')
        }
        return
      }
      const data = await res.json()
      setWorker(data.worker)
      if (data.assignment) {
        setPatternId(data.assignment.patternId)
        const pattern = CALENDAR_PATTERNS.find(p => p.id === data.assignment.patternId)
        if (pattern) {
          setDays(generateCalendar(year, month, pattern))
        }
      }
      if (data.signature) {
        setSigned(data.signature.signedAt)
      }
    } catch {
      setError('通信エラー / Lỗi kết nối')
    } finally {
      setLoading(false)
    }
  }, [token, ym, year, month])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleSign = async () => {
    if (!worker || signing) return
    setSigning(true)
    try {
      const res = await fetch('/api/calendar/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: worker.id, ym, token }),
      })
      if (res.ok) {
        setSigned(new Date().toISOString())
      } else {
        const data = await res.json()
        if (res.status === 409) {
          setSigned(data.signedAt)
        } else {
          setError(data.error || 'Failed to sign')
        }
      }
    } catch {
      setError('通信エラー / Lỗi kết nối')
    } finally {
      setSigning(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-hibi-navy text-lg">読み込み中... / Đang tải...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-xl shadow p-6 text-center max-w-sm w-full">
          <div className="text-red-500 text-lg font-bold mb-2">エラー / Lỗi</div>
          <div className="text-gray-700">{error}</div>
        </div>
      </div>
    )
  }

  if (!worker || !patternId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-xl shadow p-6 text-center max-w-sm w-full">
          <div className="text-hibi-navy text-lg font-bold mb-2">
            カレンダー未割当 / Chưa phân lịch
          </div>
          <div className="text-gray-600 text-base">
            {year}年{month}月のカレンダーはまだ割り当てられていません。
            <br />
            Lịch tháng {month}/{year} chưa được phân công.
          </div>
        </div>
      </div>
    )
  }

  const pattern = CALENDAR_PATTERNS.find(p => p.id === patternId)
  const monthLabel = `${year}年${month}月`
  const monthLabelVi = `Tháng ${month}/${year}`

  // Build calendar grid
  const firstDow = new Date(year, month - 1, 1).getDay()
  const gridCells: (CalendarDay | null)[] = []
  for (let i = 0; i < firstDow; i++) gridCells.push(null)
  for (const day of days) gridCells.push(day)

  const dayHeaders = [
    { ja: '日', vi: 'CN' },
    { ja: '月', vi: 'T2' },
    { ja: '火', vi: 'T3' },
    { ja: '水', vi: 'T4' },
    { ja: '木', vi: 'T5' },
    { ja: '金', vi: 'T6' },
    { ja: '土', vi: 'T7' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold">HIBI CONSTRUCTION</h1>
          <p className="text-sm opacity-80">就業カレンダー / Lịch làm việc</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Worker info */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-hibi-navy font-bold text-lg">{worker.name}</div>
          {worker.nameVi && <div className="text-gray-500 text-sm">{worker.nameVi}</div>}
          <div className="mt-1 text-sm text-gray-600">
            {monthLabel} / {monthLabelVi}
          </div>
          <div className="mt-1 text-xs text-gray-400">
            {pattern?.name} / {pattern?.nameVi}
          </div>
        </div>

        {/* Working hours */}
        <div className="bg-blue-50 rounded-xl p-4 text-sm">
          <div className="font-bold text-hibi-navy mb-1">就業時間 / Giờ làm việc</div>
          <div>8:00〜16:30（休憩2時間）</div>
          <div className="text-gray-600">8:00〜16:30（nghỉ 2 tiếng）</div>
        </div>

        {/* Calendar */}
        <div className="bg-white rounded-xl shadow p-4">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {dayHeaders.map((h, i) => (
              <div
                key={i}
                className={`text-center text-xs font-bold py-1 ${
                  i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-600'
                }`}
              >
                <div>{h.ja}</div>
                <div className="text-[10px] opacity-70">{h.vi}</div>
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-1">
            {gridCells.map((cell, i) => {
              if (!cell) {
                return <div key={i} className="aspect-square" />
              }
              const d = cell.date.getDate()
              let bg = 'bg-blue-100 text-blue-800' // work
              if (cell.dayType === 'off') bg = 'bg-gray-100 text-gray-500'
              if (cell.dayType === 'holiday') bg = 'bg-red-100 text-red-600'

              return (
                <div
                  key={i}
                  className={`aspect-square rounded-lg flex flex-col items-center justify-center ${bg} text-xs relative`}
                >
                  <div className="font-bold text-sm">{d}</div>
                  {cell.dayType === 'holiday' ? (
                    <div className="text-[8px] leading-tight text-center truncate w-full px-0.5">
                      {cell.holidayName}
                    </div>
                  ) : (
                    <div className="text-[9px]">{cell.labelVi}</div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Legend */}
          <div className="mt-3 flex gap-4 justify-center text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-blue-100" />
              <span>出勤 / Đi làm</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-gray-100" />
              <span>休み / Nghỉ</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-red-100" />
              <span>祝日 / Nghỉ lễ</span>
            </div>
          </div>
        </div>

        {/* Sign button */}
        {signed ? (
          <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 text-center">
            <div className="text-green-700 font-bold text-lg mb-1">
              署名済み / Đã ký xác nhận
            </div>
            <div className="text-green-600 text-sm">
              {new Date(signed).toLocaleString('ja-JP')}
            </div>
          </div>
        ) : (
          <button
            onClick={handleSign}
            disabled={signing}
            className="w-full bg-hibi-navy text-white rounded-xl py-4 text-base font-bold active:bg-hibi-light disabled:opacity-50 min-h-[56px]"
          >
            {signing ? (
              '処理中... / Đang xử lý...'
            ) : (
              <>
                内容を確認しました
                <br />
                <span className="text-sm font-normal opacity-90">Tôi đã xác nhận nội dung</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

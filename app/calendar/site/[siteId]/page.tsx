'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { buildCalendarDays, getNextMonth } from '@/lib/calendar'
import { CalendarDay, DayType } from '@/types'

interface WorkerInfo {
  id: number
  name: string
  nameVi?: string
  signed: boolean
  signedAt: string | null
}

export default function SiteCalendarPage() {
  const params = useParams()
  const siteId = params.siteId as string
  const { year, month, ym } = getNextMonth()

  const [siteName, setSiteName] = useState('')
  const [days, setDays] = useState<CalendarDay[]>([])
  const [workers, setWorkers] = useState<WorkerInfo[]>([])
  const [selectedWorker, setSelectedWorker] = useState<WorkerInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/calendar/site-detail?siteId=${siteId}&ym=${ym}`)
      if (!res.ok) {
        setError('カレンダーは準備中です / Lịch đang được chuẩn bị')
        return
      }
      const data = await res.json()
      setSiteName(data.site.name)
      setDays(buildCalendarDays(year, month, data.days as Record<string, DayType>))
      setWorkers(data.workers)
    } catch {
      setError('通信エラー / Lỗi kết nối')
    } finally {
      setLoading(false)
    }
  }, [siteId, ym, year, month])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSign = async () => {
    if (!selectedWorker || signing) return
    setSigning(true)
    try {
      const res = await fetch('/api/calendar/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: selectedWorker.id, ym, siteId }),
      })
      if (res.ok) {
        setWorkers(prev => prev.map(w =>
          w.id === selectedWorker.id ? { ...w, signed: true, signedAt: new Date().toISOString() } : w
        ))
        setSelectedWorker(prev => prev ? { ...prev, signed: true, signedAt: new Date().toISOString() } : null)
      } else {
        const data = await res.json()
        if (res.status === 409) {
          setWorkers(prev => prev.map(w =>
            w.id === selectedWorker.id ? { ...w, signed: true, signedAt: data.signedAt } : w
          ))
          setSelectedWorker(prev => prev ? { ...prev, signed: true, signedAt: data.signedAt } : null)
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
        <div className="text-hibi-navy">読み込み中... / Đang tải...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-hibi-navy text-white px-4 py-4">
          <div className="max-w-lg mx-auto"><h1 className="text-lg font-bold">HIBI CONSTRUCTION</h1></div>
        </div>
        <div className="max-w-lg mx-auto p-4 text-center mt-8">
          <div className="text-gray-500 text-lg">{error}</div>
          <Link href="/calendar/public" className="text-hibi-navy underline mt-4 inline-block text-sm">← 現場一覧に戻る / Quay lại</Link>
        </div>
      </div>
    )
  }

  const firstDow = days.length > 0 ? days[0].date.getDay() : 0
  const gridCells: (CalendarDay | null)[] = []
  for (let i = 0; i < firstDow; i++) gridCells.push(null)
  for (const day of days) gridCells.push(day)

  const dayHeaders = [
    { ja: '日', vi: 'CN' }, { ja: '月', vi: 'T2' }, { ja: '火', vi: 'T3' },
    { ja: '水', vi: 'T4' }, { ja: '木', vi: 'T5' }, { ja: '金', vi: 'T6' }, { ja: '土', vi: 'T7' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <Link href="/calendar/public" className="text-white/60 text-sm hover:text-white">← 戻る / Quay lại</Link>
          <h1 className="text-lg font-bold mt-1">HIBI CONSTRUCTION</h1>
          <p className="text-sm opacity-80">就業カレンダー / Lịch làm việc</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-hibi-navy font-bold text-lg">{siteName}</h2>
          <p className="text-sm text-gray-500 mt-1">{year}年{month}月 / Tháng {month}/{year}</p>
        </div>

        {/* Worker selection */}
        {!selectedWorker ? (
          <div className="bg-white rounded-xl shadow p-4">
            <p className="text-sm text-gray-600 mb-3 text-center">名前を選んでください / Chọn tên của bạn</p>
            <div className="grid grid-cols-2 gap-2">
              {workers.map(w => (
                <button
                  key={w.id}
                  onClick={() => setSelectedWorker(w)}
                  className={`rounded-lg px-3 py-3 text-sm font-medium transition ${
                    w.signed
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-gray-50 text-hibi-navy border border-gray-200 hover:bg-hibi-navy hover:text-white'
                  }`}
                >
                  {w.name}{w.signed && <span className="text-xs ml-1">✓</span>}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-xl shadow p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-hibi-navy font-bold text-lg">{selectedWorker.name}</div>
                  {selectedWorker.nameVi && <div className="text-gray-500 text-sm">{selectedWorker.nameVi}</div>}
                </div>
                <button onClick={() => setSelectedWorker(null)} className="text-sm text-gray-400 hover:text-gray-600">変更 / Đổi</button>
              </div>
            </div>

            <div className="bg-blue-50 rounded-xl p-4 text-sm">
              <div className="font-bold text-hibi-navy mb-1">就業時間 / Giờ làm việc</div>
              <div>8:00〜17:00（休憩2時間）/ 8:00〜17:00（nghỉ 2 tiếng）</div>
            </div>

            <div className="bg-white rounded-xl shadow p-4">
              <div className="grid grid-cols-7 gap-1 mb-2">
                {dayHeaders.map((h, i) => (
                  <div key={i} className={`text-center text-xs font-bold py-1 ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-600'}`}>
                    <div>{h.ja}</div><div className="text-[10px] opacity-70">{h.vi}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {gridCells.map((cell, i) => {
                  if (!cell) return <div key={i} className="aspect-square" />
                  // シンプルに「出勤」か「休み」の2択（祝日も休みとして表示）
                  const isWork = cell.dayType === 'work'
                  const bg = isWork ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-400'
                  return (
                    <div key={i} className={`aspect-square rounded-lg flex flex-col items-center justify-center ${bg} text-xs`}>
                      <div className="font-bold text-sm">{cell.day}</div>
                      <div className="text-[9px]">{isWork ? '出勤' : '休み'}</div>
                      {cell.dayType === 'holiday' && cell.holidayName && (
                        <div className={`text-[7px] leading-tight text-center truncate w-full px-0.5 ${isWork ? 'text-white/70' : 'text-gray-400'}`}>{cell.holidayName}</div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 flex gap-4 justify-center text-xs">
                <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-blue-500" /><span>出勤 / Đi làm</span></div>
                <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-gray-200 border border-gray-300" /><span>休み / Nghỉ</span></div>
              </div>
            </div>

            {selectedWorker.signed ? (
              <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 text-center">
                <div className="text-green-700 font-bold text-lg mb-1">署名済み / Đã ký xác nhận</div>
                {selectedWorker.signedAt && <div className="text-green-600 text-sm">{new Date(selectedWorker.signedAt).toLocaleString('ja-JP')}</div>}
              </div>
            ) : (
              <button
                onClick={handleSign}
                disabled={signing}
                className="w-full bg-hibi-navy text-white rounded-xl py-4 text-base font-bold active:bg-hibi-light disabled:opacity-50 min-h-[56px]"
              >
                {signing ? '処理中... / Đang xử lý...' : (<>内容を確認しました<br /><span className="text-sm font-normal opacity-90">Tôi đã xác nhận nội dung</span></>)}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

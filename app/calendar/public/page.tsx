'use client'

import { useEffect, useState, useCallback } from 'react'
import { getNextMonth, buildCalendarDays } from '@/lib/calendar'
import { CalendarDay, DayType } from '@/types'

interface WorkerSiteStatus {
  siteId: string
  siteName: string
  signed: boolean
  signedAt: string | null
}

interface WorkerInfo {
  id: number
  name: string
  nameVi: string
  token: string
  sites: WorkerSiteStatus[]
  allSigned: boolean
  unsignedCount: number
}

interface SiteInfo {
  id: string
  name: string
  workerCount: number
  signedCount: number
  days: Record<string, DayType>
}

export default function PublicCalendarPage() {
  const { year, month, ym } = getNextMonth()
  const [workers, setWorkers] = useState<WorkerInfo[]>([])
  const [sites, setSites] = useState<SiteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWorker, setSelectedWorker] = useState<WorkerInfo | null>(null)
  const [signing, setSigning] = useState(false)
  const [signSuccess, setSignSuccess] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/calendar/public-sites?ym=${ym}`)
      const data = await res.json()
      setSites(data.sites || [])
      setWorkers(data.workers || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [ym])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSelectWorker = (worker: WorkerInfo) => {
    setSelectedWorker(worker)
    setSignSuccess(false)
  }

  const handleBulkSign = async () => {
    if (!selectedWorker || signing) return
    const unsignedSiteIds = selectedWorker.sites
      .filter(s => !s.signed)
      .map(s => s.siteId)
    if (unsignedSiteIds.length === 0) return

    setSigning(true)
    try {
      const res = await fetch('/api/calendar/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerId: selectedWorker.id,
          ym,
          siteIds: unsignedSiteIds,
        }),
      })
      if (res.ok) {
        setSignSuccess(true)
        // Update local state
        setSelectedWorker(prev => {
          if (!prev) return null
          return {
            ...prev,
            allSigned: true,
            unsignedCount: 0,
            sites: prev.sites.map(s => ({
              ...s,
              signed: true,
              signedAt: s.signedAt || new Date().toISOString(),
            })),
          }
        })
        setWorkers(prev => prev.map(w =>
          w.id === selectedWorker.id
            ? { ...w, allSigned: true, unsignedCount: 0, sites: w.sites.map(s => ({ ...s, signed: true, signedAt: s.signedAt || new Date().toISOString() })) }
            : w
        ))
      }
    } catch {
      // ignore
    } finally {
      setSigning(false)
    }
  }

  const dayHeaders = [
    { ja: '日', vi: 'CN' }, { ja: '月', vi: 'T2' }, { ja: '火', vi: 'T3' },
    { ja: '水', vi: 'T4' }, { ja: '木', vi: 'T5' }, { ja: '金', vi: 'T6' }, { ja: '土', vi: 'T7' },
  ]

  // Render a calendar grid for a site
  const renderCalendar = (site: SiteInfo) => {
    const days = buildCalendarDays(year, month, site.days)
    const firstDow = days.length > 0 ? days[0].date.getDay() : 0
    const gridCells: (CalendarDay | null)[] = []
    for (let i = 0; i < firstDow; i++) gridCells.push(null)
    for (const day of days) gridCells.push(day)

    return (
      <div className="bg-white rounded-xl shadow p-4">
        <h3 className="text-hibi-navy font-bold text-base mb-2">{site.name}</h3>
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
            let bg = 'bg-blue-100 text-blue-800'
            if (cell.dayType === 'off') bg = 'bg-gray-100 text-gray-500'
            if (cell.dayType === 'holiday') bg = 'bg-red-100 text-red-600'
            return (
              <div key={i} className={`aspect-square rounded-lg flex flex-col items-center justify-center ${bg} text-xs`}>
                <div className="font-bold text-sm">{cell.day}</div>
                {cell.dayType === 'holiday' ? (
                  <div className="text-[8px] leading-tight text-center truncate w-full px-0.5">{cell.holidayName}</div>
                ) : (
                  <div className="text-[9px]">{cell.labelVi}</div>
                )}
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex gap-4 justify-center text-xs">
          <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-blue-100" /><span>出勤 / Đi làm</span></div>
          <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-gray-100" /><span>休み / Nghỉ</span></div>
          <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-red-100" /><span>祝日 / Nghỉ lễ</span></div>
        </div>
      </div>
    )
  }

  // Get the sites this worker is assigned to (with calendar data)
  const getWorkerSites = (): SiteInfo[] => {
    if (!selectedWorker) return []
    const workerSiteIds = new Set(selectedWorker.sites.map(s => s.siteId))
    return sites.filter(s => workerSiteIds.has(s.id))
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-hibi-navy text-white px-4 py-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold">HIBI CONSTRUCTION</h1>
          <p className="text-sm opacity-80">就業カレンダー / Lịch làm việc</p>
          <p className="text-sm opacity-60 mt-1">{year}年{month}月 / Tháng {month}/{year}</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4">
        {loading ? (
          <div className="text-center py-8 text-gray-400">読み込み中... / Đang tải...</div>
        ) : workers.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-gray-400 text-lg mb-2">カレンダー準備中</div>
            <div className="text-gray-400 text-sm">Lịch đang được chuẩn bị</div>
          </div>
        ) : !selectedWorker ? (
          /* Step 1: Select worker */
          <div className="space-y-3">
            <p className="text-sm text-gray-600 mb-4 text-center">
              名前を選んでください / Chọn tên của bạn
            </p>
            <div className="grid grid-cols-2 gap-3">
              {workers.map(worker => (
                <button
                  key={worker.id}
                  onClick={() => handleSelectWorker(worker)}
                  className={`rounded-xl px-3 py-4 text-sm font-medium transition active:scale-[0.98] ${
                    worker.allSigned
                      ? 'bg-green-50 text-green-700 border-2 border-green-200'
                      : 'bg-white text-hibi-navy border-2 border-gray-200 hover:border-hibi-navy shadow'
                  }`}
                >
                  <div className="font-bold">{worker.name}</div>
                  {worker.nameVi && <div className="text-xs opacity-70 mt-0.5">{worker.nameVi}</div>}
                  {worker.allSigned ? (
                    <div className="text-xs mt-1 text-green-600">署名済み / Đã ký xác nhận</div>
                  ) : (
                    <div className="text-xs mt-1 text-orange-600">
                      未署名 {worker.unsignedCount}件 / Chưa ký {worker.unsignedCount}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Step 2: Show all calendars + bulk sign */
          <div className="space-y-4">
            {/* Worker info bar */}
            <div className="bg-white rounded-xl shadow p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-hibi-navy font-bold text-lg">{selectedWorker.name}</div>
                  {selectedWorker.nameVi && <div className="text-gray-500 text-sm">{selectedWorker.nameVi}</div>}
                </div>
                <button
                  onClick={() => { setSelectedWorker(null); setSignSuccess(false) }}
                  className="text-sm text-gray-400 hover:text-gray-600 px-3 py-1 rounded-lg bg-gray-100"
                >
                  変更 / Đổi
                </button>
              </div>
            </div>

            {/* Work hours info */}
            <div className="bg-blue-50 rounded-xl p-4 text-sm">
              <div className="font-bold text-hibi-navy mb-1">就業時間 / Giờ làm việc</div>
              <div>8:00〜17:00（休憩2時間）/ 8:00〜17:00（nghỉ 2 tiếng）</div>
            </div>

            {/* Per-site signature status */}
            <div className="bg-white rounded-xl shadow p-4">
              <div className="text-sm font-bold text-gray-600 mb-2">署名状況 / Trạng thái ký</div>
              <div className="space-y-2">
                {selectedWorker.sites.map(s => (
                  <div key={s.siteId} className="flex items-center justify-between py-1">
                    <span className="text-sm text-hibi-navy font-medium">{s.siteName}</span>
                    {s.signed ? (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-bold">
                        署名済み / Đã ký
                      </span>
                    ) : (
                      <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-bold">
                        未署名 / Chưa ký
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* All site calendars stacked */}
            {getWorkerSites().map(site => (
              <div key={site.id}>
                {renderCalendar(site)}
              </div>
            ))}

            {/* Bulk sign button or success */}
            {selectedWorker.allSigned || signSuccess ? (
              <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 text-center">
                <div className="text-green-700 font-bold text-lg mb-1">
                  全て署名済み / Đã ký xác nhận tất cả
                </div>
                <div className="text-green-600 text-sm">
                  {new Date().toLocaleString('ja-JP')}
                </div>
              </div>
            ) : (
              <button
                onClick={handleBulkSign}
                disabled={signing}
                className="w-full bg-hibi-navy text-white rounded-xl py-4 text-base font-bold active:bg-hibi-light disabled:opacity-50 min-h-[56px]"
              >
                {signing ? (
                  '処理中... / Đang xử lý...'
                ) : (
                  <>
                    全ての現場のカレンダーを確認しました
                    <br />
                    <span className="text-sm font-normal opacity-90">
                      Tôi đã xác nhận nội dung tất cả công trường
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

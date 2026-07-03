'use client'

import { useMemo, useState } from 'react'
import { getJPHolidays } from '@/lib/leave-utils'

// カレンダータブ: 年間PLカレンダー（有給取得日のマーカー表示 + ツールチップ）

interface Props {
  visible: boolean
  plCalendar: Record<string, number[]>
  workerNames: Record<number, string>
}

export default function CalendarTab({ visible, plCalendar, workerNames }: Props) {
  const [calendarTooltip, setCalendarTooltip] = useState<{ dateKey: string; x: number; y: number } | null>(null)

  // PLカレンダーは直近1年を表示
  const calendarYear = new Date().getFullYear()
  const calendarMonths = useMemo(() => {
    const months: { year: number; month: number; label: string }[] = []
    for (let m = 1; m <= 12; m++) months.push({ year: calendarYear, month: m, label: `${calendarYear}年${m}月` })
    return months
  }, [calendarYear])

  const holidays = useMemo(() => {
    const set = new Set<string>()
    getJPHolidays(calendarYear).forEach(h => set.add(h))
    return set
  }, [calendarYear])

  if (!visible) return null

  return (<>
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-4">
      <h2 className="text-base font-bold text-hibi-navy dark:text-white mb-3">PLカレンダー</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {calendarMonths.map(({ year, month, label }) => {
          const daysInMonth = new Date(year, month, 0).getDate()
          const firstDow = new Date(year, month - 1, 1).getDay() // 0=Sun
          const ym = `${year}${String(month).padStart(2, '0')}`

          return (
            <div key={ym} className="border border-gray-200 dark:border-gray-700 rounded-lg p-2">
              <div className="text-xs font-bold text-center text-gray-700 dark:text-gray-300 mb-1">{label}</div>
              {/* Day of week header */}
              <div className="grid grid-cols-7 gap-px text-center">
                {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (
                  <div key={d} className={`text-[9px] font-medium h-4 leading-4 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}`}>{d}</div>
                ))}
                {/* Empty cells before first day */}
                {Array.from({ length: firstDow }).map((_, i) => (
                  <div key={`e${i}`} className="h-6" />
                ))}
                {/* Day cells */}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1
                  const dateKey = `${ym}${String(day).padStart(2, '0')}`
                  const dow = new Date(year, month - 1, day).getDay()
                  const isHoliday = holidays.has(dateKey)
                  const plWorkers = plCalendar[dateKey] || []
                  const hasPL = plWorkers.length > 0

                  let bgClass = ''
                  if (hasPL) bgClass = 'bg-yellow-200'
                  else if (dow === 0 || isHoliday) bgClass = 'bg-red-50'
                  else if (dow === 6) bgClass = 'bg-blue-50'

                  const textClass = isHoliday ? 'text-red-500' : dow === 0 ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-gray-700'

                  return (
                    <div
                      key={day}
                      className={`h-6 w-full flex items-center justify-center relative cursor-default rounded-sm ${bgClass}`}
                      onMouseEnter={(e) => {
                        if (hasPL) {
                          const rect = e.currentTarget.getBoundingClientRect()
                          setCalendarTooltip({ dateKey, x: rect.left + rect.width / 2, y: rect.top })
                        }
                      }}
                      onMouseLeave={() => setCalendarTooltip(null)}
                      onClick={() => {
                        if (hasPL) {
                          setCalendarTooltip(prev =>
                            prev?.dateKey === dateKey ? null : { dateKey, x: 0, y: 0 }
                          )
                        }
                      }}
                    >
                      <span className={`text-[10px] leading-none ${textClass}`}>{day}</span>
                      {hasPL && (
                        <span className="absolute -top-0.5 -right-0.5 bg-orange-500 text-white text-[7px] rounded-full w-3 h-3 flex items-center justify-center font-bold leading-none">
                          {plWorkers.length}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>

    {/* Calendar tooltip */}
    {calendarTooltip && plCalendar[calendarTooltip.dateKey] && (
      <div
        className="fixed z-50 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none"
        style={{
          left: calendarTooltip.x > 0 ? `${calendarTooltip.x}px` : '50%',
          top: calendarTooltip.x > 0 ? `${calendarTooltip.y - 8}px` : '50%',
          transform: calendarTooltip.x > 0 ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)',
        }}
      >
        <div className="font-bold mb-1">
          {calendarTooltip.dateKey.replace(/(\d{4})(\d{2})(\d{2})/, '$1/$2/$3')} 有給取得
        </div>
        {plCalendar[calendarTooltip.dateKey].map(wid => (
          <div key={wid}>{workerNames[wid] || `ID:${wid}`}</div>
        ))}
      </div>
    )}
  </>)
}

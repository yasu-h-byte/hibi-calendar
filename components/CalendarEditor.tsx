'use client'

import { DayType } from '@/types'
import { getHoliday } from '@/lib/calendar'

interface Props {
  year: number
  month: number
  days: Record<string, DayType>
  onChange: (days: Record<string, DayType>) => void
  readOnly?: boolean
}

const DAY_HEADERS = [
  { ja: '日', vi: 'CN' },
  { ja: '月', vi: 'T2' },
  { ja: '火', vi: 'T3' },
  { ja: '水', vi: 'T4' },
  { ja: '木', vi: 'T5' },
  { ja: '金', vi: 'T6' },
  { ja: '土', vi: 'T7' },
]

export default function CalendarEditor({ year, month, days, onChange, readOnly }: Props) {
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDow = new Date(year, month - 1, 1).getDay()

  const toggleDay = (d: number) => {
    if (readOnly) return
    const key = String(d)
    const current = days[key] || 'work'
    const next: DayType = current === 'work' ? 'off' : 'work'
    onChange({ ...days, [key]: next })
  }

  // Build grid cells
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  // Count work/off days
  const workDays = Object.values(days).filter(v => v === 'work').length
  const offDays = Object.values(days).filter(v => v === 'off' || v === 'holiday').length

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-hibi-navy dark:text-blue-300">
          {year}年{month}月
        </h3>
        <div className="flex gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span>出勤 <strong className="text-blue-600 dark:text-blue-400">{workDays}</strong>日</span>
          <span>休み <strong className="text-gray-600 dark:text-gray-300">{offDays}</strong>日</span>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADERS.map((h, i) => (
          <div
            key={i}
            className={`text-center text-xs font-bold py-1 ${
              i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {h.ja}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="aspect-square" />

          const key = String(d)
          const dayType = days[key] || 'work'
          const holiday = getHoliday(year, month, d)
          const dow = new Date(year, month - 1, d).getDay()

          let bg = 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-700'
          if (dayType === 'off') bg = 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600'
          if (dayType === 'holiday') bg = 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300 border-red-200 dark:border-red-700'

          return (
            <button
              key={i}
              onClick={() => toggleDay(d)}
              disabled={readOnly}
              className={`aspect-square rounded-lg flex flex-col items-center justify-center text-xs border ${bg} ${
                readOnly ? 'cursor-default' : 'cursor-pointer hover:opacity-80 active:scale-95'
              } transition-all`}
            >
              <div className={`font-bold text-sm ${dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : ''}`}>
                {d}
              </div>
              {holiday ? (
                <div className="text-[8px] leading-tight truncate w-full px-0.5 text-center">
                  {holiday.name}
                </div>
              ) : (
                <div className="text-[9px]">
                  {dayType === 'work' ? '出勤' : '休み'}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex gap-4 justify-center text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-blue-100 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-700" />
          <span>出勤</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600" />
          <span>休み</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-700" />
          <span>祝日</span>
        </div>
        {!readOnly && (
          <span className="text-gray-400 dark:text-gray-500">※ タップで切替</span>
        )}
      </div>
    </div>
  )
}

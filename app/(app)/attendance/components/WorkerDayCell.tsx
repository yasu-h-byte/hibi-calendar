'use client'

import { calcActualHours } from '@/types'
import { getTimeStatusValue, getWorkValue } from '@/lib/attendance-grid'
import { AttEntry } from '../types'

// ワーカーの日別セル（2モード + 特殊表示）
//   TimeBasedCell … 外国人 + 202605〜: ステータス + 始業/終業 + 休憩チェック + 実時間
//   LegacyCell    … 日本人 or 〜202604 or 旧契約継続者: 出勤値ドロップダウン + 残業h入力
//   HomeLeaveCell … ✈帰国 表示
//   WaitingCell   … ベトナム人スタッフのスマホ入力待ち（admin/職長は触れない・2026-05-08）

/** 入力元インジケータ（スタッフ/職長入力の点）と休日出勤マーク */
function CellMarkers({ isHolidayWork, source }: { isHolidayWork: boolean; source?: string }) {
  return (
    <>
      {isHolidayWork && (
        <span className="absolute top-0 right-0.5 text-[8px] text-orange-500 font-bold leading-none" title="休日出勤">休出</span>
      )}
      {source === 'staff' && !isHolidayWork && (
        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400" title="スタッフ入力" />
      )}
      {source === 'foreman' && !isHolidayWork && (
        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-orange-400" title="職長入力" />
      )}
    </>
  )
}

/** 帰国中の特別表示セル */
export function HomeLeaveCell({ colBg, cellWidth }: { colBg: string; cellWidth: number }) {
  return (
    <td
      className={`px-0 py-0 border-l border-gray-100 ${colBg}`}
      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
    >
      <div className="flex items-center justify-center h-full py-2">
        <span className="text-[10px] font-bold text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded">✈帰国</span>
      </div>
    </td>
  )
}

/** ベトナム人スタッフのスマホ入力待ちセル */
export function WaitingCell({ colBg, cellWidth }: { colBg: string; cellWidth: number }) {
  return (
    <td
      className={`px-0 py-0 border-l border-gray-100 ${colBg}`}
      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
      title="スタッフ本人のスマホ入力待ち"
    >
      <div className="flex items-center justify-center h-full py-2 opacity-50">
        <span className="text-[10px] text-gray-400">📱待機中</span>
      </div>
    </td>
  )
}

// ── 時間ベースモード（外国人 + 202605〜）──

interface TimeBasedCellProps {
  entry: AttEntry | null
  wId: string
  day: number
  isLocked: boolean
  isHolidayWork: boolean
  colBg: string
  cellWidth: number
  startTimeOptions: string[]
  endTimeOptions: string[]
  onStatusChange: (workerId: string, day: number, value: string) => void
  onStartTimeChange: (workerId: string, day: number, st: string) => void
  onEndTimeChange: (workerId: string, day: number, et: string) => void
  onBreakChange: (workerId: string, day: number, breakKey: 'b1' | 'b2' | 'b3', checked: boolean) => void
  onCellKeyDown: (e: React.KeyboardEvent, day: number, workerId: string) => void
}

export function TimeBasedCell({
  entry, wId, day, isLocked, isHolidayWork, colBg, cellWidth,
  startTimeOptions, endTimeOptions,
  onStatusChange, onStartTimeChange, onEndTimeChange, onBreakChange, onCellKeyDown,
}: TimeBasedCellProps) {
  const statusVal = getTimeStatusValue(entry)
  const source = entry?.s

  const isWorking = statusVal === 'W'
  const st = entry?.st || '08:00'
  const et = entry?.et || '17:00'
  const b1 = entry?.b1 ?? 1
  const b3 = entry?.b3 ?? 1
  // 実時間計算
  const actualH = isWorking && entry?.st && entry?.et
    ? calcActualHours(entry)
    : 0

  return (
    <td
      className={`px-0 py-0 border-l border-gray-100 relative ${colBg}`}
      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
    >
      <CellMarkers isHolidayWork={isHolidayWork} source={source} />
      <div className="flex flex-col items-center">
        {/* ステータス選択 */}
        <select
          value={statusVal}
          onChange={e => onStatusChange(wId, day, e.target.value)}
          onKeyDown={e => onCellKeyDown(e, day, wId)}
          data-att-status="1"
          data-att-day={day}
          data-att-row={wId}
          disabled={isLocked}
          className={`w-full text-center text-xs font-bold py-0.5 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
            ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
            ${statusVal === 'W' ? 'text-green-700' : ''}
            ${statusVal === 'P' ? 'text-purple-600' : ''}
            ${statusVal === 'E' ? 'text-indigo-600' : ''}
            ${statusVal === 'R' ? 'text-red-500' : ''}
            ${statusVal === 'H' ? 'text-gray-500' : ''}
            ${statusVal === '' ? 'text-gray-300 font-normal' : ''}
          `}
        >
          <option value="">-</option>
          <option value="W">出</option>
          <option value="P">有</option>
          <option value="E">試</option>
          <option value="R">休</option>
          <option value="H">現</option>
        </select>

        {isWorking ? (
          <>
            {/* 始業・終業（時刻フル表示） */}
            <div className="flex items-center gap-0 w-full">
              <select
                value={st}
                onChange={e => onStartTimeChange(wId, day, e.target.value)}
                onKeyDown={e => onCellKeyDown(e, day, wId)}
                disabled={isLocked}
                className="w-1/2 text-center text-[11px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700 tabular-nums"
              >
                {startTimeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select
                value={et}
                onChange={e => onEndTimeChange(wId, day, e.target.value)}
                onKeyDown={e => onCellKeyDown(e, day, wId)}
                disabled={isLocked}
                className="w-1/2 text-center text-[11px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none text-gray-700 tabular-nums"
              >
                {endTimeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* 休憩チェック + 実時間 */}
            <div className="flex items-center justify-center gap-1 w-full px-0.5">
              <label className="flex items-center cursor-pointer" title="午前(10:00-10:30)">
                <input type="checkbox" checked={b1 === 1} onChange={e => onBreakChange(wId, day, 'b1', e.target.checked)} onKeyDown={e => onCellKeyDown(e, day, wId)} disabled={isLocked} className="w-3 h-3 rounded" />
              </label>
              <label className="flex items-center cursor-pointer" title="午後(15:00-15:30)">
                <input type="checkbox" checked={b3 === 1} onChange={e => onBreakChange(wId, day, 'b3', e.target.checked)} onKeyDown={e => onCellKeyDown(e, day, wId)} disabled={isLocked} className="w-3 h-3 rounded" />
              </label>
              <span className={`text-[10px] tabular-nums ml-auto font-bold ${actualH > 7 ? 'text-amber-600' : 'text-gray-500'}`}>
                {actualH.toFixed(1)}
              </span>
            </div>
          </>
        ) : statusVal !== '' ? (
          <div className="text-[11px] text-center py-0.5 font-medium text-gray-400">
            {statusVal === 'P' ? '有給' : statusVal === 'E' ? '試験' : statusVal === 'R' ? '休' : '現休'}
          </div>
        ) : null}
      </div>
    </td>
  )
}

// ── レガシーモード（日本人 or 〜202604 or 旧契約継続者） ──

interface LegacyCellProps {
  entry: AttEntry | null
  wId: string
  day: number
  isLocked: boolean
  isHolidayWork: boolean
  colBg: string
  cellWidth: number
  onWorkChange: (workerId: string, day: number, value: string) => void
  onOtChange: (workerId: string, day: number, otValue: string) => void
  onCellKeyDown: (e: React.KeyboardEvent, day: number, workerId: string) => void
}

export function LegacyCell({
  entry, wId, day, isLocked, isHolidayWork, colBg, cellWidth,
  onWorkChange, onOtChange, onCellKeyDown,
}: LegacyCellProps) {
  const workVal = getWorkValue(entry)
  const source = entry?.s
  const otVal = entry?.o || 0
  const canOt = entry && entry.w > 0 && entry.w !== 0.6

  return (
    <td
      className={`px-0 py-0 border-l border-gray-100 relative ${colBg}`}
      style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
    >
      <CellMarkers isHolidayWork={isHolidayWork} source={source} />
      <div className="flex flex-col">
        {/* Work dropdown - 大きめ */}
        <select
          value={workVal}
          onChange={e => onWorkChange(wId, day, e.target.value)}
          onKeyDown={e => onCellKeyDown(e, day, wId)}
          data-att-status="1"
          data-att-day={day}
          data-att-row={wId}
          disabled={isLocked}
          className={`w-full text-center text-sm font-bold py-1 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none cursor-pointer appearance-none
            ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
            ${workVal === '1' ? 'text-green-700' : ''}
            ${workVal === '0.5' ? 'text-yellow-700' : ''}
            ${workVal === '0.6' ? 'text-orange-600' : ''}
            ${workVal === 'P' ? 'text-purple-600' : ''}
            ${workVal === 'E' ? 'text-indigo-600' : ''}
            ${workVal === '' ? 'text-gray-300 font-normal' : ''}
          `}
        >
          <option value="">-</option>
          <option value="1">1</option>
          <option value="0.5">0.5</option>
          <option value="0.6">0.6補</option>
          <option value="P">有</option>
          <option value="E">試</option>
        </select>

        {/* OT input - 小さめ */}
        <input
          type="number"
          step="0.5"
          min="0"
          max="8"
          value={canOt && otVal > 0 ? otVal : ''}
          placeholder=""
          onChange={e => onOtChange(wId, day, e.target.value)}
          onKeyDown={e => onCellKeyDown(e, day, wId)}
          disabled={isLocked || !canOt}
          className={`w-full text-center text-[10px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
            ${!canOt || isLocked ? 'opacity-20 cursor-not-allowed' : 'text-amber-600'}
          `}
        />
      </div>
    </td>
  )
}

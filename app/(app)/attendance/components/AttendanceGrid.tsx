'use client'

import React from 'react'
import {
  dayColBg, dayHeaderBg, dayTextColor,
  getWorkValue, getTimeStatusValue, retirementBadge,
  FooterSums, WorkerTotals,
} from '@/lib/attendance-grid'
import { orgBadgeCls, orgBadgeLabel } from '@/lib/labels'
import { GridData, AttEntry, SubconDayEntry } from '../types'
import { TimeBasedCell, LegacyCell, HomeLeaveCell, WaitingCell } from './WorkerDayCell'

// 出面グリッド本体: ヘッダー行・職長行・職長承認行・最終承認行・ワーカー行・
// 外注行・フッター合計6行・凡例

interface Props {
  data: GridData
  days: { day: number; dow: number; label: string }[]
  cellWidth: number
  useTimeBased: boolean
  groupedWorkers: { org: string; label: string; workers: GridData['workers'] }[]
  workerEntries: Record<string, Record<number, AttEntry | null>>
  subconEntries: Record<string, Record<number, SubconDayEntry | null>>
  footerSums: FooterSums
  localApprovals: Record<number, boolean>
  localFinalApprovals: Record<number, boolean>
  canForemanApprove: boolean
  canFinalize: boolean
  startTimeOptions: string[]
  endTimeOptions: string[]
  workerTotals: (workerId: string) => WorkerTotals
  subconTotals: (subconId: string) => { nSum: number; onSum: number }
  onWorkChange: (workerId: string, day: number, value: string) => void
  onOtChange: (workerId: string, day: number, otValue: string) => void
  onTimeStatusChange: (workerId: string, day: number, value: string) => void
  onStartTimeChange: (workerId: string, day: number, st: string) => void
  onEndTimeChange: (workerId: string, day: number, et: string) => void
  onBreakChange: (workerId: string, day: number, breakKey: 'b1' | 'b2' | 'b3', checked: boolean) => void
  onSubconNChange: (subconId: string, day: number, value: string) => void
  onSubconOnChange: (subconId: string, day: number, value: string) => void
  onCellKeyDown: (e: React.KeyboardEvent, day: number, workerId: string) => void
  onForemanApproveAll: () => void
  onToggleForemanApproval: (day: number) => void
  onFinalApproveAll: () => void
  onToggleFinalApproval: (day: number) => void
}

export default function AttendanceGrid({
  data, days, cellWidth, useTimeBased, groupedWorkers,
  workerEntries, subconEntries, footerSums, localApprovals, localFinalApprovals,
  canForemanApprove, canFinalize, startTimeOptions, endTimeOptions, workerTotals, subconTotals,
  onWorkChange, onOtChange, onTimeStatusChange, onStartTimeChange, onEndTimeChange, onBreakChange,
  onSubconNChange, onSubconOnChange, onCellKeyDown,
  onForemanApproveAll, onToggleForemanApproval, onFinalApproveAll, onToggleFinalApproval,
}: Props) {
  const unapprovedDays = days.filter(d => !localApprovals[d.day])
  // 職長承認済かつ最終未承認の日だけが最終承認の対象
  const finalizableDays = days.filter(d => localApprovals[d.day] && !localFinalApprovals[d.day])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm overflow-hidden -mx-4 sm:mx-0 rounded-none sm:rounded-xl">
      <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
        <table className="text-xs border-collapse table-fixed" style={{ width: `${180 + days.length * 48 + 80}px` }}>
          <thead className="sticky top-0 z-30">
            {/* Day number row */}
            <tr className="border-b border-gray-200">
              <th
                className="sticky left-0 z-40 bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1.5 text-left font-bold whitespace-nowrap"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                名前
              </th>
              <th
                className="sticky left-[150px] z-40 bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1 py-1.5 text-center font-bold"
                style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
              >
                所属
              </th>
              {days.map(d => {
                const calDayType = data.calendarDays?.[String(d.day)]
                const isCalOff = calDayType === 'off' || calDayType === 'holiday'
                const isSunday = d.dow === 0
                // 平日の休みだけ文字色をグレーに（日曜・土曜は曜日色維持）
                const isWeekdayOff = isCalOff && d.dow !== 0 && d.dow !== 6
                // 「休」マーク: 日曜以外でカレンダー休日の場合（土曜含む）
                const showOffMark = isCalOff && !isSunday && data.calendarDays
                return (
                <th
                  key={d.day}
                  className={`px-0 py-1 text-center font-bold ${dayHeaderBg(data.year, data.month, d.day, calDayType)} ${isWeekdayOff ? 'text-gray-400' : dayTextColor(d.dow)} border-l border-gray-200`}
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                  title={isCalOff ? 'カレンダー休日' : data.calendarDays ? 'カレンダー出勤日' : ''}
                >
                  <div className="leading-tight">
                    <div className="text-[11px]">{d.day}</div>
                    <div className="text-[9px] opacity-70">{d.label}{showOffMark ? ' 休' : ''}</div>
                  </div>
                </th>
                )
              })}
              <th className="bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1.5 text-center font-bold border-l-2 border-gray-400" style={{ width: 80, minWidth: 80 }}>
                <div>計</div>
                <div className="text-[8px] opacity-70 font-normal">上:人工 / 下:残業h</div>
              </th>
            </tr>
          </thead>

          <tbody>
            {/* ── Foreman row (yellow) ── */}
            {data.site.foremanName && (
              <tr className="bg-yellow-50 border-b border-yellow-200">
                <td
                  className="sticky left-0 z-20 bg-yellow-50 px-2 py-1 font-bold text-yellow-800 whitespace-nowrap text-[11px]"
                  style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                >
                  職長: {data.site.foremanName}{data.site.foremanNote ? <span className="text-[9px] text-gray-500 ml-1">({data.site.foremanNote})</span> : ''}
                </td>
                <td className="sticky left-[150px] z-20 bg-yellow-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-yellow-200 text-yellow-800">職長</span>
                </td>
                {days.map(d => (
                  <td key={d.day} className={`px-0 py-1 border-l border-yellow-100 bg-yellow-50 text-center text-[10px] text-yellow-600`} style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}>
                    {/* placeholder: foreman presence can be derived from worker entries */}
                  </td>
                ))}
                <td className="px-1 py-1 text-center border-l-2 border-yellow-200 bg-yellow-50" style={{ width: 80, minWidth: 80 }}></td>
              </tr>
            )}

            {/* ── 職長承認 row（1次承認: 担当現場の職長のみ） ── */}
            <tr className="bg-orange-50 border-b border-orange-100">
              <td
                className="sticky left-0 z-20 bg-orange-50 px-2 py-1 font-bold text-orange-700 whitespace-nowrap text-[11px]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                {data.site.foremanName ? `${data.site.foremanName} 職長承認` : '職長承認'}
                {canForemanApprove && (unapprovedDays.length > 0 ? (
                  <button
                    onClick={onForemanApproveAll}
                    className="ml-2 text-[9px] bg-orange-500 text-white px-1.5 py-0.5 rounded hover:bg-orange-600 transition"
                  >
                    一括承認
                  </button>
                ) : (
                  <span className="ml-2 text-[9px] text-orange-600">全承認済</span>
                ))}
              </td>
              <td className="sticky left-[150px] z-20 bg-orange-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => {
                const approved = localApprovals[d.day]
                // 既に最終承認済みの場合は職長承認も解除できない（先に最終を外す必要）
                const finalApproved = localFinalApprovals[d.day]
                const cellLocked = approved && finalApproved
                const clickable = canForemanApprove && !cellLocked
                return (
                  <td
                    key={d.day}
                    className={`px-0 py-1 border-l border-orange-100 bg-orange-50 text-center ${clickable ? 'cursor-pointer hover:bg-orange-100' : ''}`}
                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    onClick={clickable ? () => onToggleForemanApproval(d.day) : undefined}
                    title={
                      cellLocked ? '最終承認済のため解除不可（先に最終承認を外す）'
                      : canForemanApprove ? (approved ? 'クリックで承認解除' : 'クリックで職長承認')
                      : '担当現場の職長のみ操作可'
                    }
                  >
                    {approved ? (
                      <span className="text-orange-600 text-[11px] font-bold">&#x2713;</span>
                    ) : (
                      <span className={`text-[11px] ${clickable ? 'text-orange-400' : 'text-orange-300'}`}>-</span>
                    )}
                  </td>
                )
              })}
              <td className="px-1 py-1 text-center border-l-2 border-orange-200 bg-orange-50" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* ── 最終承認 row（事業責任者・管理者: 職長承認後のみ操作可） ── */}
            <tr className="bg-indigo-50 border-b border-indigo-200">
              <td
                className="sticky left-0 z-20 bg-indigo-50 px-2 py-1 font-bold text-indigo-700 whitespace-nowrap text-[11px]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                最終承認
                {canFinalize && (finalizableDays.length > 0 ? (
                  <button
                    onClick={onFinalApproveAll}
                    className="ml-2 text-[9px] bg-indigo-600 text-white px-1.5 py-0.5 rounded hover:bg-indigo-700 transition"
                  >
                    一括最終承認
                  </button>
                ) : null)}
              </td>
              <td className="sticky left-[150px] z-20 bg-indigo-50 px-1 py-1 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => {
                const foremanApproved = localApprovals[d.day]
                const finalApproved = localFinalApprovals[d.day]
                // 職長承認なしには最終承認は付けられない
                const clickable = canFinalize && (finalApproved || foremanApproved)
                return (
                  <td
                    key={d.day}
                    className={`px-0 py-1 border-l border-indigo-100 bg-indigo-50 text-center ${clickable ? 'cursor-pointer hover:bg-indigo-100' : ''}`}
                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    onClick={clickable ? () => onToggleFinalApproval(d.day) : undefined}
                    title={
                      finalApproved ? 'クリックで最終承認解除'
                      : !canFinalize ? '管理者・事業責任者のみ操作可'
                      : !foremanApproved ? '職長承認後に押せます'
                      : 'クリックで最終承認'
                    }
                  >
                    {finalApproved ? (
                      <span className="text-indigo-700 text-[11px] font-bold">&#x2713;&#x2713;</span>
                    ) : foremanApproved && canFinalize ? (
                      <span className="text-[11px] text-indigo-400">-</span>
                    ) : (
                      <span className="text-[11px] text-indigo-200">·</span>
                    )}
                  </td>
                )
              })}
              <td className="px-1 py-1 text-center border-l-2 border-indigo-200 bg-indigo-50" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* ── Worker groups ── */}
            {groupedWorkers.map(group => (
              <React.Fragment key={`group-${group.org}`}>
                {/* Group header */}
                <tr className="bg-gray-50">
                  <td
                    className="sticky left-0 z-20 bg-gray-50 px-2 py-1 font-bold text-[11px] text-hibi-navy border-t-2 border-hibi-navy"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    {group.label} ({group.workers.length}名)
                  </td>
                  <td className="sticky left-[150px] z-20 bg-gray-50 border-t-2 border-hibi-navy" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
                  {days.map(d => <td key={d.day} className="border-t-2 border-hibi-navy bg-gray-50" />)}
                  <td className="border-t-2 border-hibi-navy bg-gray-50" />
                  <td className="border-t-2 border-hibi-navy bg-gray-50" />
                </tr>

                {group.workers.map(worker => {
                  const wId = String(worker.id)
                  const entries = workerEntries[wId] || {}
                  const totals = workerTotals(wId)
                  const isLocked = data.locked

                  return (
                    <tr key={worker.id} className="border-t-2 border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
                      {/* Worker name - sticky */}
                      <td
                        className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium text-gray-800 text-xs"
                        style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                      >
                        <div className="flex items-center gap-1 flex-wrap">
                          <span>{worker.name}</span>
                          {(() => {
                            const rb = retirementBadge(worker.retired)
                            if (!rb) return null
                            return (
                              <span
                                className={`text-[9px] px-1 py-0.5 rounded font-bold whitespace-nowrap ${rb.cls}`}
                                title={rb.title}
                              >
                                {rb.label}
                              </span>
                            )
                          })()}
                        </div>
                      </td>

                      {/* Org badge - sticky (colored by visa) */}
                      <td
                        className="sticky left-[150px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center"
                        style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                      >
                        <span className={`text-[10px] px-1 py-0.5 rounded-full font-medium whitespace-nowrap ${orgBadgeCls(worker.org, worker.visa)}`}>
                          {orgBadgeLabel(worker.org, worker.visa)}
                        </span>
                      </td>

                      {/* Day cells */}
                      {days.map(d => {
                        let entry = entries[d.day] || null
                        // 帰国判定: homeLeaves の期間に含まれるか（出面に hk がない場合も対応）
                        // ★ 明示的な他ステータス（有給P・欠勤R・現場休みH・試験Exam・出勤w>0）が
                        //   ある場合は帰国マーカーを上書きしない。
                        //   これにより「帰国期間中の有給事後計上」(p:1書き込み) が正しく
                        //   有給として表示される。
                        const hasExplicitStatus = entry && (
                          entry.p || entry.r || entry.h || entry.exam ||
                          (entry.w !== undefined && entry.w > 0)
                        )
                        if (!entry?.hk && !hasExplicitStatus && data.homeLeaves?.length) {
                          const dateStr = `${data.year}-${String(data.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
                          const isOnLeave = data.homeLeaves.some(hl =>
                            String(hl.workerId) === wId && hl.status === 'approved' && dateStr >= hl.startDate && dateStr <= hl.endDate
                          )
                          if (isOnLeave) {
                            entry = { ...(entry || { w: 0 }), hk: 1 }
                          }
                        }
                        // 休日出勤判定: カレンダーがoff/holidayなのに出勤あり
                        const calDay = data.calendarDays?.[String(d.day)]
                        const isHolidayWork = !!(calDay && (calDay === 'off' || calDay === 'holiday') && entry && entry.w > 0 && !entry.p && !entry.hk)
                        const colBg = dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])
                        // 外国人のみ時間ベース（202605〜かつvisaあり）
                        // 2026-06-13: 旧契約継続者(フン等)はレガシーUI（日数+残業+0.6補・待機中ガードなし）
                        const isWorkerTimeBased = useTimeBased && !!worker.visa && worker.visa !== 'none' && worker.visa !== '' && !worker.useOldRules

                        // ── 時間ベースモード（外国人 + 202605〜）──
                        if (isWorkerTimeBased) {
                          // 帰国中: 特別表示
                          if (getTimeStatusValue(entry) === 'HK') {
                            return <HomeLeaveCell key={d.day} colBg={colBg} cellWidth={cellWidth} />
                          }
                          // ベトナム人スタッフのスマホ入力待ち: admin/foreman は触れない (2026-05-08)
                          // entry が無い場合はスタッフ本人のスマホからの入力を待つ
                          if (!entry) {
                            return <WaitingCell key={d.day} colBg={colBg} cellWidth={cellWidth} />
                          }
                          return (
                            <TimeBasedCell
                              key={d.day}
                              entry={entry}
                              wId={wId}
                              day={d.day}
                              isLocked={isLocked}
                              isHolidayWork={isHolidayWork}
                              colBg={colBg}
                              cellWidth={cellWidth}
                              startTimeOptions={startTimeOptions}
                              endTimeOptions={endTimeOptions}
                              onStatusChange={onTimeStatusChange}
                              onStartTimeChange={onStartTimeChange}
                              onEndTimeChange={onEndTimeChange}
                              onBreakChange={onBreakChange}
                              onCellKeyDown={onCellKeyDown}
                            />
                          )
                        }

                        // ── レガシーモード（日本人 or 〜202604 or 旧契約継続者） ──
                        // 帰国中: 特別表示
                        if (getWorkValue(entry) === 'HK') {
                          return <HomeLeaveCell key={d.day} colBg={colBg} cellWidth={cellWidth} />
                        }
                        return (
                          <LegacyCell
                            key={d.day}
                            entry={entry}
                            wId={wId}
                            day={d.day}
                            isLocked={isLocked}
                            isHolidayWork={isHolidayWork}
                            colBg={colBg}
                            cellWidth={cellWidth}
                            onWorkChange={onWorkChange}
                            onOtChange={onOtChange}
                            onCellKeyDown={onCellKeyDown}
                          />
                        )
                      })}

                      {/* Totals - 人工計 + 残業 を 1 列に縦並び表示 (上: 人工, 下: 残業h) */}
                      <td className="px-2 py-1 text-center tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 80, minWidth: 80 }}>
                        <div className="font-bold text-sm text-hibi-navy">{totals.wSum > 0 ? totals.wSum : '-'}</div>
                        {(totals.compSum > 0 || totals.plSum > 0) && (
                          <div className="text-[9px] font-normal text-gray-400 leading-tight">
                            {[
                              totals.compSum > 0 ? `補${Math.round(totals.compSum * 10) / 10}` : '',
                              totals.plSum > 0 ? `有${totals.plSum}` : '',
                            ].filter(Boolean).join(' ')}
                          </div>
                        )}
                        <div className="font-bold text-sm text-amber-600 mt-0.5 border-t border-gray-200 pt-0.5">
                          {totals.oSum > 0 ? `${totals.oSum}h` : '-'}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </React.Fragment>
            ))}

            {/* ── Subcontractors ── */}
            {data.subcons.length > 0 && (
              <>
                <tr className="bg-amber-50">
                  <td
                    className="sticky left-0 z-20 bg-amber-50 px-2 py-1 font-bold text-[11px] text-amber-800 border-t-2 border-amber-400"
                    style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                  >
                    外注 ({data.subcons.length}社)
                  </td>
                  <td className="sticky left-[150px] z-20 bg-amber-50 border-t-2 border-amber-400" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
                  {days.map(d => <td key={d.day} className="border-t-2 border-amber-400 bg-amber-50" />)}
                  <td className="border-t-2 border-amber-400 bg-amber-50" />
                  <td className="border-t-2 border-amber-400 bg-amber-50" />
                </tr>

                {data.subcons.map(sc => {
                  const entries = subconEntries[sc.id] || {}
                  const totals = subconTotals(sc.id)
                  const isLocked = data.locked

                  return (
                    <tr key={sc.id} className="border-t-2 border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
                      {/* Subcon name - sticky */}
                      <td
                        className="sticky left-0 z-20 bg-white group-hover:bg-gray-50 px-2 py-0.5 font-medium text-gray-800 text-xs"
                        style={{ width: 150, minWidth: 150, maxWidth: 150 }}
                      >
                        {sc.name}
                      </td>

                      {/* Type badge - sticky */}
                      <td
                        className="sticky left-[150px] z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center"
                        style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                      >
                        <span className="text-[10px] px-1 py-0.5 rounded-full font-medium whitespace-nowrap bg-amber-100 text-amber-700">
                          {sc.type === 'tobi' || sc.type === '鳶業者' ? '鳶' : sc.type === 'doko' || sc.type === '土工業者' ? '土工' : sc.type}
                        </span>
                      </td>

                      {/* Day cells */}
                      {days.map(d => {
                        const entry = entries[d.day] || null
                        const nVal = entry?.n ?? 0
                        const onVal = entry?.on ?? 0

                        return (
                          <td
                            key={d.day}
                            className={`px-0 py-0 border-l border-gray-100 ${dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)])}`}
                            style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                          >
                            <div className="flex flex-col">
                              {/* People count - 大きめ */}
                              <input
                                type="number"
                                step="1"
                                min="0"
                                value={nVal > 0 ? nVal : ''}
                                placeholder="-"
                                onChange={e => onSubconNChange(sc.id, d.day, e.target.value)}
                                disabled={isLocked}
                                className={`w-full text-center text-sm font-bold py-1 bg-transparent border-0 border-b border-gray-100 focus:ring-1 focus:ring-hibi-navy focus:outline-none tabular-nums
                                  ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                  ${nVal > 0 ? 'text-green-700' : 'text-gray-300 font-normal'}
                                `}
                              />

                              {/* OT people count - 小さめ */}
                              <input
                                type="number"
                                step="1"
                                min="0"
                                value={onVal > 0 ? onVal : ''}
                                placeholder=""
                                onChange={e => onSubconOnChange(sc.id, d.day, e.target.value)}
                                disabled={isLocked}
                                className={`w-full text-center text-[10px] py-0 bg-transparent border-0 focus:ring-1 focus:ring-amber-400 focus:outline-none tabular-nums
                                  ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                                  ${onVal > 0 ? 'text-amber-700' : 'opacity-30'}
                                `}
                              />
                            </div>
                          </td>
                        )
                      })}

                      {/* Totals - 人工計 + 残業計 を 1 列に縦並び表示 */}
                      <td className="px-2 py-1 text-center tabular-nums border-l-2 border-gray-300 bg-gray-50" style={{ width: 80, minWidth: 80 }}>
                        <div className="font-bold text-sm text-hibi-navy">{totals.nSum > 0 ? totals.nSum : '-'}</div>
                        <div className="font-bold text-sm text-amber-600 mt-0.5 border-t border-gray-200 pt-0.5">
                          {totals.onSum > 0 ? `${totals.onSum}h` : '-'}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </>
            )}

            {/* ── Footer summary rows ── */}
            {/* Tobi Total */}
            <tr className="border-t-2 border-[#1B2A4A]">
              <td
                className="sticky left-0 z-20 bg-[#1B2A4A] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                鳶 合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#1B2A4A] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.tobi[d.day] > 0 ? Math.round(footerSums.tobi[d.day] * 10) / 10 : '-'}
                </td>
              ))}
              {/* 鳶合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
              <td className="bg-[#1B2A4A] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                <div className="text-white font-bold">{footerSums.tobiTotal > 0 ? footerSums.tobiTotal : '-'}</div>
                <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                  {footerSums.tobiOtTotal > 0 ? `${footerSums.tobiOtTotal}h` : '-'}
                </div>
              </td>
            </tr>

            {/* 鳶 残業合計（日ごと縦集計） */}
            <tr>
              <td
                className="sticky left-0 z-20 bg-[#1B2A4A] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#2A3B5C]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                鳶 残業合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#1B2A4A] px-1 py-1 text-center border-t border-[#2A3B5C]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#1B2A4A] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#2A3B5C]"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.tobiOt[d.day] > 0 ? `${Math.round(footerSums.tobiOt[d.day] * 10) / 10}h` : '-'}
                </td>
              ))}
              {/* 月計は鳶合計行に既に表示済みのため空白 */}
              <td className="bg-[#1B2A4A] px-2 py-1 border-l-2 border-gray-400 border-t border-[#2A3B5C]" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* Doko Total */}
            <tr>
              <td
                className="sticky left-0 z-20 bg-[#243656] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                土工 合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#243656] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#243656] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.doko[d.day] > 0 ? Math.round(footerSums.doko[d.day] * 10) / 10 : '-'}
                </td>
              ))}
              {/* 土工合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
              <td className="bg-[#243656] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                <div className="text-white font-bold">{footerSums.dokoTotal > 0 ? footerSums.dokoTotal : '-'}</div>
                <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                  {footerSums.dokoOtTotal > 0 ? `${footerSums.dokoOtTotal}h` : '-'}
                </div>
              </td>
            </tr>

            {/* 土工 残業合計（日ごと縦集計） */}
            <tr>
              <td
                className="sticky left-0 z-20 bg-[#243656] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#324867]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                土工 残業合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#243656] px-1 py-1 text-center border-t border-[#324867]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#243656] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#324867]"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.dokoOt[d.day] > 0 ? `${Math.round(footerSums.dokoOt[d.day] * 10) / 10}h` : '-'}
                </td>
              ))}
              {/* 月計は土工合計行に既に表示済みのため空白 */}
              <td className="bg-[#243656] px-2 py-1 border-l-2 border-gray-400 border-t border-[#324867]" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* Grand Total */}
            <tr>
              <td
                className="sticky left-0 z-20 bg-[#0F1D36] text-white px-2 py-1.5 font-bold whitespace-nowrap text-[11px]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                総合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#0F1D36] text-white px-1 py-1.5 text-center" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#0F1D36] text-white px-0 py-1.5 text-center text-[11px] font-bold tabular-nums border-l border-gray-600"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.grand[d.day] > 0 ? Math.round(footerSums.grand[d.day] * 10) / 10 : '-'}
                </td>
              ))}
              {/* 総合計の右端: 人工 (上) + 残業 (下) を 1 列に縦並び */}
              <td className="bg-[#0F1D36] px-2 py-1.5 text-center tabular-nums border-l-2 border-gray-400 text-sm" style={{ width: 80, minWidth: 80 }}>
                <div className="text-white font-bold">{footerSums.grandTotal > 0 ? footerSums.grandTotal : '-'}</div>
                <div className="text-amber-300 font-bold border-t border-gray-600 mt-0.5 pt-0.5">
                  {footerSums.grandOtTotal > 0 ? `${footerSums.grandOtTotal}h` : '-'}
                </div>
              </td>
            </tr>

            {/* 総 残業合計（日ごと縦集計） */}
            <tr>
              <td
                className="sticky left-0 z-20 bg-[#0F1D36] text-amber-300 px-2 py-1 font-medium whitespace-nowrap text-[10px] border-t border-[#1F2D44]"
                style={{ width: 150, minWidth: 150, maxWidth: 150 }}
              >
                総 残業合計
              </td>
              <td className="sticky left-[150px] z-20 bg-[#0F1D36] px-1 py-1 text-center border-t border-[#1F2D44]" style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => (
                <td
                  key={d.day}
                  className="bg-[#0F1D36] text-amber-300 px-0 py-1 text-center text-[11px] font-medium tabular-nums border-l border-gray-600 border-t border-[#1F2D44]"
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                >
                  {footerSums.grandOt[d.day] > 0 ? `${Math.round(footerSums.grandOt[d.day] * 10) / 10}h` : '-'}
                </td>
              ))}
              {/* 月計は総合計行に既に表示済みのため空白 */}
              <td className="bg-[#0F1D36] px-2 py-1 border-l-2 border-gray-400 border-t border-[#1F2D44]" style={{ width: 80, minWidth: 80 }}></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 flex items-center gap-4 text-[10px] text-gray-500 dark:text-gray-400 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-amber-50 border border-amber-200" /> 今日
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-red-50 border border-red-200" /> 日曜
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-blue-50 border border-blue-200" /> 土曜
        </span>
        <span className="mx-2 border-l border-gray-300 h-3" />
        <span><strong className="text-green-700">1</strong> = 出勤</span>
        <span><strong className="text-yellow-700">0.5</strong> = 半日</span>
        <span><strong className="text-purple-600">有</strong> = 有給</span>
        <span className="text-amber-700">下段 = 残業h</span>
        {useTimeBased && data.workers.some(w => w.visa && w.visa !== 'none' && w.visa !== '') && (
          <>
            <span className="mx-2 border-l border-gray-300 h-3" />
            <span className="text-orange-600 font-medium">外国人:</span>
            <span><strong className="text-green-700">出</strong> = 時間入力</span>
            <span>休憩: ☐午前30分 / ☐午後30分（昼60分は固定）</span>
            <span className="text-amber-600">7h超=残業</span>
          </>
        )}
      </div>
    </div>
  )
}

'use client'

import { Icon } from '@/components/ui/Icon'
import { siteLeaderLabel } from '@/lib/companies'
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  dayColBg, dayHeaderBg, dayTextColor,
  getWorkValue, getTimeStatusValue, retirementBadge, isActualWorkEntry,
  FooterSums, WorkerTotals,
} from '@/lib/attendance-grid'
import { orgBadgeCls, orgBadgeLabel } from '@/lib/labels'
import { GridData, AttEntry, SubconDayEntry } from '../types'
import {
  TimeBasedCell, LegacyCell, HomeLeaveCell, WaitingCell, WorkTypeTag,
  workTypeChipCls, workTypeColumnBg, type WorkTypeTagProps, type WorkTypeOption,
} from './WorkerDayCell'

// 出面グリッド本体: ヘッダー行・職長承認行・最終承認行・ワーカー行・
// 外注行・フッター合計6行・凡例

interface Props {
  data: GridData
  days: { day: number; dow: number; label: string }[]
  cellWidth: number
  /**
   * 名前列の幅(px)。スマホでは狭くして日付を1日でも多く見せる（2026-08-31 追加）。
   * 職長は専用画面ではなくこのPC画面をスマホで操作しているため、ここが効く。
   */
  nameWidth: number
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
  onNightClick?: (workerId: string, day: number) => void
  /** 夜勤が発生した日（この日だけスタッフのセルに夜勤バッジが出る） */
  nightDays?: number[]
  onToggleNightDay?: (day: number) => void
  /** 運転記録（day → {am,pm}）。運転手当の元データ */
  drivers?: Record<number, { am: number[]; pm: number[] }>
  onDriverClick?: (day: number) => void
  onForemanApproveAll: () => void
  onToggleForemanApproval: (day: number) => void
  onFinalApproveAll: () => void
  onToggleFinalApproval: (day: number) => void

  // ── 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25） ──
  //   workTypeSites が空/未指定 = この現場には工種が無い（何も表示しない・従来どおり）
  workTypeSites?: { id: string; name: string; workType: string }[]
  /** その月の日ごとの工種指定（day（文字列）→ 工種サイト id）。列の色と見出しのチップに使う */
  dayWorkType?: Record<string, string>
  /** 日付の見出しのチップで、その日の全員の工種を決める（新規の保存先＋入力済みの一括移動） */
  onSetDayWorkType?: (day: number, toSiteId: string) => void
  defaultWorkType?: Record<string, string>
  defaultWorkTypeSubcon?: Record<string, string>
  entrySiteByWorkerDay?: Record<string, Record<number, string>>
  entrySiteBySubconDay?: Record<string, Record<number, string>>
  onChangeDefaultWorkType?: (workerId: string, siteId: string | null) => void
  onChangeDefaultWorkTypeSubcon?: (subconId: string, siteId: string | null) => void
  onMoveWorkType?: (workerId: string, day: number, toSiteId: string) => void
  onMoveWorkTypeSubcon?: (subconId: string, day: number, toSiteId: string) => void
}

export default function AttendanceGrid({
  data, days, cellWidth, nameWidth, useTimeBased, groupedWorkers,
  workerEntries, subconEntries, footerSums, localApprovals, localFinalApprovals,
  canForemanApprove, canFinalize, startTimeOptions, endTimeOptions, workerTotals, subconTotals,
  onWorkChange, onOtChange, onTimeStatusChange, onStartTimeChange, onEndTimeChange, onBreakChange,
  onSubconNChange, onSubconOnChange, onCellKeyDown, onNightClick,
  nightDays, onToggleNightDay,
  drivers, onDriverClick,
  onForemanApproveAll, onToggleForemanApproval, onFinalApproveAll, onToggleFinalApproval,
  workTypeSites, dayWorkType, onSetDayWorkType, defaultWorkType, defaultWorkTypeSubcon,
  entrySiteByWorkerDay, entrySiteBySubconDay,
  onChangeDefaultWorkType, onChangeDefaultWorkTypeSubcon, onMoveWorkType, onMoveWorkTypeSubcon,
}: Props) {
  // 夜勤が発生した日の判定（台風待機など）。指定日だけスタッフのセルに夜勤バッジを出す
  const nightDaySet = useMemo(() => new Set(nightDays || []), [nightDays])
  const isNightDay = (day: number) => nightDaySet.has(day)

  // ── 工種の出し分け（鉄骨・仮設など単価違い・2026-09-25） ──
  const hasWorkTypes = !!workTypeSites && workTypeSites.length > 0
  // 「入力先」の選択肢: 親現場 + 各工種（親現場を先頭に）。色は並び順で固定
  //   親現場の呼び方: 親現場に「工種を選ばない日の呼び方」（例: 仮設工事）が付いていればそれ、無ければ「親現場」
  const parentLabel = data.site.workType || '親現場'
  const workTypeOptions: WorkTypeOption[] = useMemo(() => {
    if (!hasWorkTypes) return []
    return [
      { id: data.site.id, label: parentLabel, cls: workTypeChipCls(-1) },
      ...(workTypeSites || []).map((s, i) => ({ id: s.id, label: s.workType, cls: workTypeChipCls(i) })),
    ]
  }, [hasWorkTypes, workTypeSites, data.site.id, parentLabel])
  /** その日に工種指定があれば workTypeSites 内の並び番号（列の色用）。無ければ -1 */
  const dayWorkTypeIndex = (day: number): number => {
    if (!hasWorkTypes) return -1
    const sid = dayWorkType?.[String(day)]
    if (!sid) return -1
    return (workTypeSites || []).findIndex(s => s.id === sid)
  }
  /** 曜日色より工種の色を優先（鉄骨の日が続いているのがひと目で分かるように） */
  const columnBg = (day: number, fallback: string): string => {
    const i = dayWorkTypeIndex(day)
    return i >= 0 ? workTypeColumnBg(i) : fallback
  }
  const workTypeDupSet = useMemo(() => {
    const set = new Set<string>()
    for (const d of data.workTypeDuplicates || []) set.add(`${d.kind}-${d.id}-${d.day}`)
    return set
  }, [data.workTypeDuplicates])
  /** 作業員の日別セル用の工種タグ（その日にエントリが無ければ null＝タグを出さない） */
  const workerWorkTypeTag = (wId: string, day: number, hasEntry: boolean): WorkTypeTagProps | undefined => {
    if (!hasWorkTypes || !hasEntry || !onMoveWorkType) return undefined
    const value = entrySiteByWorkerDay?.[wId]?.[day] || data.site.id
    return {
      value,
      options: workTypeOptions,
      isDuplicate: workTypeDupSet.has(`worker-${wId}-${day}`),
      onChange: siteId => { if (siteId !== value) onMoveWorkType(wId, day, siteId) },
    }
  }
  const subconWorkTypeTag = (scId: string, day: number, hasEntry: boolean): WorkTypeTagProps | undefined => {
    if (!hasWorkTypes || !hasEntry || !onMoveWorkTypeSubcon) return undefined
    const value = entrySiteBySubconDay?.[scId]?.[day] || data.site.id
    return {
      value,
      options: workTypeOptions,
      isDuplicate: workTypeDupSet.has(`subcon-${scId}-${day}`),
      onChange: siteId => { if (siteId !== value) onMoveWorkTypeSubcon(scId, day, siteId) },
    }
  }

  const unapprovedDays = days.filter(d => !localApprovals[d.day])
  // 職長承認済かつ最終未承認の日だけが最終承認の対象
  const finalizableDays = days.filter(d => localApprovals[d.day] && !localFinalApprovals[d.day])

  // 承認2行（職長承認・最終承認）を日付ヘッダーの直下に sticky 固定する。
  // top オフセットは thead と職長承認行の実高さから算出（フォント・ズームで変わるため実測）。
  // offsetHeight は整数丸めのため、ズーム率が100%以外だと合計値に誤差が生じ、
  // sticky行の隙間から裏の行が透けて見える不具合があった（getBoundingClientRectで解消）
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const foremanRowRef = useRef<HTMLTableRowElement>(null)
  const [approvalTops, setApprovalTops] = useState<[number, number]>([0, 0])
  useLayoutEffect(() => {
    const measure = () => {
      const theadH = theadRef.current?.getBoundingClientRect().height ?? 0
      const foremanH = foremanRowRef.current?.getBoundingClientRect().height ?? 0
      setApprovalTops([theadH, theadH + foremanH])
    }
    measure()
    window.addEventListener('resize', measure)
    // 2026-10-01: 見出し・職長承認行の高さが後から変わる（字の読み込み・工種チップ等）と
    //   測った値がずれ、承認行と見出しのすき間から下の行が透けた。大きさが変わるたびに測り直す
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ro) {
      if (theadRef.current) ro.observe(theadRef.current)
      if (foremanRowRef.current) ro.observe(foremanRowRef.current)
    }
    return () => { window.removeEventListener('resize', measure); ro?.disconnect() }
  }, [days.length, cellWidth])

  /**
   * 「今日へ」ボタン（2026-08-31 追加）。
   * スマホでは同時に3日分ほどしか見えないため、月の後半になるほど毎回大きく横スクロール
   * することになっていた。今日の列が左端に来るところまで一気に飛ばす。
   */
  const scrollRef = useRef<HTMLDivElement>(null)
  const todayIdx = (() => {
    const t = new Date()
    const d = t.getDate()
    return days.findIndex(x => x.day === d)
  })()
  const jumpToToday = () => {
    if (!scrollRef.current || todayIdx < 0) return
    scrollRef.current.scrollTo({ left: Math.max(0, todayIdx * cellWidth - 8), behavior: 'smooth' })
  }

  // isolate: 見出し行・名前列の sticky(z-30/z-20) をこの枠内の重なり順に閉じ込める。
  //   2026-09-02: 承認バー（ページ上部 sticky z-30）とグリッド見出し（枠内 sticky z-30）が
  //   同じ重なり順で、上へスクロールすると見出し行が承認バーの上に描かれていた
  return (
    <div className="isolate bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden -mx-4 sm:mx-0 rounded-none sm:rounded-xl">
      {/* 2026-10-01: 上部の案内と「今日へ」。絵文字をやめる */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-hibi-line dark:border-gray-700">
        <span className="hidden sm:inline text-[13px] text-hibi-sub dark:text-gray-400">セルを押して入力。外国人スタッフは本人のスマホ入力が入ります</span>
        {/* スマホ最適化画面との相互切替（2026-09-02 追加。スマホ幅のときだけ表示） */}
        <a href="/attendance/mobile" className="sm:hidden text-xs font-bold px-3 py-1.5 rounded-lg border border-hibi-navy text-hibi-navy">スマホ版へ</a>
        {todayIdx >= 0 && (
          <button type="button" onClick={jumpToToday}
            className="ml-auto text-[13px] font-bold px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 transition">
            今日へ
          </button>
        )}
      </div>
      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
        <table className="text-xs border-collapse table-fixed" style={{ width: `${180 + days.length * 48 + 80}px` }}>
          <thead ref={theadRef} className="sticky top-0 z-30">
            {/* Day number row */}
            {/* 2026-10-01: 貼り付く行の線は border でなく内側の影で描く（border-collapse の線は貼り付いて動かず、
                スクロールすると線のすき間から下の濃紺の行が透けて黒い縦線に見えた） */}
            <tr>
              <th
                className="sticky left-0 z-40 bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1.5 text-left font-bold whitespace-nowrap shadow-[inset_0_-1px_0_#E3E7EE]"
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                名前
              </th>
              <th
                className="sticky z-40 bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1 py-1.5 text-center font-bold shadow-[inset_0_-1px_0_#E3E7EE]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                  className={`px-0 py-1 text-center font-bold ${columnBg(d.day, dayHeaderBg(data.year, data.month, d.day, calDayType))} ${isWeekdayOff ? 'text-gray-400' : dayTextColor(d.dow)} shadow-[inset_1px_-1px_0_#E3E7EE]`}
                  style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                  title={isCalOff ? 'カレンダー休日' : data.calendarDays ? 'カレンダー出勤日' : ''}
                >
                  <div className="leading-tight">
                    <div className="text-[13px]">{d.day}</div>
                    <div className="text-[10px] font-normal">{d.label}{showOffMark ? ' 休' : ''}</div>
                    {/* この日の工種（工種のある現場だけ・2026-09-25）。押すとその日の全員の工種が変わる
                        （新しい入力の保存先＋入力済みの一括移動）。ロック中は色だけ見せる */}
                    {hasWorkTypes && (() => {
                      const cur = dayWorkType?.[String(d.day)] || data.site.id
                      const opt = workTypeOptions.find(o => o.id === cur) || workTypeOptions[0]
                      if (data.locked || !onSetDayWorkType) {
                        return <div className={`mt-1 w-full min-h-[24px] text-[12px] font-bold leading-tight rounded-md py-1 text-center ${opt.cls}`}>{opt.label}</div>
                      }
                      return (
                        <select
                          value={cur}
                          onChange={e => {
                            const to = workTypeOptions.find(o => o.id === e.target.value)
                            if (!to || to.id === cur) return
                            if (!confirm(`${d.day}日を「${to.label}」にします。\nこの日に入力済みの人の出面も全員「${to.label}」へ移ります。\nよろしいですか？`)) return
                            onSetDayWorkType(d.day, to.id)
                          }}
                          title={`${d.day}日の工種（押して選ぶ）`}
                          className={`mt-1 w-full min-h-[24px] text-[12px] font-bold leading-tight rounded-md py-1 px-0.5 appearance-none cursor-pointer shadow-sm text-center [text-align-last:center] ${opt.cls}`}
                        >
                          {workTypeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                      )
                    })()}
                    {/* 夜勤日の指定（台風待機など年数回）。ここで指定した日だけ
                        スタッフのセルに「夜」バッジが出る。未指定日はホバーで薄く出る */}
                    {onToggleNightDay && !data.locked && (
                      <button
                        type="button"
                        onClick={() => onToggleNightDay(d.day)}
                        title={isNightDay(d.day)
                          ? `${d.day}日は夜勤あり（クリックで解除）`
                          : `${d.day}日を夜勤ありにする`}
                        className={`mt-0.5 w-full text-[10px] font-bold leading-tight rounded py-0.5 transition-opacity ${
                          isNightDay(d.day)
                            ? 'bg-indigo-600 text-white opacity-100'
                            : 'text-indigo-500 opacity-0 hover:opacity-100'
                        }`}
                      >
                        夜
                      </button>
                    )}
                    {/* 便ごとの運転者（運転手当）。記録がある日は 運N で常時表示、
                        無い日はホバーで薄く出る（夜バッジと同じ流儀） */}
                    {onDriverClick && !data.locked && (() => {
                      const dr = drivers?.[d.day]
                      const cnt = (dr?.am.length || 0) + (dr?.pm.length || 0)
                      return (
                        <button
                          type="button"
                          onClick={() => onDriverClick(d.day)}
                          title={cnt > 0 ? `${d.day}日の運転者（行き${dr!.am.length}・帰り${dr!.pm.length}）` : `${d.day}日の運転者を記録`}
                          className={`mt-0.5 w-full text-[10px] font-bold leading-tight rounded py-0.5 transition-opacity ${
                            cnt > 0
                              ? 'bg-emerald-600 text-white opacity-100'
                              : 'text-emerald-600 opacity-0 hover:opacity-100'
                          }`}
                        >
                          {cnt > 0 ? `運${cnt}` : '運'}
                        </button>
                      )
                    })()}
                  </div>
                </th>
                )
              })}
              <th className="bg-hibi-thead dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1.5 text-center font-bold shadow-[inset_2px_-1px_0_#9CA3AF]" style={{ width: 80, minWidth: 80 }}>
                <div>計</div>
                <div className="text-[8px] opacity-70 font-normal">上:人工 / 下:残業h</div>
              </th>
            </tr>
          </thead>

          <tbody>
            {/* ── 職長承認 row（1次承認: 担当現場の職長のみ）──
                 職長名はこの承認行に集約表示（旧: 上部に空セルだけの黄色「職長行」があったが
                 情報が無く名前も二重だったため 2026-07-09 に削除。代理メモはここへ移設）。 */}
            <tr ref={foremanRowRef} className="bg-white dark:bg-gray-800 sticky z-[25]" style={{ top: approvalTops[0] }}>
              {/* 2026-10-01: 誰が押す行かを2行で・ボタンを大きく（旧: 9px の「一括承認」） */}
              <td
                className="sticky left-0 z-20 bg-white dark:bg-gray-800 px-2 py-1.5 shadow-[inset_0_-1px_0_#E3E7EE]"
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="min-w-0 whitespace-nowrap">
                    <div className="text-[13px] font-bold text-gray-900 dark:text-white">{siteLeaderLabel(data.isSupportSite)}承認</div>
                    <div className="text-[11px] text-hibi-sub dark:text-gray-400 truncate">{data.site.foremanName || '—'}{data.site.foremanNote ? `（${data.site.foremanNote}）` : ''}</div>
                  </div>
                  {canForemanApprove && (unapprovedDays.length > 0 ? (
                    <button onClick={onForemanApproveAll}
                      className="shrink-0 h-7 px-2.5 rounded-md bg-hibi-navy text-white text-xs font-bold whitespace-nowrap hover:bg-hibi-light transition">
                      まとめて承認
                    </button>
                  ) : (
                    <span className="shrink-0 text-xs font-bold text-green-700 dark:text-green-400 whitespace-nowrap">全日承認済み</span>
                  ))}
                </div>
              </td>
              <td className="sticky z-20 bg-white dark:bg-gray-800 px-1 py-1 text-center shadow-[inset_0_-1px_0_#E3E7EE]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => {
                const approved = localApprovals[d.day]
                // 既に最終承認済みの場合は職長承認も解除できない（先に最終を外す必要）
                const finalApproved = localFinalApprovals[d.day]
                const cellLocked = approved && finalApproved
                const clickable = canForemanApprove && !cellLocked
                return (
                  <td
                    key={d.day}
                    className={`px-0 py-1 shadow-[inset_1px_-1px_0_#E3E7EE] bg-white dark:bg-gray-800 text-center ${clickable ? 'cursor-pointer hover:bg-hibi-active dark:hover:bg-gray-700' : ''}`}
                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    onClick={clickable ? () => onToggleForemanApproval(d.day) : undefined}
                    title={
                      cellLocked ? '最終承認済のため解除不可（先に最終承認を外す）'
                      : canForemanApprove ? (approved ? 'クリックで承認解除' : `クリックで${siteLeaderLabel(data.isSupportSite)}承認`)
                      : `担当現場の${siteLeaderLabel(data.isSupportSite)}のみ操作可`
                    }
                  >
                    {approved ? (
                      <Icon name="check" size={15} strokeWidth={3} className="mx-auto text-hibi-navy dark:text-blue-300" />
                    ) : clickable ? (
                      <span className="inline-block w-4 h-4 rounded border-2 border-hibi-navy/50 dark:border-blue-400/60" />
                    ) : null}
                  </td>
                )
              })}
              <td className="px-1 py-1 text-center shadow-[inset_2px_-1px_0_#D1D5DB] bg-white dark:bg-gray-800" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* ── 最終承認 row（事業責任者・管理者: 職長承認後のみ操作可） ── */}
            <tr className="bg-white dark:bg-gray-800 sticky z-[25]" style={{ top: approvalTops[1] }}>
              <td
                className="sticky left-0 z-20 bg-white dark:bg-gray-800 px-2 py-1.5 shadow-[inset_0_-2px_0_#D1D5DB]"
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="min-w-0 whitespace-nowrap">
                    <div className="text-[13px] font-bold text-gray-900 dark:text-white">最終承認</div>
                    <div className="text-[11px] text-hibi-sub dark:text-gray-400">事業責任者</div>
                  </div>
                  {canFinalize && finalizableDays.length > 0 && (
                    <button onClick={onFinalApproveAll}
                      className="shrink-0 h-7 px-2.5 rounded-md bg-green-700 text-white text-xs font-bold whitespace-nowrap hover:bg-green-800 transition">
                      まとめて最終承認
                    </button>
                  )}
                </div>
              </td>
              <td className="sticky z-20 bg-white dark:bg-gray-800 px-1 py-1 text-center shadow-[inset_0_-2px_0_#D1D5DB]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
              {days.map(d => {
                const foremanApproved = localApprovals[d.day]
                const finalApproved = localFinalApprovals[d.day]
                // 職長承認なしには最終承認は付けられない
                const clickable = canFinalize && (finalApproved || foremanApproved)
                return (
                  <td
                    key={d.day}
                    className={`px-0 py-1 shadow-[inset_1px_-2px_0_#D1D5DB] bg-white dark:bg-gray-800 text-center ${clickable ? 'cursor-pointer hover:bg-green-50 dark:hover:bg-gray-700' : ''}`}
                    style={{ width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
                    onClick={clickable ? () => onToggleFinalApproval(d.day) : undefined}
                    title={
                      finalApproved ? 'クリックで最終承認解除'
                      : !canFinalize ? '管理者・事業責任者のみ操作可'
                      : !foremanApproved ? `${siteLeaderLabel(data.isSupportSite)}承認後に押せます`
                      : 'クリックで最終承認'
                    }
                  >
                    {finalApproved ? (
                      <Icon name="check" size={15} strokeWidth={3} className="mx-auto text-green-700 dark:text-green-400" />
                    ) : foremanApproved && canFinalize ? (
                      <span className="inline-block w-4 h-4 rounded border-2 border-green-700/50 dark:border-green-400/60" />
                    ) : null}
                  </td>
                )
              })}
              <td className="px-1 py-1 text-center shadow-[inset_2px_-2px_0_#D1D5DB] bg-white dark:bg-gray-800" style={{ width: 80, minWidth: 80 }}></td>
            </tr>

            {/* ── Worker groups ── */}
            {groupedWorkers.map(group => (
              <React.Fragment key={`group-${group.org}`}>
                {/* Group header */}
                {/* 所属の区切り行は紺ベタ＝ブランドの錨（案1 UDホワイトでも合計行とそろえて維持） */}
                <tr className="bg-hibi-navy dark:bg-gray-950">
                  <td
                    className="sticky left-0 z-20 bg-hibi-navy dark:bg-gray-950 px-2.5 py-1.5 font-bold text-xs tracking-wider text-white"
                    style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
                  >
                    {group.label}　{group.workers.length}名
                  </td>
                  <td className="sticky z-20 bg-hibi-navy dark:bg-gray-950" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
                  {days.map(d => <td key={d.day} className="bg-hibi-navy dark:bg-gray-950" />)}
                  <td className="bg-hibi-navy dark:bg-gray-950" />
                  <td className="bg-hibi-navy dark:bg-gray-950" />
                </tr>

                {group.workers.map(worker => {
                  const wId = String(worker.id)
                  const entries = workerEntries[wId] || {}
                  const totals = workerTotals(wId)
                  const isLocked = data.locked

                  return (
                    <tr key={worker.id} className="border-t border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
                      {/* Worker name - sticky */}
                      <td
                        className="sticky left-0 z-20 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 px-2.5 py-0.5 font-bold text-gray-900 dark:text-gray-100 text-[13px]"
                        style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
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
                        {hasWorkTypes && onChangeDefaultWorkType && (
                          <select
                            value={defaultWorkType?.[wId] || data.site.id}
                            onChange={e => onChangeDefaultWorkType(wId, e.target.value === data.site.id ? null : e.target.value)}
                            disabled={isLocked}
                            title="この人の新しい入力は、既定でどの工種に入るか"
                            className={`mt-0.5 w-full text-[9px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-0.5 py-0
                              ${isLocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                          >
                            {workTypeOptions.map(o => <option key={o.id} value={o.id}>既定: {o.label}</option>)}
                          </select>
                        )}
                      </td>

                      {/* Org badge - sticky (colored by visa) */}
                      <td
                        className="sticky z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                        const isHolidayWork = !!(calDay && (calDay === 'off' || calDay === 'holiday') && isActualWorkEntry(entry))
                        const colBg = columnBg(d.day, dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)]))
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
                            return (
                              <WaitingCell
                                key={d.day}
                                colBg={colBg}
                                cellWidth={cellWidth}
                                wId={wId}
                                day={d.day}
                                isLocked={isLocked}
                                onStatusChange={onTimeStatusChange}
                                showCompButton={
                                  // カレンダー休日(off/holiday)だけ対象外（2026-08-26 代表確認）。
                                  //   カレンダー休日に補償が要るのは旧制度の3名だけで、
                                  //   その人たちはレガシーUI（待機中セルを通らない）なので対象外。
                                  //
                                  // 2026-08-28 修正: 「その日まだ誰も出勤していない日」という絞り込みを廃止。
                                  //   現場は動いていても特定の人だけ休ませるケース（人員調整など）があり、
                                  //   その人に 0.6補 を入れられなくなっていた。稼働日の未入力セルなら常に出す
                                  //   （ホバー時のみ表示なので画面のノイズにはならない）。
                                  calDay !== 'off' && calDay !== 'holiday'
                                }
                              />
                            )
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
                              onNightClick={isNightDay(d.day) ? onNightClick : undefined}
                              workTypeTag={workerWorkTypeTag(wId, d.day, !!entries[d.day])}
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
                            onNightClick={isNightDay(d.day) ? onNightClick : undefined}
                            // 旧契約継続者（外国人）はスマホ打刻の時刻・休憩も併せて表示する
                            onBreakChange={worker.useOldRules && !!worker.visa && worker.visa !== 'none' ? onBreakChange : undefined}
                            workTypeTag={workerWorkTypeTag(wId, d.day, !!entries[d.day])}
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
                    style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
                  >
                    外注 ({data.subcons.length}社)
                  </td>
                  <td className="sticky z-20 bg-amber-50 border-t-2 border-amber-400" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }} />
                  {days.map(d => <td key={d.day} className="border-t-2 border-amber-400 bg-amber-50" />)}
                  <td className="border-t-2 border-amber-400 bg-amber-50" />
                  <td className="border-t-2 border-amber-400 bg-amber-50" />
                </tr>

                {data.subcons.map(sc => {
                  const entries = subconEntries[sc.id] || {}
                  const totals = subconTotals(sc.id)
                  const isLocked = data.locked

                  return (
                    <tr key={sc.id} className="border-t border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 group">
                      {/* Subcon name - sticky */}
                      <td
                        className="sticky left-0 z-20 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 px-2.5 py-0.5 font-bold text-gray-900 dark:text-gray-100 text-[13px]"
                        style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
                      >
                        {sc.name}
                        {hasWorkTypes && onChangeDefaultWorkTypeSubcon && (
                          <select
                            value={defaultWorkTypeSubcon?.[sc.id] || data.site.id}
                            onChange={e => onChangeDefaultWorkTypeSubcon(sc.id, e.target.value === data.site.id ? null : e.target.value)}
                            disabled={isLocked}
                            title="この外注先の新しい入力は、既定でどの工種に入るか"
                            className={`mt-0.5 w-full text-[9px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-0.5 py-0
                              ${isLocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                          >
                            {workTypeOptions.map(o => <option key={o.id} value={o.id}>既定: {o.label}</option>)}
                          </select>
                        )}
                      </td>

                      {/* Type badge - sticky */}
                      <td
                        className="sticky z-20 bg-white group-hover:bg-gray-50 px-1 py-0.5 text-center" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}
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
                            className={`px-0 py-0 border-l border-gray-100 ${columnBg(d.day, dayColBg(data.year, data.month, d.day, data.calendarDays?.[String(d.day)]))}`}
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
                            <WorkTypeTag workTypeTag={subconWorkTypeTag(sc.id, d.day, !!entries[d.day])} isLocked={isLocked} />
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                鳶 合計
              </td>
              <td className="sticky z-20 bg-[#1B2A4A] text-white px-1 py-1.5 text-center" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                鳶 残業合計
              </td>
              <td className="sticky z-20 bg-[#1B2A4A] px-1 py-1 text-center border-t border-[#2A3B5C]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                土工 合計
              </td>
              <td className="sticky z-20 bg-[#243656] text-white px-1 py-1.5 text-center" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                土工 残業合計
              </td>
              <td className="sticky z-20 bg-[#243656] px-1 py-1 text-center border-t border-[#324867]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                総合計
              </td>
              <td className="sticky z-20 bg-[#0F1D36] text-white px-1 py-1.5 text-center" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
                style={{ width: nameWidth, minWidth: nameWidth, maxWidth: nameWidth }}
              >
                総 残業合計
              </td>
              <td className="sticky z-20 bg-[#0F1D36] px-1 py-1 text-center border-t border-[#1F2D44]" style={{ left: nameWidth, width: cellWidth, minWidth: cellWidth, maxWidth: cellWidth }}></td>
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
      <div className="px-4 py-2.5 bg-white dark:bg-gray-800 border-t border-hibi-line dark:border-gray-700 flex items-center gap-x-4 gap-y-1.5 text-xs text-hibi-sub dark:text-gray-400 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-amber-50 border border-amber-200" /> 今日
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-red-50 border border-red-200" /> 日曜
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-blue-50 border border-blue-200" /> 土曜
        </span>
        <span className="mx-1 border-l border-hibi-line dark:border-gray-600 h-3" />
        {hasWorkTypes && (
          <>
            <span className="text-hibi-navy font-medium">工種:</span>
            {workTypeOptions.map(o => (
              <span key={o.id} className={`px-1.5 py-0.5 rounded-md font-bold text-[11px] ${o.cls}`}>{o.label}</span>
            ))}
            <span>日付の見出しのチップ＝その日の全員の工種。色付きの列＝その工種の日。マスのタグ＝その人だけの例外</span>
            <span className="mx-1 border-l border-hibi-line dark:border-gray-600 h-3" />
          </>
        )}
        <span><strong className="text-green-700">1</strong> = 出勤</span>
        <span><strong className="text-yellow-700">0.5</strong> = 半日</span>
        <span><strong className="text-purple-600">有</strong> = 有給</span>
        <span className="text-amber-700">下段 = 残業h</span>
        {(canForemanApprove || canFinalize) && <span className="sm:ml-auto">承認の行の四角＝押すと承認できる日</span>}
        {useTimeBased && data.workers.some(w => w.visa && w.visa !== 'none' && w.visa !== '') && (
          <>
            <span className="mx-1 border-l border-hibi-line dark:border-gray-600 h-3" />
            <span className="text-orange-600 font-medium">外国人:</span>
            <span><strong className="text-green-700">出</strong> = 時間入力</span>
            <span>休憩: 午前30分・午後30分のチェック（昼60分は固定）</span>
            <span className="text-amber-600">7h超=残業</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 帰国情報バナー（attendance/page.tsx から抽出）
 *
 * 表示ルール:
 *  - 帰国中: 開始 <= today <= 終了
 *  - 予定: today < 開始
 *  - 済: 終了 < today、ただし帰国から N 日以内のみ表示
 * 並び順: 帰国中 → 予定 → 済（同区分内は開始日昇順）
 */
'use client'

import { todayJstIso } from '@/lib/date-utils'

export interface HomeLeaveInfo {
  workerId: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
}

interface Props {
  homeLeaves: HomeLeaveInfo[] | undefined
  recentReturnDays?: number  // 「最近帰国」表示の閾値（デフォルト 7 日）
}

export default function HomeLeaveBanner({ homeLeaves, recentReturnDays = 7 }: Props) {
  if (!homeLeaves || homeLeaves.length === 0) return null

  // 「今日」は日本時間で判定する。UTC(toISOString)だとJSTの朝0〜9時は前日扱いになり、
  //   帰国終了日の翌日でも「帰国中」のまま残る等、1日ズレる（2026-07 修正）。
  const now = todayJstIso()
  const today = new Date(now + 'T00:00:00')

  type Categorized = {
    hl: HomeLeaveInfo
    status: 'current' | 'future' | 'recent'
    daysUntilStart: number
    daysSinceReturn: number
  }
  const categorized: Categorized[] = homeLeaves.map(hl => {
    const isCurrent = hl.startDate <= now && hl.endDate >= now
    const isFuture = hl.startDate > now
    const start = new Date(hl.startDate + 'T00:00:00')
    const end = new Date(hl.endDate + 'T00:00:00')
    const daysUntilStart = Math.ceil((start.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
    const daysSinceReturn = Math.floor((today.getTime() - end.getTime()) / (24 * 60 * 60 * 1000))
    const status: 'current' | 'future' | 'recent' =
      isCurrent ? 'current'
      : isFuture ? 'future'
      : 'recent'
    return { hl, status, daysUntilStart, daysSinceReturn }
  })

  // 済は帰国から N 日以内のみ
  const visible = categorized.filter(c =>
    c.status !== 'recent' || c.daysSinceReturn <= recentReturnDays
  )

  // 並び順
  const statusOrder = { current: 0, future: 1, recent: 2 }
  visible.sort((a, b) => {
    const diff = statusOrder[a.status] - statusOrder[b.status]
    if (diff !== 0) return diff
    return a.hl.startDate.localeCompare(b.hl.startDate)
  })

  if (visible.length === 0) return null

  const currentCount = visible.filter(c => c.status === 'current').length
  const futureCount = visible.filter(c => c.status === 'future').length
  const recentCount = visible.filter(c => c.status === 'recent').length

  return (
    <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-bold text-cyan-800 mb-2 flex-wrap">
        <span>✈️ 帰国情報</span>
        {currentCount > 0 && (
          <span className="text-xs bg-cyan-200 text-cyan-900 px-1.5 py-0.5 rounded-full">
            帰国中 {currentCount}名
          </span>
        )}
        {futureCount > 0 && (
          <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
            予定 {futureCount}名
          </span>
        )}
        {recentCount > 0 && (
          <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded-full">
            最近帰国 {recentCount}名
          </span>
        )}
      </div>
      <div className="space-y-1">
        {visible.map((c, i) => {
          const { hl, status, daysUntilStart, daysSinceReturn } = c
          return (
            <div key={i} className="flex items-center gap-2 text-xs text-cyan-700 flex-wrap">
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                status === 'current' ? 'bg-cyan-200 text-cyan-800'
                : status === 'future' ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-200 text-gray-700'
              }`}>
                {status === 'current' ? '帰国中' : status === 'future' ? '予定' : '済'}
              </span>
              <span className="font-medium">{hl.workerName}</span>
              <span>{hl.startDate.slice(5)} 〜 {hl.endDate.slice(5)}</span>
              <span className="text-cyan-500">({hl.reason})</span>
              {status === 'future' && daysUntilStart > 0 && (
                <span className="text-[10px] text-blue-600">
                  {daysUntilStart === 1 ? '明日から' : `あと${daysUntilStart}日`}
                </span>
              )}
              {status === 'recent' && (
                <span className="text-[10px] text-gray-500">
                  {daysSinceReturn === 0 ? '今日帰国' : daysSinceReturn === 1 ? '昨日帰国' : `${daysSinceReturn}日前に帰国`}
                </span>
              )}
              {hl.status === 'foreman_approved' && (
                <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">職長済・最終承認待ち</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

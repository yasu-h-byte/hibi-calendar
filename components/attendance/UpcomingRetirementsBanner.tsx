/**
 * 退職予定バナー（3ヶ月以内、attendance/page.tsx から抽出）
 *
 * 30日以内 → 赤（緊急）、31〜90日 → オレンジ（予定）
 */
'use client'

import { visaBadge } from '@/lib/labels'

export interface UpcomingRetirement {
  id: number
  name: string
  org: string
  visa: string
  retired: string  // YYYY-MM-DD
}

interface Props {
  retirements: UpcomingRetirement[] | undefined
}

export default function UpcomingRetirementsBanner({ retirements }: Props) {
  if (!retirements || retirements.length === 0) return null

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // diffDays を 1 度だけ計算
  const withDiff = retirements.map(r => ({
    ...r,
    diffDays: Math.floor((new Date(r.retired + 'T00:00:00').getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
  }))
  const urgent = withDiff.filter(r => r.diffDays <= 30)
  const later = withDiff.filter(r => r.diffDays > 30)

  return (
    <div className={`${urgent.length > 0 ? 'bg-red-50 border-red-300' : 'bg-orange-50 border-orange-200'} border rounded-xl px-4 py-3 text-sm`}>
      <div className={`flex items-center gap-2 font-bold mb-2 flex-wrap ${urgent.length > 0 ? 'text-red-800' : 'text-orange-800'}`}>
        <span>🏁 退職予定（3ヶ月以内）</span>
        {urgent.length > 0 && (
          <span className="text-xs bg-red-200 text-red-900 px-1.5 py-0.5 rounded-full">
            30日以内 {urgent.length}名
          </span>
        )}
        {later.length > 0 && (
          <span className="text-xs bg-orange-200 text-orange-900 px-1.5 py-0.5 rounded-full">
            予定 {later.length}名
          </span>
        )}
      </div>
      <div className="space-y-1">
        {withDiff.map((r, i) => {
          const { diffDays } = r
          const isUrgent = diffDays <= 30
          const visa = visaBadge(r.visa)
          return (
            <div key={i} className={`flex items-center gap-2 text-xs flex-wrap ${isUrgent ? 'text-red-700' : 'text-orange-700'}`}>
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                isUrgent ? 'bg-red-200 text-red-800' : 'bg-orange-100 text-orange-700'
              }`}>
                {`あと${diffDays}日`}
              </span>
              <span className="font-medium">{r.name}</span>
              {visa && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${visa.cls}`}>
                  {visa.label}
                </span>
              )}
              {!visa && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${r.org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                  {r.org === 'hfu' ? 'HFU' : '日比'}
                </span>
              )}
              <span className="tabular-nums">{r.retired} 退職</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

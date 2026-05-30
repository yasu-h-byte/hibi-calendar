/**
 * 翌月カレンダー未確定アラート（attendance/page.tsx から抽出）
 *
 * 月末1週間前を過ぎたら、翌月の就業カレンダーが全現場 approved に
 * なっているかを横断チェックし、未確定がある場合バナーで警告。
 *
 * 赤=未作成/draft/rejected（要対応）、黄=submitted（承認待ち）、緑=approved。
 * 全 approved の場合は親側で null を渡す → 何も表示しない。
 */
'use client'

export interface NextMonthCalCheck {
  ym: string  // "YYYY-MM"
  daysToMonthEnd: number
  sites: { siteId: string; siteName: string; status: string | null }[]
}

interface Props {
  check: NextMonthCalCheck | null
}

export default function NextMonthCalendarBanner({ check }: Props) {
  if (!check) return null
  const sites = check.sites
  const redSites = sites.filter(s => !s.status || s.status === 'draft' || s.status === 'rejected')
  const yellowSites = sites.filter(s => s.status === 'submitted')
  const greenSites = sites.filter(s => s.status === 'approved')
  // 全て approved なら表示しない
  if (redSites.length === 0 && yellowSites.length === 0) return null
  const isUrgent = redSites.length > 0
  const [y, m] = check.ym.split('-')
  const ymLabel = `${y}年${parseInt(m, 10)}月`

  return (
    <div className={`${isUrgent ? 'bg-red-50 border-red-300' : 'bg-yellow-50 border-yellow-300'} border-2 rounded-xl px-4 py-3 text-sm shadow-sm`}>
      <div className={`flex items-center gap-2 font-bold mb-2 flex-wrap ${isUrgent ? 'text-red-800' : 'text-yellow-800'}`}>
        <span className="text-base">{isUrgent ? '🚨' : '⏳'}</span>
        <span>翌月（{ymLabel}）の就業カレンダー未確定</span>
        <span className="text-xs font-normal text-gray-600">
          月末まであと{check.daysToMonthEnd}日
        </span>
        {redSites.length > 0 && (
          <span className="text-xs bg-red-200 text-red-900 px-1.5 py-0.5 rounded-full">
            要作成 {redSites.length}件
          </span>
        )}
        {yellowSites.length > 0 && (
          <span className="text-xs bg-yellow-200 text-yellow-900 px-1.5 py-0.5 rounded-full">
            承認待ち {yellowSites.length}件
          </span>
        )}
        {greenSites.length > 0 && (
          <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
            確定済 {greenSites.length}件
          </span>
        )}
        <a
          href="/calendar"
          className={`ml-auto text-xs underline ${isUrgent ? 'text-red-700 hover:text-red-900' : 'text-yellow-700 hover:text-yellow-900'}`}
        >
          カレンダー画面へ →
        </a>
      </div>
      <div className="space-y-1">
        {redSites.map(s => (
          <div key={s.siteId} className="flex items-center gap-2 text-xs text-red-700 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-200 text-red-800">
              {!s.status ? '未作成' : s.status === 'rejected' ? '差戻し' : '作成中'}
            </span>
            <span className="font-medium">{s.siteName}</span>
          </div>
        ))}
        {yellowSites.map(s => (
          <div key={s.siteId} className="flex items-center gap-2 text-xs text-yellow-700 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-yellow-200 text-yellow-800">
              承認待ち
            </span>
            <span className="font-medium">{s.siteName}</span>
            <span className="text-[10px] text-yellow-600">職長提出済・最終承認待ち</span>
          </div>
        ))}
      </div>
    </div>
  )
}

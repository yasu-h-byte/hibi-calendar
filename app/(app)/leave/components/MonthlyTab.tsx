'use client'

import { OrgFilter, PLWorker } from '../types'

// 月別タブ: 会社別の月別有給取得日数マトリクス

interface Props {
  visible: boolean
  filteredWorkers: PLWorker[]
  orgFilter: OrgFilter
}

export default function MonthlyTab({ visible, filteredWorkers, orgFilter }: Props) {
  if (!visible) return null

  // 月カラムは「filteredWorkers 全体で消化があった月」を集計（両組で揃える）
  const allMonths = new Set<string>()
  filteredWorkers.forEach(w => {
    if (w.monthlyUsage) Object.keys(w.monthlyUsage).forEach(m => {
      if ((w.monthlyUsage[m] || 0) > 0) allMonths.add(m)
    })
  })
  const months = [...allMonths].sort()

  // 会社ごとにグルーピング（消化記録がない人も含めて全員表示）
  // 行が空にならないよう「対象期に有給が付与されている人 = grantDays > 0」を表示対象にする
  const allEligibleWorkers = filteredWorkers.filter(w => w.grantDays > 0 || (w.carryOver ?? 0) > 0)
  const hibiWorkers = allEligibleWorkers.filter(w => w.org !== 'hfu')
  const hfuWorkers = allEligibleWorkers.filter(w => w.org === 'hfu')

  // 全表で誰一人もいない場合のみ全体非表示
  if (allEligibleWorkers.length === 0) return null

  const renderTable = (
    orgKey: 'hibi' | 'hfu',
    orgLabel: string,
    orgBadgeColor: string,
    targetWorkers: typeof allEligibleWorkers,
  ) => {
    if (targetWorkers.length === 0) {
      return (
        <div key={orgKey} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${orgBadgeColor}`}>{orgLabel}</span>
            <h2 className="text-base font-bold text-hibi-navy dark:text-white">月別 有給取得日数</h2>
          </div>
          <div className="text-sm text-gray-400 dark:text-gray-500">対象スタッフがいません</div>
        </div>
      )
    }

    const orgTotalByMonth: Record<string, number> = {}
    months.forEach(m => {
      orgTotalByMonth[m] = targetWorkers.reduce((s, w) => s + (w.monthlyUsage?.[m] || 0), 0)
    })
    const orgGrandTotal = Object.values(orgTotalByMonth).reduce((s, n) => s + n, 0)

    return (
      <div key={orgKey} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${orgBadgeColor}`}>{orgLabel}</span>
          <h2 className="text-base font-bold text-hibi-navy dark:text-white">月別 有給取得日数</h2>
          <span className="text-xs text-gray-500 ml-1">（{targetWorkers.length}名）</span>
        </div>
        {months.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-gray-500">この期間の有給取得記録はありません</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700">
                  <th className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-300 border-b sticky left-0 bg-gray-50 dark:bg-gray-700 z-10">名前</th>
                  {months.map(m => (
                    <th key={m} className="px-2 py-2 text-center font-medium text-gray-600 dark:text-gray-300 border-b whitespace-nowrap">
                      {m.slice(0, 4)}/{m.slice(4)}月
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center font-bold text-gray-700 dark:text-gray-200 border-b border-l-2 border-gray-300">計</th>
                </tr>
              </thead>
              <tbody>
                {targetWorkers.map(w => {
                  const total = w.monthlyUsage ? Object.values(w.monthlyUsage).reduce((s, n) => s + n, 0) : 0
                  return (
                    <tr key={w.id} className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-3 py-2 font-medium whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800 z-10">{w.name}</td>
                      {months.map(m => {
                        const val = w.monthlyUsage?.[m] || 0
                        return (
                          <td key={m} className={`px-2 py-2 text-center tabular-nums ${val > 0 ? 'font-bold text-green-700' : 'text-gray-300'}`}>
                            {val > 0 ? val : '-'}
                          </td>
                        )
                      })}
                      <td className={`px-3 py-2 text-center font-bold tabular-nums border-l-2 border-gray-300 ${total > 0 ? 'text-hibi-navy' : 'text-gray-300'}`}>
                        {total > 0 ? total : '-'}
                      </td>
                    </tr>
                  )
                })}
                {/* 会社合計行 */}
                <tr className="bg-gray-100 dark:bg-gray-700/50 font-bold">
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200 sticky left-0 bg-gray-100 dark:bg-gray-700/50 z-10">合計</td>
                  {months.map(m => (
                    <td key={m} className={`px-2 py-2 text-center tabular-nums ${orgTotalByMonth[m] > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                      {orgTotalByMonth[m] > 0 ? orgTotalByMonth[m] : '-'}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center tabular-nums border-l-2 border-gray-300 text-hibi-navy">{orgGrandTotal}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {(orgFilter === 'all' || orgFilter === 'hibi') && renderTable('hibi', '日比建設', 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200', hibiWorkers)}
      {(orgFilter === 'all' || orgFilter === 'hfu') && renderTable('hfu', 'HFU', 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-200', hfuWorkers)}
    </div>
  )
}

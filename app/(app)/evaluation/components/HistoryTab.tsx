'use client'
/** 履歴タブ（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { rankColor } from '@/lib/evaluation-view'
import type { EvaluationPageCtx } from '../useEvaluationPage'

export function HistoryTab({ ctx }: { ctx: EvaluationPageCtx }) {
  const { evaluations, photos, setDetailSessionId, historyYear, setHistoryYear } = ctx
  return (
    <>
      <div className="space-y-4">
        {(() => {
          const approved = evaluations.filter(e => e.status === 'approved')
          const years = Array.from(new Set(approved.map(e => e.evaluationDate.slice(0, 4)))).sort().reverse()
          const filtered = historyYear === 'all'
            ? approved
            : approved.filter(e => e.evaluationDate.startsWith(historyYear))
          const sorted = filtered.sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))
          return (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">承認済み評価履歴</h2>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 dark:text-gray-400">年で絞り込み:</label>
                  <select
                    value={historyYear}
                    onChange={e => setHistoryYear(e.target.value)}
                    className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-900 dark:text-white"
                  >
                    <option value="all">すべて</option>
                    {years.map(y => (
                      <option key={y} value={y}>{y}年</option>
                    ))}
                  </select>
                </div>
              </div>

              {sorted.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400 dark:text-gray-500">
                  承認済みの評価がありません
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                      <thead className="bg-gray-50 dark:bg-gray-900">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">名前</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">評価日</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">勤続</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">合計</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ランク</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">推奨昇給</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">承認日</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                        {sorted.map(s => (
                          <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                            <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
                              <WorkerAvatar name={s.workerName} src={photos[String(s.workerId)]} size={28} className="mr-2" />{s.workerName}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">{s.evaluationDate}</td>
                            <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300 whitespace-nowrap">{s.yearsFromHire}年</td>
                            <td className="px-4 py-3 text-sm text-center text-gray-700 dark:text-gray-200 whitespace-nowrap font-medium">{s.totalScore?.toFixed(1) ?? '--'}</td>
                            <td className="px-4 py-3 text-center whitespace-nowrap">
                              {s.rank ? (
                                <span className={`text-lg font-bold ${rankColor(s.rank)}`}>{s.rank}</span>
                              ) : '--'}
                            </td>
                            <td className="px-4 py-3 text-sm text-center whitespace-nowrap">
                              {s.raiseAmount != null && s.raiseAmount > 0 ? (
                                <span className="text-green-600 dark:text-green-400 font-medium">+{s.raiseAmount}円</span>
                              ) : (
                                <span className="text-gray-400">--</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                              {s.approvedAt ? new Date(s.approvedAt).toLocaleDateString('ja-JP') : '--'}
                            </td>
                            <td className="px-4 py-3 text-center whitespace-nowrap">
                              <button
                                onClick={() => setDetailSessionId(s.id)}
                                className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                              >
                                詳細
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                    合計 {sorted.length} 件
                  </div>
                </div>
              )}
            </>
          )
        })()}
      </div>
    </>
  )
}

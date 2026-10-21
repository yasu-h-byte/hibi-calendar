'use client'
/** 進捗監視タブ（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { computePrefillScores, daysSince } from '@/lib/evaluation-view'
import type { EvaluationPageCtx } from '../useEvaluationPage'
import { EvaluatorBadgeList } from './EvaluatorBadgeList'

export function MonitorTab({ ctx }: { ctx: EvaluationPageCtx }) {
  const { setActiveTab, evaluations, photos, setApproveSessionId, setFinalScores, setFinalComment, setDetailSessionId, collecting, reviewing } = ctx
  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">進行中の評価セッション</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            ※ 収集中のセッションを横並びで確認できます
          </p>
        </div>
        {(() => {
          const inProgress = evaluations
            .filter(e => e.status !== 'approved')
            .sort((a, b) => {
              // reviewing を先頭に、次に古い createdAt 順（停滞しているもの優先）
              if (a.status !== b.status) return a.status === 'reviewing' ? -1 : 1
              return (a.createdAt || '').localeCompare(b.createdAt || '')
            })
          if (inProgress.length === 0) {
            return (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400 dark:text-gray-500">
                進行中の評価セッションはありません
              </div>
            )
          }
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {inProgress.map(s => {
                const total = s.evaluatorIds.length
                const submitted = new Set(s.reviews.map(r => r.evaluatorId)).size
                const ageDays = daysSince(s.createdAt)
                const isStale = ageDays >= 7 && s.status === 'collecting'
                const isReviewing = s.status === 'reviewing'
                return (
                  <div
                    key={s.id}
                    className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4 border-l-4 ${
                      isReviewing
                        ? 'border-amber-400'
                        : isStale
                        ? 'border-orange-400'
                        : 'border-blue-400'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2 flex-wrap gap-2">
                      <div className="flex items-center gap-3">
                        <WorkerAvatar name={s.workerName} src={photos[String(s.workerId)]} size={40} />
                        <div>
                        <h3 className="font-bold text-gray-900 dark:text-white">{s.workerName}</h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          評価日: {s.evaluationDate}
                          <span className="ml-2">
                            開始: {s.createdAt ? new Date(s.createdAt).toLocaleDateString('ja-JP') : '--'}
                            {ageDays > 0 && (
                              <span className={isStale ? 'text-orange-600 dark:text-orange-400 font-medium ml-1' : 'ml-1'}>
                                ({ageDays}日経過)
                              </span>
                            )}
                          </span>
                        </p>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          isReviewing
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                        }`}
                      >
                        {isReviewing ? '最終確認待ち' : `収集中 ${submitted}/${total}`}
                      </span>
                    </div>
                    <EvaluatorBadgeList ctx={ctx} session={s} />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        onClick={() => setDetailSessionId(s.id)}
                        className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        詳細
                      </button>
                      {isReviewing && (
                        <button
                          onClick={() => {
                            setApproveSessionId(s.id)
                            setFinalScores(computePrefillScores(s))
                            setFinalComment('')
                            setActiveTab('approve')
                          }}
                          className="px-3 py-1 text-xs font-medium rounded-lg bg-green-500 text-white hover:bg-green-600"
                        >
                          承認へ
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}
      </div>
    </>
  )
}

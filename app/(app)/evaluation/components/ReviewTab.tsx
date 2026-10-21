'use client'
/** 評価入力タブ（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { EVALUATOR_COLORS, EVAL_ITEMS, VISA_LABELS, getScoreValue, isCategoryInScope, sessionStatusLabel } from '@/lib/evaluation-view'
import { yearsFromHire as yearsFromDate } from '@/lib/evaluation-config'
import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'
import { ABCRadio } from '@/components/evaluation/ABCRadio'
import { ABCGrade } from '@/types'
import { CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import { GradeBadge } from '@/components/evaluation/GradeBadge'
import type { EvaluationPageCtx } from '../useEvaluationPage'

export function ReviewTab({ ctx }: { ctx: EvaluationPageCtx }) {
  const { authUser, workers, photos, selectedWorkerId, setSelectedWorkerId, myReview, setMyReview, myComment, setMyComment, hasSubmitted, isEditing, setIsEditing, isAdminOnly, syncMyReviewFromSaved, reviewableWorkers, reviewSession, handleSubmitReview, reviewCalc } = ctx
  return (
    <>
      <div className="space-y-6">
        {/* Worker selector */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            対象スタッフ
          </label>
          <select
            value={selectedWorkerId ?? ''}
            onChange={e => setSelectedWorkerId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
          >
            <option value="">選択してください</option>
            {reviewableWorkers.map(w => (
              <option key={w.id} value={w.id}>
                {w.name} ({VISA_LABELS[w.visaType] || w.visaType})
              </option>
            ))}
          </select>
          {reviewableWorkers.length === 0 && (
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              あなたが評価者として割り当てられたセッションがありません
            </p>
          )}
        </div>

        {selectedWorkerId && reviewSession && (
          <>
            {/* Worker info */}
            {(() => {
              const sw = workers.find(w => w.id === selectedWorkerId)
              if (!sw) return null
              const years = sw.hireDate ? yearsFromDate(sw.hireDate) : 1
              return (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">スタッフ情報</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">名前</span>
                      <span className="font-medium text-gray-900 dark:text-white inline-flex items-center gap-2">
                        <WorkerAvatar name={sw.name} src={photos[String(sw.id)]} size={40} />{sw.name}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">在留資格</span>
                      <span className="text-gray-900 dark:text-white">{VISA_LABELS[sw.visaType] || sw.visaType}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">入社日</span>
                      <span className="text-gray-900 dark:text-white">{sw.hireDate || '--'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">勤続年数</span>
                      <span className="text-gray-900 dark:text-white">{years}年</span>
                    </div>
                    {/* 時給は評価管理画面では非表示（運用方針） */}
                  </div>
                </div>
              )
            })()}

            {/* Session status */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-gray-500 dark:text-gray-400">セッション状況: </span>
                  {(() => {
                    const st = sessionStatusLabel(
                      reviewSession.status,
                      reviewSession.reviews || [],
                      reviewSession.evaluatorIds || [],
                    )
                    return (
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>
                        {st.text}
                      </span>
                    )
                  })()}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  評価者: {reviewSession.evaluatorIds.length}名
                </div>
              </div>
            </div>

            {/* If not submitted or editing: show ABC input form */}
            {(!hasSubmitted || isEditing) && (
              <>
                {/* Attendance metrics */}
                {reviewSession.metrics && (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">出勤実績（過去1年）</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率</span>
                        <span className="font-medium text-gray-900 dark:text-white">{reviewSession.metrics.attendanceRate.toFixed(1)}%</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                        <span className="text-gray-900 dark:text-white">{reviewSession.metrics.overtimeAvg.toFixed(1)}h/月</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">有給取得</span>
                        <span className="text-gray-900 dark:text-white">{reviewSession.metrics.plUsage}日</span>
                      </div>
                      <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率ボーナス</span>
                        <span className="font-bold text-blue-600 dark:text-blue-400">+{reviewSession.metrics.attendanceBonus}点</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* ABC sections — generated from EVALUATION_CATEGORIES
                   2026-05-12 スコープ分担:
                     - 靖仁さん (isAdminOnly=true): 生活態度のみ
                     - その他評価者: 日本語/勤務態度/職業能力（生活態度は非表示） */}
                <div className="space-y-4">
                  {EVALUATION_CATEGORIES.filter(cat => isAdminOnly ? cat.key === 'living' : cat.key !== 'living').map(cat => {
                    const bgColor = cat.color === 'blue' ? 'bg-blue-500' : cat.color === 'green' ? 'bg-green-500' : cat.color === 'teal' ? 'bg-teal-500' : 'bg-orange-500'
                    const catScores = myReview[cat.key]
                    return (
                      <div key={cat.key} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                        <div className={`${bgColor} px-4 py-2`}>
                          <h3 className="text-white font-bold text-sm">
                            {cat.icon} {cat.label} (重み {cat.weightLabel}{cat.key === 'attitude' ? ' — 最重要' : ''})
                          </h3>
                        </div>
                        <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-700">
                          {cat.criteria.map(c => (
                            <ABCRadio
                              key={c.key}
                              label={c.label}
                              value={(catScores as Record<string, ABCGrade>)[c.key]}
                              onChange={v => setMyReview(prev => ({
                                ...prev,
                                [cat.key]: { ...prev[cat.key], [c.key]: v }
                              }))}
                              descA={c.A}
                              descB={c.B}
                              descC={c.C}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Comment */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    コメント
                  </label>
                  <textarea
                    value={myComment}
                    onChange={e => setMyComment(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                    placeholder="評価に関するコメントを入力..."
                  />
                </div>

                {/* Score preview — 担当カテゴリのみ表示 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                    スコアプレビュー
                    <span className="ml-2 text-2xs font-normal text-gray-500">
                      （あなたの担当カテゴリの合計のみ表示）
                    </span>
                  </h3>
                  <div className="space-y-1 text-sm">
                    {!isAdminOnly && (
                      <>
                        <div className="flex justify-between text-gray-600 dark:text-gray-300">
                          <span>日本語: {reviewCalc.japanese}点 x1.0</span>
                          <span className="font-medium">= {reviewCalc.japaneseW.toFixed(1)}</span>
                        </div>
                        <div className="flex justify-between text-gray-600 dark:text-gray-300">
                          <span>勤務態度: {reviewCalc.attitude}点 x1.5</span>
                          <span className="font-medium">= {reviewCalc.attitudeW.toFixed(1)}</span>
                        </div>
                        <div className="flex justify-between text-gray-600 dark:text-gray-300">
                          <span>職業能力: {reviewCalc.skill}点 x1.0</span>
                          <span className="font-medium">= {reviewCalc.skillW.toFixed(1)}</span>
                        </div>
                      </>
                    )}
                    {isAdminOnly && (
                      <div className="flex justify-between text-gray-600 dark:text-gray-300">
                        <span>生活態度: {reviewCalc.living}点 x1.0</span>
                        <span className="font-medium">= {reviewCalc.livingW.toFixed(1)}</span>
                      </div>
                    )}
                    <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                      <div className="flex justify-between text-gray-900 dark:text-white font-bold">
                        <span>担当部分合計: {(isAdminOnly ? reviewCalc.livingW : reviewCalc.japaneseW + reviewCalc.attitudeW + reviewCalc.skillW).toFixed(1)}点</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Submit button */}
                <div className="flex gap-3 justify-end">
                  {isEditing && <CancelButton onClick={syncMyReviewFromSaved} />}
                  <SaveButton
                    action="提出"
                    label={isEditing ? '再提出する' : undefined}
                    onSave={async () => { const r = await handleSubmitReview(); if (r !== true) return r }}
                  />
                </div>
              </>
            )}

            {/* If submitted and not editing: show read-only view */}
            {hasSubmitted && !isEditing && (
              <div className="space-y-4">
                <div className="bg-green-50 dark:bg-green-900/30 border-2 border-green-300 dark:border-green-700 rounded-xl p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-12 h-12 rounded-full bg-green-500 dark:bg-green-600 flex items-center justify-center text-white text-2xl font-bold shadow">
                        ✓
                      </div>
                      <div>
                        <p className="text-base font-bold text-green-800 dark:text-green-200">
                          {reviewSession.workerName} さんの評価を提出済みです
                        </p>
                        {(() => {
                          const my = reviewSession.reviews.find(r => r.evaluatorId === authUser?.workerId)
                          if (!my?.submittedAt) return null
                          return (
                            <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                              {new Date(my.submittedAt).toLocaleString('ja-JP')} に保存完了
                            </p>
                          )
                        })()}
                      </div>
                    </div>
                    <button
                      onClick={() => setIsEditing(true)}
                      className="px-4 py-2 text-sm font-medium rounded-lg border-2 border-green-400 dark:border-green-600 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50 transition-colors"
                    >
                      修正する
                    </button>
                  </div>
                </div>

                {/* My submitted review (read-only) */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">自分の評価</h3>
                  <div className="space-y-2">
                    {/* 自分の担当カテゴリの項目のみ表示 */}
                    {EVAL_ITEMS.filter(item => authUser && isCategoryInScope(authUser.workerId, item.category)).map(item => (
                      <div key={`${item.category}_${item.key}`} className="flex items-center justify-between py-1">
                        <span className="text-sm text-gray-600 dark:text-gray-300">{item.label}</span>
                        <GradeBadge grade={getScoreValue(myReview, item.category, item.key)} />
                      </div>
                    ))}
                  </div>
                  {myComment && (
                    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                      <p className="text-xs text-gray-500 dark:text-gray-400">コメント:</p>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{myComment}</p>
                    </div>
                  )}
                </div>

                {/* Other evaluators' reviews (only visible after submitting own) */}
                {reviewSession.reviews.filter(r => r.evaluatorId !== authUser?.workerId).length > 0 && (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">他の評価者の結果</h3>
                    <div className="space-y-4">
                      {reviewSession.reviews
                        .filter(r => r.evaluatorId !== authUser?.workerId)
                        .map((review, idx) => (
                          <div key={review.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                            <p className={`text-sm font-medium mb-2 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                              {review.evaluatorName}
                            </p>
                            <div className="space-y-1">
                              {/* 当該評価者の担当カテゴリのみ表示 */}
                              {EVAL_ITEMS.filter(item => isCategoryInScope(review.evaluatorId, item.category)).map(item => (
                                <div key={`${review.evaluatorId}_${item.category}_${item.key}`} className="flex items-center justify-between py-0.5">
                                  <span className="text-xs text-gray-600 dark:text-gray-300">{item.label}</span>
                                  <GradeBadge grade={getScoreValue(review.scores, item.category, item.key)} />
                                </div>
                              ))}
                            </div>
                            {review.comment && (
                              <p className="mt-2 text-xs text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-gray-600 pt-2">
                                {review.comment}
                              </p>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Pending evaluators */}
                {(() => {
                  const submittedIds = (reviewSession.reviews || []).map(r => r.evaluatorId)
                  const pending = reviewSession.evaluatorIds.filter(id => !submittedIds.includes(id))
                  if (pending.length === 0) return null
                  return (
                    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                      <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">未提出の評価者</h3>
                      <div className="flex flex-wrap gap-2">
                        {pending.map(id => {
                          const w = workers.find(w2 => w2.id === id)
                          return (
                            <span key={id} className="inline-block px-2 py-1 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                              {w?.name || `ID:${id}`}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}
          </>
        )}

        {!selectedWorkerId && (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">
            対象スタッフを選択してください
          </div>
        )}

        {selectedWorkerId && !reviewSession && (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">
            このスタッフのアクティブな評価セッションがありません
          </div>
        )}
      </div>
    </>
  )
}

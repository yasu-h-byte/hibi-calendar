'use client'
/** 承認タブ（最終評価）（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { EVALUATOR_COLORS, EVAL_ITEMS, VISA_LABELS, computePrefillScores, getScoreValue, isCategoryInScope, rankColor, setScoreValue } from '@/lib/evaluation-view'
import { applyLegalWageFloor, calculateManualScore, calculateRank, getRaiseAmount } from '@/lib/evaluation-config'
import { yearsFromHire as yearsFromDate } from '@/lib/evaluation-config'
import { minWageAt } from '@/lib/wage-analysis'
import { todayJstIso } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { GradeBadge } from '@/components/evaluation/GradeBadge'
import { ABCGrade } from '@/types'
import { CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import type { EvaluationPageCtx } from '../useEvaluationPage'

export function ApproveTab({ ctx }: { ctx: EvaluationPageCtx }) {
  const { workers, evaluations, photos, approveSessionId, setApproveSessionId, finalScores, setFinalScores, finalComment, setFinalComment, handleApprove, reviewing } = ctx
  return (
    <>
      <div className="space-y-6">
        {/* Sessions in reviewing status */}
        {!approveSessionId && (
          <>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">最終確認待ち</h2>
            {evaluations.filter(e => e.status === 'reviewing').length === 0 ? (
              <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                全員提出済みの評価セッションがありません
              </div>
            ) : (
              <div className="space-y-3">
                {evaluations
                  .filter(e => e.status === 'reviewing')
                  .map(session => (
                    <div key={session.id} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={40} />
                        <div>
                        <p className="font-medium text-gray-900 dark:text-white">{session.workerName}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          評価日: {session.evaluationDate} / {session.reviews.length}名が提出
                        </p>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setApproveSessionId(session.id)
                          setFinalScores(computePrefillScores(session))
                          setFinalComment('')
                        }}
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
                        title="重み付き加重平均でプリフィル（A=3 B=2 C=1 の数値化→平均→ABC変換）"
                      >
                        確認・承認
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}

        {/* Approval detail view */}
        {approveSessionId && (() => {
          const session = evaluations.find(e => e.id === approveSessionId)
          if (!session) return null
          const worker = workers.find(w => w.id === session.workerId)
          // 2026-09-14: サーバの確定値と同じ年で引く（セッション保存値）
          const years = session.yearsFromHire || (worker?.hireDate ? yearsFromDate(worker.hireDate) : 1)

          // Calculate final score preview
          const finalCalc = calculateManualScore(finalScores)
          const bonus = session.metrics?.attendanceBonus ?? 0
          const totalScore = finalCalc.total + bonus
          const rank = calculateRank(totalScore)
          // 法令フロア（最賃×1.0 / 特定技能は×1.1）を適用したプレビュー。
          // 確定値はサーバ側が同じロジックで再計算する
          const floorPreview = applyLegalWageFloor({
            baseRaise: getRaiseAmount(rank, years, worker?.hourlyRate),
            currentHourlyRate: worker?.hourlyRate,
            visa: worker?.visaType,
            minWage: minWageAt(todayJstIso()),
          })
          const raiseAmount = floorPreview.raiseAmount

          return (
            <div className="space-y-6">
              {/* Back button */}
              <button
                onClick={() => setApproveSessionId(null)}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                &larr; 一覧に戻る
              </button>

              {/* Worker info */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-3">
                  <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={48} />
                  {session.workerName} の評価
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">在留資格</span>
                    <span className="text-gray-900 dark:text-white">{VISA_LABELS[worker?.visaType || ''] || worker?.visaType}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">入社日</span>
                    <span className="text-gray-900 dark:text-white">{worker?.hireDate || '--'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400 block text-xs">勤続年数</span>
                    <span className="text-gray-900 dark:text-white">{years}年</span>
                  </div>
                  {/* 時給は評価管理画面では非表示（運用方針） */}
                </div>
              </div>

              {/* Comparison table */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300">評価者比較</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 w-32">
                          項目
                        </th>
                        {session.reviews.map((review, idx) => {
                          const w = session.evaluatorWeights?.[review.evaluatorId]
                          return (
                            <th
                              key={review.evaluatorId}
                              className={`px-3 py-3 text-center text-xs font-medium text-white border-b border-gray-200 dark:border-gray-700 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].header}`}
                            >
                              <div>{review.evaluatorName}</div>
                              {w && (
                                <div className="mt-1 text-3xs font-normal opacity-90">
                                  {w.isApprover ? (
                                    <span title={`事業責任者の固定ウェイト (${w.weight.toFixed(2)})`}>w={w.weight.toFixed(2)} <Icon name="star" size={9} className="inline" /></span>
                                  ) : (
                                    <span title={`過去365日 共働 ${w.yearDays}日 (うち直近90日 ${w.recentDays}日)`}>
                                      w={w.weight.toFixed(2)}
                                      <span className="block opacity-80">年共働 {w.yearPct}% ({w.yearDays}日)</span>
                                    </span>
                                  )}
                                </div>
                              )}
                            </th>
                          )
                        })}
                        <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1">
                        </th>
                        <th className="px-3 py-3 text-center text-xs font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 min-w-[140px]">
                          最終評価
                          {session.evaluatorWeights && (
                            <div className="text-3xs font-normal opacity-70 mt-0.5">（重み付き加重平均）</div>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {EVAL_ITEMS.map((item, rowIdx) => {
                        // 担当外評価者を除外して「一致 / 分かれ」を判定（2026-05-12 スコープ反映）
                        const inScopeGrades = session.reviews
                          .filter(r => isCategoryInScope(r.evaluatorId, item.category))
                          .map(r => getScoreValue(r.scores, item.category, item.key))
                        const allSame = inScopeGrades.length > 0 && inScopeGrades.every(g => g === inScopeGrades[0])
                        const rowBg = rowIdx % 2 === 0 ? '' : 'bg-gray-50/50 dark:bg-gray-750/50'
                        return (
                          <tr key={`${item.category}_${item.key}`} className={rowBg}>
                            <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700">
                              <div className="flex items-center gap-1.5">
                                <span className={`inline-block w-2 h-2 rounded-full ${allSame ? 'bg-green-400' : 'bg-yellow-400'}`} />
                                {item.label}
                              </div>
                            </td>
                            {session.reviews.map(review => {
                              const inScope = isCategoryInScope(review.evaluatorId, item.category)
                              return (
                                <td key={review.evaluatorId} className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700">
                                  {inScope ? (
                                    <GradeBadge grade={getScoreValue(review.scores, item.category, item.key)} />
                                  ) : (
                                    <span className="text-gray-300 dark:text-gray-600 text-lg" title="担当外（評価対象外）">─</span>
                                  )}
                                </td>
                              )
                            })}
                            <td className="border-b border-gray-100 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></td>
                            <td className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700 bg-indigo-50/50 dark:bg-indigo-900/20">
                              <div className="flex gap-1 justify-center">
                                {(['A', 'B', 'C'] as ABCGrade[]).map(g => {
                                  const current = getScoreValue(finalScores, item.category, item.key)
                                  const active = current === g
                                  let cls = 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                                  if (active && g === 'A') cls = 'bg-green-500 text-white'
                                  if (active && g === 'B') cls = 'bg-yellow-500 text-white'
                                  if (active && g === 'C') cls = 'bg-red-400 text-white'
                                  return (
                                    <button
                                      key={g}
                                      onClick={() => setFinalScores(prev => setScoreValue(prev, item.category, item.key, g))}
                                      className={`w-8 h-8 rounded-lg font-bold text-xs transition-all ${cls} hover:opacity-80 cursor-pointer`}
                                    >
                                      {g}
                                    </button>
                                  )
                                })}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Legend */}
                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-400" /> 全員一致
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" /> 意見分かれ
                  </span>
                </div>
              </div>

              {/* Evaluator comments */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">評価者コメント</h3>
                <div className="space-y-3">
                  {session.reviews.map((review, idx) => (
                    <div key={review.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                      <p className={`text-xs font-medium ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                        {review.evaluatorName}
                      </p>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                        {review.comment || '(コメントなし)'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Final comment */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  最終コメント（政仁さん）
                </label>
                <textarea
                  value={finalComment}
                  onChange={e => setFinalComment(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
                  placeholder="最終評価コメントを入力..."
                />
              </div>

              {/* Score preview */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">最終スコアプレビュー</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>日本語: {finalCalc.japanese}点 x1.0</span>
                    <span className="font-medium">= {finalCalc.japaneseW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>勤務態度: {finalCalc.attitude}点 x1.5</span>
                    <span className="font-medium">= {finalCalc.attitudeW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>職業能力: {finalCalc.skill}点 x1.0</span>
                    <span className="font-medium">= {finalCalc.skillW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600 dark:text-gray-300">
                    <span>生活態度: {finalCalc.living}点 x1.0</span>
                    <span className="font-medium">= {finalCalc.livingW.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between text-blue-600 dark:text-blue-400">
                    <span>出勤率ボーナス</span>
                    <span className="font-medium">+{bonus}点</span>
                  </div>
                  <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                    <div className="flex justify-between text-gray-900 dark:text-white font-bold">
                      <span>合計: {totalScore.toFixed(1)}点</span>
                      <span className={`text-lg ${rankColor(rank)}`}>ランク: {rank}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500 dark:text-gray-400 text-xs">
                        {years}年目テーブル適用
                      </span>
                      <span className="font-bold text-green-600 dark:text-green-400">
                        推奨昇給: +{raiseAmount}円/h
                      </span>
                    </div>
                    {floorPreview.floored && (
                      <div className="mt-1.5 text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg px-2.5 py-1.5">
                        法令下限により調整: テーブル値 +{floorPreview.baseRaise}円 では下限時給
                        {floorPreview.legalMinRate}円（最低賃金{worker?.visaType?.startsWith('tokutei') ? '×1.1（建設特定技能の認定要件）' : ''}）を
                        下回るため、+{raiseAmount}円 に底上げされます
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Approve button */}
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={() => setApproveSessionId(null)}>戻る</CancelButton>
                <SaveButton
                  action="承認"
                  onSave={async () => { const r = await handleApprove(); if (r !== true) return r }}
                />
              </div>
            </div>
          )
        })()}
      </div>
    </>
  )
}

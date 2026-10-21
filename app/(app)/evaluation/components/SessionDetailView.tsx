'use client'
/** 評価セッションの詳細（比較表・コメント・最終結果）（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import WorkerAvatar from '@/components/WorkerAvatar'
import { Evaluation } from '@/types'
import { yearsFromHire as yearsFromDate } from '@/lib/evaluation-config'
import { EVALUATOR_COLORS, EVAL_ITEMS, VISA_LABELS, daysSince, evaluatorNameLookup, fmtDateShort, getScoreValue, isCategoryInScope, rankColor } from '@/lib/evaluation-view'
import { Icon } from '@/components/ui/Icon'
import { GradeBadge } from '@/components/evaluation/GradeBadge'
import type { EvaluationPageCtx } from '../useEvaluationPage'
import { EvaluatorBadgeList } from './EvaluatorBadgeList'

export function SessionDetailView({ ctx, session }: { ctx: EvaluationPageCtx; session: Evaluation }) {
  const { workers, apiEvaluators, photos, finalScores, finalComment, recalculatingWeights, handleRecalculateWeights, handleRecalculateMetrics, isAdmin, collecting, reviewing } = ctx
    const worker = workers.find(w => w.id === session.workerId)
    const years = worker?.hireDate ? yearsFromDate(worker.hireDate) : 1
    const submittedSet = new Set(session.reviews.map(r => r.evaluatorId))
    const pendingIds = session.evaluatorIds.filter(id => !submittedSet.has(id))

    return (
      <div className="space-y-4">
        {/* ヘッダー */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <WorkerAvatar name={session.workerName} src={photos[String(session.workerId)]} size={56} />
              <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {session.workerName}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                評価日: {session.evaluationDate}
                {session.approvedAt && ` / 承認日時: ${new Date(session.approvedAt).toLocaleString('ja-JP')}`}
              </p>
              </div>
            </div>
            <div className="text-right flex items-center gap-2">
              {session.status === 'approved' && (
                <a
                  href={`/evaluation/${session.id}/print`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-900 text-white inline-flex items-center gap-1"
                  title="A4 1枚で評価表を印刷"
                >A4印刷</a>
              )}
              {session.status === 'approved' && session.rank && (
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-gray-500">ランク</span>
                  <span className={`text-3xl font-bold ${rankColor(session.rank)}`}>
                    {session.rank}
                  </span>
                </div>
              )}
              {session.status === 'reviewing' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  最終確認待ち
                </span>
              )}
              {session.status === 'collecting' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  {session.reviews.length}/{session.evaluatorIds.length}名 提出
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-sm">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">在留資格</span>
              <span className="text-gray-900 dark:text-white">
                {VISA_LABELS[worker?.visaType || ''] || worker?.visaType || '--'}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">入社日</span>
              <span className="text-gray-900 dark:text-white">{worker?.hireDate || '--'}</span>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">勤続年数</span>
              <span className="text-gray-900 dark:text-white">{years}年</span>
            </div>
            {session.status === 'approved' && session.totalScore != null && (
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">合計スコア</span>
                <span className="font-bold text-gray-900 dark:text-white">
                  {session.totalScore.toFixed(1)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 提出状況 */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
          <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">提出状況</h4>
          <EvaluatorBadgeList ctx={ctx} session={session} />
          {pendingIds.length > 0 && session.status !== 'approved' && (
            <p className="text-xs text-orange-600 dark:text-orange-400 mt-2">
              {pendingIds.length}名の提出待ち
              {daysSince(session.createdAt) >= 7 && `（開始から${daysSince(session.createdAt)}日経過）`}
            </p>
          )}
        </div>

        {/* 評価者ウェイト */}
        {(session.evaluatorWeights || isAdmin) && session.status !== 'approved' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                評価者ウェイト
                <span className="ml-2 text-2xs font-normal text-gray-500">
                  共働実績ベース（直近1年）：加重平均プリフィルで重みが効きます
                </span>
              </h4>
              {isAdmin && (
                <button
                  onClick={() => handleRecalculateWeights(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-2xs font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  {recalculatingWeights ? '...' : '再計算'}
                </button>
              )}
            </div>
            {session.evaluatorWeights ? (
              <>
                {/* 動的キャップ情報 (2026-05-12 追加) */}
                {(() => {
                  const anyW = Object.values(session.evaluatorWeights || {}).find(w => w?.monthsWithData != null)
                  if (!anyW) return null
                  return (
                    <div className="mb-2 text-2xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 rounded-md">
                      データのある月数: <strong>{anyW.monthsWithData}/12</strong> ヶ月
                      → 年共働キャップ: <strong>{anyW.dynamicCap}日</strong>
                      <span className="ml-2 opacity-80">
                        （旧システム稼働前の月はデータが少ないため、データのある月数で按分しキャップを縮小。
                        主担当職長が短期間でも適正なウェイトを得られるよう調整）
                      </span>
                      <div className="mt-1 opacity-80">
                        共働日 ＝ 対象スタッフの出勤日のうち「評価者が同じ現場に同じ日に出勤した日」または「評価者がその月の職長だった現場の日」（2026-09-10 から出面ベース）
                      </div>
                    </div>
                  )
                })()}
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-gray-500 dark:text-gray-400">評価者</th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="参考表示（ウェイトには影響しない）">直近90日<span className="text-3xs opacity-60 ml-0.5">(参考)</span></th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400" title="ウェイト算出の根拠">過去365日<span className="text-3xs opacity-60 ml-0.5">(主)</span></th>
                      <th className="px-2 py-1 text-right font-medium text-gray-500 dark:text-gray-400">ウェイト</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {session.evaluatorIds.map(eid => {
                      const w = session.evaluatorWeights![eid]
                      const name = evaluatorNameLookup(eid, apiEvaluators, workers)
                      if (!w) {
                        return (
                          <tr key={eid}>
                            <td className="px-2 py-1 text-gray-700 dark:text-gray-300">{name}</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                            <td className="px-2 py-1 text-right text-gray-400">--</td>
                          </tr>
                        )
                      }
                      const weightBarPct = Math.round(w.weight * 100)
                      const barColor = w.isApprover
                        ? 'bg-purple-400'
                        : w.weight >= 0.8
                        ? 'bg-green-400'
                        : w.weight >= 0.5
                        ? 'bg-blue-400'
                        : 'bg-gray-400'
                      return (
                        <tr key={eid}>
                          <td className="px-2 py-1 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            {name}
                            {w.isApprover && <span className="ml-1 inline-flex align-middle text-purple-600 dark:text-purple-400" title="事業責任者"><Icon name="star" size={11} /></span>}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                            {w.isApprover ? '―' : `${w.recentPct}% (${w.recentDays}日)`}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                            {w.isApprover ? '―' : `${w.yearPct}% (${w.yearDays}日)`}
                          </td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                <div className={`h-full ${barColor}`} style={{ width: `${weightBarPct}%` }} />
                              </div>
                              <span className="font-bold tabular-nums w-10 text-right">{w.weight.toFixed(2)}</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                ウェイト未計算（旧形式セッション）。{isAdmin && '右上の「再計算」ボタンで算出できます。'}
              </p>
            )}
          </div>
        )}

        {/* 出席指標（詳細内訳付き） */}
        {session.metrics && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                出勤実績（過去1年）
                {session.metrics.computedAt && (
                  <span className="ml-2 text-2xs font-normal text-gray-500">
                    （{new Date(session.metrics.computedAt).toLocaleString('ja-JP')} 計算）
                  </span>
                )}
              </h4>
              {isAdmin && session.status !== 'approved' && (
                <button
                  onClick={() => handleRecalculateMetrics(session.id)}
                  disabled={recalculatingWeights}
                  className="px-2 py-1 text-2xs font-medium rounded-md border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 disabled:opacity-50"
                >
                  再計算
                </button>
              )}
            </div>

            {/* サマリー */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率</span>
                <span className="font-bold text-lg text-gray-900 dark:text-white">{session.metrics.attendanceRate.toFixed(1)}%</span>
                {session.metrics.rawRate != null && session.metrics.rawRate > 100 && (
                  <span className="ml-1 text-3xs text-gray-400" title="100%キャップ前の生比率">
                    (生 {session.metrics.rawRate.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">残業平均</span>
                <span className="text-gray-900 dark:text-white">{session.metrics.overtimeAvg.toFixed(1)}h/月</span>
                {session.metrics.totalOvertime != null && (
                  <span className="ml-1 text-3xs text-gray-400">
                    (合計 {session.metrics.totalOvertime.toFixed(1)}h)
                  </span>
                )}
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">有給取得</span>
                <span className="text-gray-900 dark:text-white">{session.metrics.plUsage}日</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">出勤率ボーナス</span>
                <span className="font-bold text-blue-600 dark:text-blue-400">+{session.metrics.attendanceBonus}点</span>
              </div>
            </div>

            {/* 詳細内訳（新ロジックで計算した分のみ表示） */}
            {session.metrics.applicablePrescribed != null && (
              <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {/* 出勤扱い内訳 */}
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
                    <div className="font-bold text-gray-700 dark:text-gray-300 mb-2">
                      出勤扱い内訳 <span className="text-gray-500 font-normal">合計 {session.metrics.presentDays?.toFixed(1) ?? '--'} 日</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">実出勤</span>
                        <span className="font-medium tabular-nums text-gray-900 dark:text-white">{session.metrics.workedDays?.toFixed(1) ?? '--'} 日</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">有給</span>
                        <span className="font-medium tabular-nums text-blue-600 dark:text-blue-400">{session.metrics.plDays ?? session.metrics.plUsage} 日</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">試験</span>
                        <span className="font-medium tabular-nums text-purple-600 dark:text-purple-400">{session.metrics.examDays ?? 0} 日</span>
                      </div>
                      {(session.metrics.compensationDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">補償（土曜0.6）</span>
                          <span className="font-medium tabular-nums text-gray-500" title="出勤率の分子・分母どちらにも入れない">
                            {session.metrics.compensationDays} 日 <span className="text-3xs">※対象外</span>
                          </span>
                        </div>
                      )}
                      {(session.metrics.restDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">欠勤</span>
                          <span className="font-medium tabular-nums text-red-600 dark:text-red-400">{session.metrics.restDays} 日</span>
                        </div>
                      )}
                      {(session.metrics.homeLeaveDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">帰国</span>
                          <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.homeLeaveDays} 日</span>
                        </div>
                      )}
                      {(session.metrics.siteOffDays ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">現場休</span>
                          <span className="font-medium tabular-nums text-gray-500">{session.metrics.siteOffDays} 日</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 期待出勤日内訳 */}
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
                    <div className="font-bold text-gray-700 dark:text-gray-300 mb-2">
                      期待出勤日 <span className="text-gray-500 font-normal">{session.metrics.applicablePrescribed} 日</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">月所定合計</span>
                        <span className="font-medium tabular-nums text-gray-900 dark:text-white">{session.metrics.prescribedTotal} 日</span>
                      </div>
                      {session.metrics.excludedDays && (
                        <>
                          {session.metrics.excludedDays.beforeHire > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 雇用前</span>
                              <span className="font-medium tabular-nums text-gray-500">{session.metrics.excludedDays.beforeHire} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.afterRetire > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 退職後</span>
                              <span className="font-medium tabular-nums text-gray-500">{session.metrics.excludedDays.afterRetire} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.homeLeave > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 帰国期間</span>
                              <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.excludedDays.homeLeave} 日</span>
                            </div>
                          )}
                          {session.metrics.excludedDays.longAbsence > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">－ 長期不在(14日+)</span>
                              <span className="font-medium tabular-nums text-orange-600 dark:text-orange-400">{session.metrics.excludedDays.longAbsence} 日</span>
                            </div>
                          )}
                          {Object.values(session.metrics.excludedDays).every(v => v === 0) && (
                            <div className="text-gray-400 italic">除外なし</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-2xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  出勤率 = (実出勤 + 有給 + 試験) ÷ 期待出勤日 × 100（上限100%）。
                  ベトナム土曜の補償日（w=0.6）は分子・分母どちらにも含めません。
                  期待出勤日は月所定日数から雇用境界・帰国期間・長期不在を控除した値です。
                </div>
              </div>
            )}
          </div>
        )}

        {/* 評価者比較表（reviews が1件以上ある場合のみ） */}
        {session.reviews.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900">
              <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">評価者比較</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 w-32">
                      項目
                    </th>
                    {session.reviews.map((r, idx) => {
                      const w = session.evaluatorWeights?.[r.evaluatorId]
                      return (
                        <th
                          key={r.evaluatorId}
                          className={`px-3 py-3 text-center text-xs font-medium text-white border-b border-gray-200 dark:border-gray-700 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].header}`}
                        >
                          <div>{r.evaluatorName}</div>
                          {w && (
                            <div className="mt-1 text-3xs font-normal opacity-90">
                              {w.isApprover ? (
                                <span title={`事業責任者の固定ウェイト (${w.weight.toFixed(2)})`}>w={w.weight.toFixed(2)} <Icon name="star" size={9} className="inline" /></span>
                              ) : (
                                <span title={`過去365日 共働 ${w.yearDays}日 (うち直近90日 ${w.recentDays}日)${w.monthsWithData != null ? ` / データある月 ${w.monthsWithData}/12 (cap ${w.dynamicCap}日)` : ''}`}>
                                  w={w.weight.toFixed(2)}
                                  <span className="block opacity-80">年共働 {w.yearPct}% ({w.yearDays}日)</span>
                                </span>
                              )}
                            </div>
                          )}
                        </th>
                      )
                    })}
                    {session.status === 'approved' && session.finalScores && (
                      <>
                        <th className="px-3 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></th>
                        <th className="px-3 py-3 text-center text-xs font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 bg-indigo-50 dark:bg-indigo-900/30 min-w-[100px]">
                          最終
                        </th>
                      </>
                    )}
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
                        {session.reviews.map(r => {
                          const inScope = isCategoryInScope(r.evaluatorId, item.category)
                          return (
                            <td key={r.evaluatorId} className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700">
                              {inScope ? (
                                <GradeBadge grade={getScoreValue(r.scores, item.category, item.key)} />
                              ) : (
                                <span className="text-gray-300 dark:text-gray-600 text-lg" title="担当外（評価対象外）">─</span>
                              )}
                            </td>
                          )
                        })}
                        {session.status === 'approved' && session.finalScores && (
                          <>
                            <td className="border-b border-gray-100 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 w-1"></td>
                            <td className="px-3 py-2 text-center border-b border-gray-100 dark:border-gray-700 bg-indigo-50/50 dark:bg-indigo-900/20">
                              <GradeBadge grade={getScoreValue(session.finalScores, item.category, item.key)} />
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-400" /> 全員一致
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" /> 意見分かれ
              </span>
            </div>
          </div>
        )}

        {/* コメント */}
        {session.reviews.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-4">
            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">評価者コメント</h4>
            <div className="space-y-3">
              {session.reviews.map((r, idx) => (
                <div key={r.evaluatorId} className={`rounded-lg p-3 ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].bg}`}>
                  <p className={`text-xs font-medium ${EVALUATOR_COLORS[idx % EVALUATOR_COLORS.length].text}`}>
                    {r.evaluatorName}
                    <span className="ml-2 text-gray-500 font-normal">
                      {fmtDateShort(r.submittedAt)} 提出
                    </span>
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">
                    {r.comment || '（コメントなし）'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 最終結果（承認済みのみ） */}
        {session.status === 'approved' && session.totalScore != null && session.rank && (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4">
            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">最終結果</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">手動スコア</span>
                <span className="font-medium text-gray-900 dark:text-white">{(session.manualScore ?? 0).toFixed(1)}</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">出勤率ボーナス</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">+{session.metrics?.attendanceBonus ?? 0}点</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">合計スコア</span>
                <span className="font-bold text-gray-900 dark:text-white">{session.totalScore.toFixed(1)}</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block">ランク</span>
                <span className={`text-2xl font-bold ${rankColor(session.rank)}`}>{session.rank}</span>
              </div>
            </div>
            {session.raiseAmount != null && session.raiseAmount > 0 && (
              <p className="mt-3 text-sm font-bold text-green-600 dark:text-green-400">
                推奨昇給: +{session.raiseAmount}円/h（{session.yearsFromHire}回目の記念日の昇給）
              </p>
            )}
            {session.finalComment && (
              <div className="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">最終コメント:</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {session.finalComment}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    )
}

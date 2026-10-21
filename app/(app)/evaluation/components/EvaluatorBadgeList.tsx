'use client'
/** 評価者のバッジ一覧（提出済み／未提出）（2026-10-21 総点検 §7-2 で app/(app)/evaluation/page.tsx から分離。中身は変えていない） */
import { Evaluation } from '@/types'
import { daysSince, evaluatorNameLookup, fmtDateShort } from '@/lib/evaluation-view'
import { Icon } from '@/components/ui/Icon'
import type { EvaluationPageCtx } from '../useEvaluationPage'

export function EvaluatorBadgeList({ ctx, session, compact = false, showProgress = true, }: { ctx: EvaluationPageCtx; session: Evaluation; compact?: boolean; showProgress?: boolean }) {
  const { authUser, workers, apiEvaluators } = ctx
    const submitted = new Set(session.reviews.map(r => r.evaluatorId))
    const total = session.evaluatorIds.length
    const submittedCount = session.evaluatorIds.filter(id => submitted.has(id)).length
    const pct = total > 0 ? Math.round((submittedCount / total) * 100) : 0

    let progressColor = 'bg-blue-500'
    let progressLabel = `${submittedCount}/${total}名 提出`
    if (session.status === 'approved') {
      progressColor = 'bg-green-500'
      progressLabel = '承認済み'
    } else if (session.status === 'reviewing') {
      progressColor = 'bg-amber-500'
      progressLabel = '最終確認待ち'
    }

    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          {session.evaluatorIds.map(id => {
            const name = evaluatorNameLookup(id, apiEvaluators, workers)
            const review = session.reviews.find(r => r.evaluatorId === id)
            const isSubmitted = !!review
            const isMe = authUser?.workerId === id
            const cls = isSubmitted
              ? 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-300 dark:border-green-700'
              : 'bg-gray-50 text-gray-500 dark:bg-gray-700/50 dark:text-gray-400 border-dashed border-gray-300 dark:border-gray-600'
            const ring = isMe ? 'ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-800' : ''
            const stale = isSubmitted ? '' : daysSince(session.createdAt) >= 7 ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-800' : ''
            const tip = isSubmitted && review
              ? `${name}（${fmtDateShort(review.submittedAt)} 提出）`
              : `${name}（未提出${daysSince(session.createdAt) >= 7 ? ` / 開始から${daysSince(session.createdAt)}日経過` : ''}）`
            return (
              <span
                key={id}
                title={tip}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-medium border ${stale || cls} ${ring}`}
              >
                {isMe && <Icon name="user" size={11} className="opacity-70" />}
                <span className="opacity-70">{isSubmitted ? '✓' : '○'}</span>
                <span className={compact ? 'max-w-[5rem] truncate' : ''}>{name}</span>
              </span>
            )
          })}
        </div>
        {showProgress && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-[140px]">
              <div className={`h-full transition-all ${progressColor}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-3xs text-gray-500 dark:text-gray-400 tabular-nums">
              {progressLabel}
            </span>
          </div>
        )}
      </div>
    )
}

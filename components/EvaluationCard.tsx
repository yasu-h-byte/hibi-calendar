'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchWithAuth } from '@/lib/api-client'
import { AuthUser } from '@/types'

/** 政仁さん（approver）の workerId */
const APPROVER_WORKER_ID = 1
/** 靖仁さん（super admin）の workerId — workers コレクションには居ない */
const ADMIN_WORKER_ID = 0

type SessionStatus = 'collecting' | 'reviewing' | 'approved'

interface EvaluationSession {
  id: string
  workerId: number
  workerName: string
  evaluationDate: string
  status: SessionStatus
  evaluatorIds: number[]
  reviews: { evaluatorId: number; evaluatorName: string }[]
}

interface ApiResp {
  evaluations: EvaluationSession[]
}

/**
 * ダッシュボード用 進行中評価セッションカード
 *
 * 表示対象:
 *   - admin / approver: status='collecting' / 'reviewing' の全セッション
 *   - foreman: 自分が evaluatorIds に含まれる collecting セッションのみ
 *
 * 自分の提出状況・全体の進捗バー・最終承認待ち表示で「いまやるべきこと」を可視化。
 */
export default function EvaluationCard({ user }: { user: AuthUser }) {
  const router = useRouter()
  const [sessions, setSessions] = useState<EvaluationSession[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetchWithAuth('/api/evaluation')
        if (!res.ok) {
          if (!cancelled) setLoading(false)
          return
        }
        const data = (await res.json()) as ApiResp
        if (cancelled) return
        // collecting / reviewing のみ
        const inProgress = (data.evaluations || []).filter(
          e => e.status === 'collecting' || e.status === 'reviewing',
        )
        // 役割に応じた絞り込み
        let visible = inProgress
        if (user.role === 'foreman') {
          // 職長は「自分が評価予定者」のセッションのみ
          visible = inProgress.filter(e => e.evaluatorIds.includes(user.workerId))
        }
        setSessions(visible)
      } catch {
        // silent fail
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [user.role, user.workerId])

  // 何もなければ非表示
  if (loading || sessions.length === 0) return null

  // admin/approver は最終承認権限を持つ
  const canApprove = user.role === 'admin' || user.role === 'approver'

  return (
    <div className="bg-white dark:bg-gray-800 border border-indigo-200 dark:border-indigo-900 rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-indigo-50 dark:bg-indigo-900/30 border-b border-indigo-100 dark:border-indigo-900 flex items-center justify-between">
        <h3 className="text-sm font-bold text-indigo-900 dark:text-indigo-200">📋 評価管理</h3>
        <button
          onClick={() => router.push('/evaluation')}
          className="text-xs text-indigo-700 dark:text-indigo-300 hover:underline"
        >
          評価管理を開く →
        </button>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {sessions.map(s => {
          const total = s.evaluatorIds.length
          const submittedSet = new Set(s.reviews.map(r => r.evaluatorId))
          const submitted = s.evaluatorIds.filter(id => submittedSet.has(id)).length
          const pct = total > 0 ? Math.round((submitted / total) * 100) : 0
          const userIsEvaluator = s.evaluatorIds.includes(user.workerId)
          const userSubmitted = submittedSet.has(user.workerId)
          const isReviewing = s.status === 'reviewing'

          return (
            <li key={s.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900 dark:text-white truncate">
                      {s.workerName} さん
                    </span>
                    {isReviewing ? (
                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        ⚖️ 最終承認待ち
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                        📝 評価入力中
                      </span>
                    )}
                  </div>

                  {/* 進捗バー */}
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-xs">
                      <div
                        className={`h-full transition-all ${
                          isReviewing ? 'bg-amber-400' : 'bg-blue-400'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                      {submitted}/{total}名 提出済
                    </span>
                  </div>

                  {/* あなたの状態 */}
                  {userIsEvaluator && !isReviewing && (
                    <div className="mt-1 text-xs">
                      {userSubmitted ? (
                        <span className="text-green-600 dark:text-green-400">✅ あなたは提出済</span>
                      ) : (
                        <span className="text-orange-600 dark:text-orange-400 font-medium">
                          ⏳ あなたの評価がまだです
                        </span>
                      )}
                    </div>
                  )}
                  {isReviewing && canApprove && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400 font-medium">
                      ⚖️ 最終承認をお願いします
                    </div>
                  )}
                </div>

                <button
                  onClick={() => router.push('/evaluation')}
                  className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
                >
                  {isReviewing && canApprove
                    ? '承認する'
                    : userIsEvaluator && !userSubmitted
                    ? '評価する'
                    : '詳細'}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

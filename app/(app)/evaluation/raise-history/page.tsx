'use client'

/**
 * 昇給履歴ページ（ベトナム人スタッフ向け）
 *
 * 2026-05-12 追加: 過去の評価承認履歴をワーカーごとに時系列で見られる仕組み。
 * データソースは evaluations コレクション (status='approved' のみ)。
 * 「推奨昇給額」「ランク」「勤続年数」を時系列に表示。
 * 実際の時給更新タイミングはここでは管理しない（必要なら別フェーズで拡張）。
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AuthUser, Worker, Evaluation, EvaluationRank } from '@/types'
import { fmtYen } from '@/lib/format'

const VISA_LABELS: Record<string, string> = {
  none: '日本人',
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号',
  jisshu: '技能実習', tokutei: '特定技能',
}

function rankColor(r: EvaluationRank): string {
  switch (r) {
    case 'S': return 'text-purple-600 dark:text-purple-400'
    case 'A': return 'text-blue-600 dark:text-blue-400'
    case 'B': return 'text-green-600 dark:text-green-400'
    case 'C': return 'text-yellow-600 dark:text-yellow-400'
    case 'D': return 'text-red-600 dark:text-red-400'
  }
}

function yearsBetween(hireDate: string, refDate?: string): number {
  if (!hireDate) return 0
  const hire = new Date(hireDate)
  const ref = refDate ? new Date(refDate) : new Date()
  let y = ref.getFullYear() - hire.getFullYear()
  const mDiff = ref.getMonth() - hire.getMonth()
  if (mDiff < 0 || (mDiff === 0 && ref.getDate() < hire.getDate())) y--
  return Math.max(0, y)
}

interface WorkerWithEvals {
  worker: Worker
  approvedEvals: Evaluation[]      // 承認済みのみ、降順（新→旧）
  latestEval?: Evaluation
  totalRaise: number               // 累計昇給額
}

export default function RaiseHistoryPage() {
  const searchParams = useSearchParams()
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [loading, setLoading] = useState(true)
  const [detailWorkerId, setDetailWorkerId] = useState<number | null>(null)

  // URL ?worker=X が指定されていれば詳細を自動オープン
  useEffect(() => {
    const wid = searchParams.get('worker')
    if (wid) {
      const n = parseInt(wid, 10)
      if (Number.isFinite(n)) setDetailWorkerId(n)
    }
  }, [searchParams])

  const isAdmin = authUser?.role === 'admin' || authUser?.role === 'approver'

  const getAuth = () => {
    try {
      const stored = localStorage.getItem('hibi_auth')
      if (stored) {
        const { password, user } = JSON.parse(stored)
        return { password, user: user as AuthUser }
      }
    } catch { /* ignore */ }
    return { password: '', user: null }
  }

  const fetchData = useCallback(async () => {
    const { password, user } = getAuth()
    setAuthUser(user)
    try {
      const [wRes, eRes] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/evaluation', { headers: { 'x-admin-password': password } }),
      ])
      if (wRes.ok) {
        const d = await wRes.json()
        const all: Worker[] = d.workers || []
        // ベトナム人スタッフ（visa が tokutei / jisshu / 関連）かつ未退職
        setWorkers(all.filter(w => w.visaType && w.visaType !== 'none' && !w.retired))
      }
      if (eRes.ok) {
        const d = await eRes.json()
        setEvaluations(d.evaluations || [])
      }
    } catch (e) {
      console.error('RaiseHistory fetch error:', e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // 各ワーカーに承認済み評価を集約
  const data: WorkerWithEvals[] = workers.map(w => {
    const approved = evaluations
      .filter(e => e.workerId === w.id && e.status === 'approved')
      .sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))
    const totalRaise = approved.reduce((s, e) => s + (e.raiseAmount || 0), 0)
    return {
      worker: w,
      approvedEvals: approved,
      latestEval: approved[0],
      totalRaise,
    }
  })

  // 並び順: 評価回数が多い → 直近評価日が新しい → 名前
  const sorted = [...data].sort((a, b) => {
    if (a.approvedEvals.length !== b.approvedEvals.length)
      return b.approvedEvals.length - a.approvedEvals.length
    if (a.latestEval && b.latestEval)
      return b.latestEval.evaluationDate.localeCompare(a.latestEval.evaluationDate)
    if (a.latestEval) return -1
    if (b.latestEval) return 1
    return a.worker.name.localeCompare(b.worker.name, 'ja')
  })

  const detailData = detailWorkerId
    ? data.find(d => d.worker.id === detailWorkerId)
    : null

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <p className="text-gray-500">管理者のみ閲覧できます。</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">昇給履歴（ベトナム人スタッフ）</h1>
        <Link
          href="/evaluation"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← 評価管理に戻る
        </Link>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        評価セッションの承認履歴を基に、ベトナム人スタッフごとの推奨昇給額の履歴を表示します。
        詳細を見るには行をクリックしてください。
      </p>

      {/* 一覧テーブル */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">名前</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">在留資格</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">勤続</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">現時給</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">評価回数</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">最新評価</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">直近昇給</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">累計昇給</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sorted.map(({ worker, approvedEvals, latestEval, totalRaise }) => {
                const yrs = worker.hireDate ? yearsBetween(worker.hireDate) : 0
                return (
                  <tr
                    key={worker.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer"
                    onClick={() => setDetailWorkerId(worker.id)}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{worker.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {VISA_LABELS[worker.visaType] || worker.visaType}
                    </td>
                    <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {yrs > 0 ? `${yrs}年` : '入社1年未満'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-white whitespace-nowrap font-medium tabular-nums">
                      {worker.hourlyRate ? `¥${fmtYen(worker.hourlyRate)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-center text-gray-700 dark:text-gray-200 whitespace-nowrap">
                      {approvedEvals.length > 0 ? `${approvedEvals.length}回` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      {latestEval ? (
                        <div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">{latestEval.evaluationDate}</div>
                          <div className={`text-sm font-bold ${rankColor(latestEval.rank!)}`}>{latestEval.rank}</div>
                        </div>
                      ) : (
                        <span className="text-gray-400 text-sm">未評価</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-700 dark:text-gray-200 whitespace-nowrap tabular-nums">
                      {latestEval && latestEval.raiseAmount != null
                        ? <span className="text-green-600 dark:text-green-400 font-medium">+¥{fmtYen(latestEval.raiseAmount)}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-700 dark:text-gray-200 whitespace-nowrap tabular-nums">
                      {totalRaise > 0 ? <span className="font-medium">+¥{fmtYen(totalRaise)}</span> : '—'}
                    </td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailWorkerId(worker.id) }}
                        className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        詳細
                      </button>
                    </td>
                  </tr>
                )
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                    対象スタッフがいません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 詳細モーダル */}
      {detailData && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
          onClick={() => setDetailWorkerId(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-3xl w-full my-8 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {detailData.worker.name} の昇給履歴
              </h2>
              <button
                onClick={() => setDetailWorkerId(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
                aria-label="閉じる"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* ワーカー情報 */}
              <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">在留資格</div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {VISA_LABELS[detailData.worker.visaType] || detailData.worker.visaType}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">入社日</div>
                    <div className="font-medium text-gray-900 dark:text-white">{detailData.worker.hireDate || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">勤続年数</div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {detailData.worker.hireDate ? `${yearsBetween(detailData.worker.hireDate)}年` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">現時給</div>
                    <div className="font-medium text-gray-900 dark:text-white tabular-nums">
                      {detailData.worker.hourlyRate ? `¥${fmtYen(detailData.worker.hourlyRate)}` : '—'}
                    </div>
                  </div>
                </div>
                {detailData.approvedEvals.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <span className="text-xs text-gray-500 dark:text-gray-400">累計昇給額</span>
                      <span className="text-lg font-bold text-green-600 dark:text-green-400 tabular-nums">
                        +¥{fmtYen(detailData.totalRaise)}/h
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ({detailData.approvedEvals.length} 回の評価)
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* 評価履歴テーブル */}
              {detailData.approvedEvals.length === 0 ? (
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-8 text-center text-gray-400 dark:text-gray-500">
                  まだ承認済みの評価がありません
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">評価日</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">勤続</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">合計スコア</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">ランク</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">推奨昇給</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">承認日</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {detailData.approvedEvals.map((ev) => (
                        <tr key={ev.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                          <td className="px-3 py-2 text-gray-900 dark:text-white whitespace-nowrap">{ev.evaluationDate}</td>
                          <td className="px-3 py-2 text-center text-gray-700 dark:text-gray-200 whitespace-nowrap">{ev.yearsFromHire}年目</td>
                          <td className="px-3 py-2 text-center text-gray-700 dark:text-gray-200 tabular-nums">
                            {ev.totalScore?.toFixed(1) ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-center whitespace-nowrap">
                            {ev.rank ? <span className={`font-bold text-lg ${rankColor(ev.rank)}`}>{ev.rank}</span> : '—'}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                            {ev.raiseAmount != null && ev.raiseAmount > 0 ? (
                              <span className="text-green-600 dark:text-green-400 font-medium">+¥{fmtYen(ev.raiseAmount)}</span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                            {ev.approvedAt ? new Date(ev.approvedAt).toLocaleDateString('ja-JP') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                💡 「推奨昇給」は評価承認時に算出された推奨額です。実際の時給更新は人員マスタの編集で行われ、
                ここでは別途記録していません。今後「時給変更の実履歴」も含めた完全な履歴管理を追加する場合は
                ご相談ください。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

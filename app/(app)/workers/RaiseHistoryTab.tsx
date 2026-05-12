'use client'

/**
 * 昇給履歴タブ（人員マスタ内）
 *
 * 2026-05-12: 評価管理ページから移設（職長も閲覧できるため不適切だった）。
 * 人員マスタ配下なら admin/jimu のみが sidebar 経由でアクセス。
 * defense-in-depth: 本コンポーネント自体に isAdmin 判定を持たせ、URL ハック対策。
 */

import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { Worker, Evaluation, EvaluationRank, AuthUser } from '@/types'
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

function yearsFromDate(dateStr: string): number {
  if (!dateStr) return 0
  const hire = new Date(dateStr)
  const now = new Date()
  let y = now.getFullYear() - hire.getFullYear()
  const mDiff = now.getMonth() - hire.getMonth()
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < hire.getDate())) y--
  return Math.max(0, y)
}

type SortKey = 'name' | 'company' | 'visa' | 'tenure' | 'rate' | 'evalCount' | 'latestEval' | 'latestRaise' | 'totalRaise'

interface Row {
  worker: Worker
  approvedEvals: Evaluation[]
  latestEval?: Evaluation
  totalRaise: number
}

export default function RaiseHistoryTab({ authUser }: { authUser: AuthUser | null }) {
  const searchParams = useSearchParams()
  const [workers, setWorkers] = useState<Worker[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [loading, setLoading] = useState(true)
  const [detailWorkerId, setDetailWorkerId] = useState<number | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('evalCount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const isAdmin = authUser?.role === 'admin' || authUser?.role === 'approver'

  // URL ?worker=N で詳細を自動オープン
  useEffect(() => {
    const wid = searchParams.get('worker')
    if (wid) {
      const n = parseInt(wid, 10)
      if (Number.isFinite(n)) setDetailWorkerId(n)
    }
  }, [searchParams])

  // データ取得
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      try {
        const password = (() => {
          try {
            const stored = localStorage.getItem('hibi_auth')
            if (stored) return (JSON.parse(stored).password as string) || ''
          } catch { /* ignore */ }
          return ''
        })()
        const [wRes, eRes] = await Promise.all([
          fetch('/api/workers', { headers: { 'x-admin-password': password } }),
          fetch('/api/evaluation', { headers: { 'x-admin-password': password } }),
        ])
        if (cancelled) return
        if (wRes.ok) {
          const d = await wRes.json()
          const all: Worker[] = d.workers || []
          // ベトナム人スタッフ + 未退職
          setWorkers(all.filter(w => w.visaType && w.visaType !== 'none' && !w.retired))
        }
        if (eRes.ok) {
          const d = await eRes.json()
          setEvaluations(d.evaluations || [])
        }
      } catch (e) {
        console.error('RaiseHistory fetch error:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [isAdmin])

  // 集計
  const rows: Row[] = useMemo(() => workers.map(w => {
    const approved = evaluations
      .filter(e => e.workerId === w.id && e.status === 'approved')
      .sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))
    const totalRaise = approved.reduce((s, e) => s + (e.raiseAmount || 0), 0)
    return { worker: w, approvedEvals: approved, latestEval: approved[0], totalRaise }
  }), [workers, evaluations])

  // ソート
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    switch (sortKey) {
      case 'name': return dir * a.worker.name.localeCompare(b.worker.name, 'ja')
      case 'company': return dir * (a.worker.company || '').localeCompare(b.worker.company || '', 'ja')
      case 'visa': return dir * (a.worker.visaType || '').localeCompare(b.worker.visaType || '', 'ja')
      case 'tenure': {
        const ya = a.worker.hireDate ? yearsFromDate(a.worker.hireDate) : -1
        const yb = b.worker.hireDate ? yearsFromDate(b.worker.hireDate) : -1
        return dir * (ya - yb)
      }
      case 'rate': return dir * ((a.worker.hourlyRate || 0) - (b.worker.hourlyRate || 0))
      case 'evalCount': return dir * (a.approvedEvals.length - b.approvedEvals.length)
      case 'latestEval': {
        const da = a.latestEval?.evaluationDate || ''
        const db = b.latestEval?.evaluationDate || ''
        return dir * da.localeCompare(db)
      }
      case 'latestRaise': return dir * ((a.latestEval?.raiseAmount || 0) - (b.latestEval?.raiseAmount || 0))
      case 'totalRaise': return dir * (a.totalRaise - b.totalRaise)
      default: return 0
    }
  }), [rows, sortKey, sortDir])

  const detailRow = detailWorkerId ? rows.find(r => r.worker.id === detailWorkerId) : null

  const sortHandler = (key: SortKey) => () => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  if (!isAdmin) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-8 text-center text-gray-400 dark:text-gray-500">
        管理者・事業責任者のみ閲覧できます
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white">
          💰 昇給履歴（ベトナム人スタッフ）
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          評価セッションの承認履歴を基にした推奨昇給額の推移
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('name')}>
                  名前{sortIndicator('name')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('company')}>
                  所属{sortIndicator('company')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('visa')}>
                  在留資格{sortIndicator('visa')}
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('tenure')}>
                  勤続{sortIndicator('tenure')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('rate')}>
                  現時給{sortIndicator('rate')}
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('evalCount')}>
                  評価回数{sortIndicator('evalCount')}
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('latestEval')}>
                  最新評価{sortIndicator('latestEval')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('latestRaise')}>
                  直近昇給{sortIndicator('latestRaise')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none" onClick={sortHandler('totalRaise')}>
                  累計昇給{sortIndicator('totalRaise')}
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sorted.map(({ worker, approvedEvals, latestEval, totalRaise }) => {
                const yrs = worker.hireDate ? yearsFromDate(worker.hireDate) : 0
                return (
                  <tr
                    key={worker.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer"
                    onClick={() => setDetailWorkerId(worker.id)}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{worker.name}</td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        worker.company === 'HFU'
                          ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                      }`}>
                        {worker.company === 'HFU' ? 'HFU' : '日比建設'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {VISA_LABELS[worker.visaType] || worker.visaType}
                    </td>
                    <td className="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {yrs > 0 ? `${yrs}年` : '1年未満'}
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
                      {latestEval && latestEval.raiseAmount != null && latestEval.raiseAmount > 0
                        ? <span className="text-green-600 dark:text-green-400 font-medium">+¥{fmtYen(latestEval.raiseAmount)}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-700 dark:text-gray-200 whitespace-nowrap tabular-nums">
                      {totalRaise > 0 ? <span className="font-medium">+¥{fmtYen(totalRaise)}</span> : '—'}
                    </td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      <button
                        onClick={e => { e.stopPropagation(); setDetailWorkerId(worker.id) }}
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
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                    ベトナム人スタッフがいません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
          合計 {sorted.length} 名 | 列見出しクリックでソート | 行クリックで詳細表示
        </div>
      </div>

      {/* 詳細モーダル */}
      {detailRow && (
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
                {detailRow.worker.name} の昇給履歴
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
              <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">所属</div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {detailRow.worker.company === 'HFU' ? 'HFU' : '日比建設'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">在留資格</div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {VISA_LABELS[detailRow.worker.visaType] || detailRow.worker.visaType}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">入社日 / 勤続</div>
                    <div className="font-medium text-gray-900 dark:text-white">
                      {detailRow.worker.hireDate || '—'}
                      {detailRow.worker.hireDate && (
                        <span className="text-xs text-gray-500 ml-1">({yearsFromDate(detailRow.worker.hireDate)}年)</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">現時給</div>
                    <div className="font-medium text-gray-900 dark:text-white tabular-nums">
                      {detailRow.worker.hourlyRate ? `¥${fmtYen(detailRow.worker.hourlyRate)}` : '—'}
                    </div>
                  </div>
                </div>
                {detailRow.approvedEvals.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <span className="text-xs text-gray-500 dark:text-gray-400">累計昇給額</span>
                      <span className="text-lg font-bold text-green-600 dark:text-green-400 tabular-nums">
                        +¥{fmtYen(detailRow.totalRaise)}/h
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ({detailRow.approvedEvals.length} 回の評価)
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {detailRow.approvedEvals.length === 0 ? (
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
                      {detailRow.approvedEvals.map((ev) => (
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
                💡 「推奨昇給」は評価承認時に算出された推奨額です。実際の時給更新は人員マスタの編集で行われ、ここでは別途記録していません。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

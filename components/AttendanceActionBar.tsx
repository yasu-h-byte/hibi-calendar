'use client'

/**
 * 出面入力画面 上部のアクションバー（2026-05-18 追加）
 *
 * 目的:
 *   職長・政仁・靖仁が「毎日見る /attendance ページ」で、有給承認・帰国承認まで
 *   完結できるようにする。/dashboard を開かなくても承認が滞留しない。
 *
 * 設計方針:
 *   - スマホ操作前提（タップターゲット最低44pt・縦スタック・本文14px以上）
 *   - デフォルト折畳み、バッジで件数だけ可視化 → タップで展開
 *   - 申請者ごとに集約（同一スタッフ＋同一理由を1カードにまとめて一括承認）
 *   - 表示は全件（職長も全件閲覧可、ユーザー指定）
 *   - 操作可能なボタンだけを役割に応じて表示
 *
 * 権限マトリクス:
 *   - 有給職長承認: 担当現場の foreman / admin / approver
 *   - 有給最終承認: admin / approver のみ
 *   - 帰国職長承認: いずれかの担当現場あり foreman / admin / approver
 *   - 帰国最終承認: admin / approver のみ
 *   - 却下: 上記と同条件
 */

import { useEffect, useState, useCallback } from 'react'

interface LeaveRequestItem {
  id: string
  workerId: number
  workerName: string
  date: string
  siteId: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
  siteForemanName?: string
}

interface HomeLongLeaveItem {
  id: string
  workerId?: number
  workerName: string
  startDate: string
  endDate: string
  reason: string
  status: string
  requestedAt: string
  foremanApprovedAt?: string
  siteForemanName?: string
}

interface Props {
  password: string
  userRole: string  // 'admin' | 'approver' | 'foreman' | 'jimu'
  userWorkerId: number
  userForemanSites: string[]
  /** 親の出面ページが再フェッチしたい時のフック（承認後など） */
  onUpdate?: () => void
}

const fmtDate = (d: string) => {
  if (!d) return ''
  const [, m, day] = d.split('-')
  return `${parseInt(m)}/${parseInt(day)}`
}

export default function AttendanceActionBar({
  password,
  userRole,
  userWorkerId,
  userForemanSites,
  onUpdate,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestItem[]>([])
  const [homeLongLeaves, setHomeLongLeaves] = useState<HomeLongLeaveItem[]>([])

  const isAdminLike = userRole === 'admin' || userRole === 'approver'
  const isForeman = userRole === 'foreman'

  // 自分が職長承認できる現場の判定
  const canForemanApproveFor = (siteId?: string): boolean => {
    if (isAdminLike) return true
    if (isForeman && siteId && userForemanSites.includes(siteId)) return true
    return false
  }
  const canForemanApproveHomeLeave = (): boolean => {
    if (isAdminLike) return true
    if (isForeman && userForemanSites.length > 0) return true
    return false
  }
  const canFinalApprove = isAdminLike

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const [lrRes, hlRes] = await Promise.all([
        fetch('/api/leave-request', { headers: { 'x-admin-password': password } }),
        fetch('/api/home-long-leave', { headers: { 'x-admin-password': password } }),
      ])
      if (lrRes.ok) {
        const d = await lrRes.json()
        // pending + foreman_approved だけ
        const items: LeaveRequestItem[] = (d.requests || [])
          .filter((r: { status: string }) => r.status === 'pending' || r.status === 'foreman_approved')
        setLeaveRequests(items)
      }
      if (hlRes.ok) {
        const d = await hlRes.json()
        const items: HomeLongLeaveItem[] = (d.requests || [])
          .filter((r: { status: string }) => r.status === 'pending' || r.status === 'foreman_approved')
        setHomeLongLeaves(items)
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  // 並列処理ヘルパー（既存 dashboard の handleBulkAction と同じ思想）
  const handleAction = async (
    apiPath: string,
    ids: string[],
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (ids.length === 0) return
    setProcessing(`${apiPath}:${action}:${ids[0]}`)
    try {
      await Promise.all(ids.map(id => fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action,
          requestId: id,
          ...(action === 'foreman_approve' ? { foremanId: userWorkerId } : { approvedBy: userWorkerId }),
          ...extra,
        }),
      })))
      await fetchData()
      onUpdate?.()
    } catch { /* ignore */ }
    finally { setProcessing(null) }
  }

  // 有給申請を「ワーカー × 理由」でグループ化（status別）
  type LeaveGroup = { key: string; status: string; items: LeaveRequestItem[] }
  const groupLeaves = (list: LeaveRequestItem[]): LeaveGroup[] => {
    const groups: LeaveGroup[] = []
    const idx: Record<string, number> = {}
    for (const r of list) {
      const k = `${r.workerName}_${r.status}_${(r.reason || '').trim()}`
      if (idx[k] === undefined) {
        idx[k] = groups.length
        groups.push({ key: k, status: r.status, items: [] })
      }
      groups[idx[k]].items.push(r)
    }
    return groups
  }
  const leavePending = groupLeaves(leaveRequests.filter(r => r.status === 'pending'))
  const leaveForemanApproved = groupLeaves(leaveRequests.filter(r => r.status === 'foreman_approved'))
  const hlPending = homeLongLeaves.filter(r => r.status === 'pending')
  const hlForemanApproved = homeLongLeaves.filter(r => r.status === 'foreman_approved')

  const leaveTotal = leaveRequests.length
  const hlTotal = homeLongLeaves.length
  const total = leaveTotal + hlTotal

  // 0件なら表示しない
  if (loading && total === 0) {
    return (
      <div className="sticky top-0 z-30 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900 border-b border-blue-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-500">
        勤怠申請を確認中...
      </div>
    )
  }
  if (total === 0) return null

  return (
    <div className="sticky top-0 z-30 bg-white dark:bg-gray-900 border-b-2 border-blue-300 dark:border-gray-700 shadow-sm">
      {/* ── 折畳みヘッダ（タッチターゲット 大きめ） ── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-3 flex items-center justify-between gap-2 active:bg-blue-50 dark:active:bg-gray-800 transition"
        style={{ minHeight: 48 }}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-sm text-hibi-navy dark:text-white">📋 要対応</span>
          <span className="bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5">
            {total}件
          </span>
          {leaveTotal > 0 && (
            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full dark:bg-green-900/40 dark:text-green-200">
              🌴 {leaveTotal}
            </span>
          )}
          {hlTotal > 0 && (
            <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full dark:bg-purple-900/40 dark:text-purple-200">
              ✈️ {hlTotal}
            </span>
          )}
        </div>
        <span className="text-blue-600 dark:text-blue-300 text-sm">{expanded ? '▲ 閉じる' : '▼ 開く'}</span>
      </button>

      {/* ── 展開時のパネル ── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 max-h-[60vh] overflow-y-auto bg-blue-50/30 dark:bg-gray-800/50">
          {/* 🌴 有給申請 */}
          {leaveTotal > 0 && (
            <div className="pt-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-bold text-green-700 dark:text-green-300">🌴 有給申請</span>
                <span className="text-[10px] bg-green-200 text-green-900 px-1.5 py-0.5 rounded-full font-bold">{leaveTotal}件</span>
              </div>

              {/* 職長承認待ち */}
              {leavePending.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] text-yellow-700 dark:text-yellow-400 font-medium mb-1">⏳ 職長承認待ち（{leavePending.reduce((s, g) => s + g.items.length, 0)}件）</p>
                  <div className="space-y-2">
                    {leavePending.map(group => (
                      <LeaveCard
                        key={group.key}
                        group={group}
                        actionMode="foreman"
                        canAct={canForemanApproveFor(group.items[0].siteId)}
                        processing={processing}
                        onApprove={(ids) => handleAction('/api/leave-request', ids, 'foreman_approve')}
                        onReject={(ids, reason) => handleAction('/api/leave-request', ids, 'reject', { reason: reason || '' })}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* 最終承認待ち */}
              {leaveForemanApproved.length > 0 && (
                <div>
                  <p className="text-[10px] text-blue-700 dark:text-blue-400 font-medium mb-1">⏳ 最終承認待ち（{leaveForemanApproved.reduce((s, g) => s + g.items.length, 0)}件）</p>
                  <div className="space-y-2">
                    {leaveForemanApproved.map(group => (
                      <LeaveCard
                        key={group.key}
                        group={group}
                        actionMode="final"
                        canAct={canFinalApprove}
                        processing={processing}
                        onApprove={(ids) => handleAction('/api/leave-request', ids, 'approve')}
                        onReject={(ids, reason) => handleAction('/api/leave-request', ids, 'reject', { reason: reason || '' })}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ✈️ 帰国申請 */}
          {hlTotal > 0 && (
            <div className={leaveTotal > 0 ? 'border-t border-blue-200 dark:border-gray-700 pt-3' : 'pt-3'}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-bold text-purple-700 dark:text-purple-300">✈️ 帰国申請</span>
                <span className="text-[10px] bg-purple-200 text-purple-900 px-1.5 py-0.5 rounded-full font-bold">{hlTotal}件</span>
              </div>

              {/* 職長承認待ち */}
              {hlPending.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] text-yellow-700 dark:text-yellow-400 font-medium mb-1">⏳ 職長承認待ち（{hlPending.length}件）</p>
                  <div className="space-y-2">
                    {hlPending.map(req => (
                      <HomeLeaveCard
                        key={req.id}
                        req={req}
                        actionMode="foreman"
                        canAct={canForemanApproveHomeLeave()}
                        processing={processing}
                        onApprove={() => handleAction('/api/home-long-leave', [req.id], 'foreman_approve')}
                        onReject={(reason) => handleAction('/api/home-long-leave', [req.id], 'reject', { reason: reason || '' })}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* 最終承認待ち */}
              {hlForemanApproved.length > 0 && (
                <div>
                  <p className="text-[10px] text-blue-700 dark:text-blue-400 font-medium mb-1">⏳ 最終承認待ち（{hlForemanApproved.length}件）</p>
                  <div className="space-y-2">
                    {hlForemanApproved.map(req => (
                      <HomeLeaveCard
                        key={req.id}
                        req={req}
                        actionMode="final"
                        canAct={canFinalApprove}
                        processing={processing}
                        onApprove={() => handleAction('/api/home-long-leave', [req.id], 'approve')}
                        onReject={(reason) => handleAction('/api/home-long-leave', [req.id], 'reject', { reason: reason || '' })}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────
// 有給申請カード（1件 or グループ）
// ──────────────────────────────────────────

interface LeaveCardProps {
  group: { key: string; status: string; items: LeaveRequestItem[] }
  actionMode: 'foreman' | 'final'
  canAct: boolean
  processing: string | null
  onApprove: (ids: string[]) => void
  onReject: (ids: string[], reason: string) => void
}

function LeaveCard({ group, actionMode, canAct, processing, onApprove, onReject }: LeaveCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const first = group.items[0]
  const ids = group.items.map(r => r.id)
  const isMulti = group.items.length > 1
  const dates = group.items.map(r => r.date).sort().map(fmtDate).join('・')
  const fName = first.siteForemanName

  const bgClass = group.status === 'pending'
    ? 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800'
    : 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'

  return (
    <div className={`rounded-lg border p-2.5 ${bgClass}`}>
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <span className="font-bold text-sm text-hibi-navy dark:text-white">{first.workerName}</span>
        {isMulti && (
          <span className="text-[10px] bg-yellow-200 text-yellow-900 px-1.5 py-0.5 rounded-full font-bold">{group.items.length}件</span>
        )}
        {group.status === 'foreman_approved' && fName && (
          <span className="text-[10px] text-blue-600">{fName} 職長済</span>
        )}
        {first.reason && (
          <span className="text-[10px] text-gray-500 dark:text-gray-400 break-words flex-1 min-w-0">{first.reason}</span>
        )}
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-300 mb-2 break-words">{isMulti ? dates : fmtDate(first.date)}</div>

      {/* タップターゲット 大きめ・縦並びでスマホ操作しやすく */}
      <div className="flex gap-2 flex-wrap">
        {canAct && (
          <button
            onClick={() => onApprove(ids)}
            disabled={processing !== null}
            className={`flex-1 min-w-[120px] px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50 ${
              actionMode === 'foreman' ? 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' : 'bg-green-500 hover:bg-green-600 active:bg-green-700'
            } text-white`}
            style={{ minHeight: 36 }}
          >
            {actionMode === 'foreman'
              ? (fName ? `${fName} 一括職長承認` : (isMulti ? '一括職長承認' : '職長承認'))
              : (isMulti ? '一括最終承認' : '最終承認')}
          </button>
        )}
        <button
          onClick={() => {
            if (rejecting) onReject(ids, rejectReason)
            else setRejecting(true)
          }}
          disabled={processing !== null}
          className="px-3 py-2 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white rounded-lg text-xs font-bold disabled:opacity-50"
          style={{ minHeight: 36 }}
        >
          {isMulti ? '全て却下' : '却下'}
        </button>
      </div>

      {rejecting && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="却下理由（任意）"
            className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            style={{ minHeight: 36 }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => onReject(ids, rejectReason)}
              className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg text-xs font-bold"
              style={{ minHeight: 36 }}
            >
              却下する
            </button>
            <button
              onClick={() => { setRejecting(false); setRejectReason('') }}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-xs"
              style={{ minHeight: 36 }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────
// 帰国申請カード
// ──────────────────────────────────────────

interface HomeLeaveCardProps {
  req: HomeLongLeaveItem
  actionMode: 'foreman' | 'final'
  canAct: boolean
  processing: string | null
  onApprove: () => void
  onReject: (reason: string) => void
}

function HomeLeaveCard({ req, actionMode, canAct, processing, onApprove, onReject }: HomeLeaveCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const fName = req.siteForemanName
  const bgClass = req.status === 'pending'
    ? 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800'
    : 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'

  return (
    <div className={`rounded-lg border p-2.5 ${bgClass}`}>
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <span className="font-bold text-sm text-hibi-navy dark:text-white">{req.workerName}</span>
        {req.status === 'foreman_approved' && fName && (
          <span className="text-[10px] text-blue-600">{fName} 職長済</span>
        )}
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-300 mb-1 break-words">
        {fmtDate(req.startDate)} 〜 {fmtDate(req.endDate)}
      </div>
      {req.reason && (
        <div className="text-[10px] text-gray-500 dark:text-gray-400 mb-2 break-words">{req.reason}</div>
      )}

      <div className="flex gap-2 flex-wrap">
        {canAct && (
          <button
            onClick={onApprove}
            disabled={processing !== null}
            className={`flex-1 min-w-[120px] px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50 ${
              actionMode === 'foreman' ? 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700' : 'bg-green-500 hover:bg-green-600 active:bg-green-700'
            } text-white`}
            style={{ minHeight: 36 }}
          >
            {actionMode === 'foreman'
              ? (fName ? `${fName} 職長承認` : '職長承認')
              : '最終承認'}
          </button>
        )}
        <button
          onClick={() => {
            if (rejecting) onReject(rejectReason)
            else setRejecting(true)
          }}
          disabled={processing !== null}
          className="px-3 py-2 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white rounded-lg text-xs font-bold disabled:opacity-50"
          style={{ minHeight: 36 }}
        >
          却下
        </button>
      </div>

      {rejecting && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="却下理由（任意）"
            className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            style={{ minHeight: 36 }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => onReject(rejectReason)}
              className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg text-xs font-bold"
              style={{ minHeight: 36 }}
            >
              却下する
            </button>
            <button
              onClick={() => { setRejecting(false); setRejectReason('') }}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-xs"
              style={{ minHeight: 36 }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

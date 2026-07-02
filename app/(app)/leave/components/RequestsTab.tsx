'use client'

import { LeaveRequest, SiteOption, MforemanMap } from '../types'

// 申請タブ: 有給申請の職長承認・最終承認・却下・一括処理・日付変更
// UI状態（フィルタ・却下入力・展開状態など）はデータ再取得で画面全体が
// 読み込み表示に切り替わっても消えないよう、親（page）が保持する

export interface RequestsUiState {
  filter: 'all' | 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled'
  processingReq: string | null
  rejectingId: string | null
  rejectReason: string
  // 日付変更モーダル用（承認済み有給の誤申請修正）
  modifyingId: string | null
  modifyNewDate: string
  // 一括承認用: 展開中グループ集合（key = `${workerId}_${status}_${reason}`）
  expandedGroups: Set<string>
}

export const initialRequestsUi: RequestsUiState = {
  filter: 'all',
  processingReq: null,
  rejectingId: null,
  rejectReason: '',
  modifyingId: null,
  modifyNewDate: '',
  expandedGroups: new Set<string>(),
}

interface Props {
  visible: boolean
  leaveRequests: LeaveRequest[]
  sites: SiteOption[]
  mforeman: MforemanMap
  workerNames: Record<number, string>
  password: string
  userRole: string
  userForemanSites: string[]
  ui: RequestsUiState
  patchUi: (patch: Partial<RequestsUiState>) => void
  onRefresh: () => void
}

export default function RequestsTab({
  visible, leaveRequests, sites, mforeman, workerNames, password, userRole, userForemanSites,
  ui, patchUi, onRefresh,
}: Props) {
  if (!visible) return null

  const { filter: reqFilter, processingReq, rejectingId, rejectReason, modifyingId, modifyNewDate, expandedGroups } = ui

  const filtered = reqFilter === 'all' ? leaveRequests
    : leaveRequests.filter(r => r.status === reqFilter)
  const getSiteName = (siteId: string) => sites.find(s => s.id === siteId)?.name || siteId
  const fmtDate = (d: string) => { const [, m, day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}` }
  const fmtTs = (ts: string) => { const d = new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
  // 該当現場の職長名を解決（月別オーバーライドがあれば優先）
  // 申請日 YYYY-MM-DD から ym を抽出して mforeman を引き、なければ sites.foreman をフォールバック
  const resolveForemanName = (siteId: string, dateStr: string): string => {
    const ym = dateStr ? dateStr.slice(0, 7).replace('-', '') : ''
    const override = ym ? mforeman[`${siteId}_${ym}`]?.wid : undefined
    const foremanId = override ?? sites.find(s => s.id === siteId)?.foreman
    if (foremanId == null) return ''
    return workerNames[foremanId] || ''
  }
  const handleForemanApprove = async (id: string) => {
    patchUi({ processingReq: id })
    try {
      const stored = localStorage.getItem('hibi_auth')
      const { user } = stored ? JSON.parse(stored) : { user: null }
      await fetch('/api/leave-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'foreman_approve', requestId: id, foremanId: user?.workerId || 0 }),
      })
      onRefresh()
    } catch {} finally { patchUi({ processingReq: null }) }
  }
  const handleApprove = async (id: string) => {
    patchUi({ processingReq: id })
    try {
      const stored = localStorage.getItem('hibi_auth')
      const { user } = stored ? JSON.parse(stored) : { user: null }
      await fetch('/api/leave-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'approve', requestId: id, approvedBy: user?.workerId || 0 }),
      })
      onRefresh()
    } catch {} finally { patchUi({ processingReq: null }) }
  }
  const handleReject = async (id: string) => {
    patchUi({ processingReq: id })
    try {
      const stored = localStorage.getItem('hibi_auth')
      const { user } = stored ? JSON.parse(stored) : { user: null }
      await fetch('/api/leave-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'reject', requestId: id, rejectedBy: user?.workerId || 0, reason: rejectReason }),
      })
      patchUi({ rejectingId: null, rejectReason: '' })
      onRefresh()
    } catch {} finally { patchUi({ processingReq: null }) }
  }
  // 承認済み有給の日付変更（誤申請修正用、admin/approver のみ）
  const handleModifyDate = async (id: string, newDate: string) => {
    if (!newDate) { alert('新しい日付を選択してください'); return }
    patchUi({ processingReq: id })
    try {
      const stored = localStorage.getItem('hibi_auth')
      const { user } = stored ? JSON.parse(stored) : { user: null }
      const res = await fetch('/api/leave-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'modify_date', requestId: id, newDate, modifiedBy: user?.workerId || 0 }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || '日付変更に失敗しました')
        return
      }
      const data = await res.json()
      if (data.noop) {
        alert('変更前と同じ日付です')
      } else {
        alert(`日付を変更しました\n${data.oldDate} → ${data.newDate}`)
      }
      patchUi({ modifyingId: null, modifyNewDate: '' })
      onRefresh()
    } catch {
      alert('通信エラー')
    } finally { patchUi({ processingReq: null }) }
  }
  // ── 一括処理（2026-05-15 追加） ──
  // 同一スタッフの連続申請（例: 帰国に伴う15件分の有給）を1クリックで処理する。
  // 並列リクエストで全件を投げ、最後に onRefresh() で再読込。
  const handleBulkAction = async (
    ids: string[],
    action: 'foreman_approve' | 'approve' | 'reject',
    opts: { reason?: string } = {},
  ) => {
    if (ids.length === 0) return
    const bulkKey = `bulk:${action}:${ids[0]}`
    patchUi({ processingReq: bulkKey })
    try {
      const stored = localStorage.getItem('hibi_auth')
      const { user } = stored ? JSON.parse(stored) : { user: null }
      const wid = user?.workerId || 0
      await Promise.all(ids.map(id => fetch('/api/leave-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action,
          requestId: id,
          ...(action === 'foreman_approve' ? { foremanId: wid } : {}),
          ...(action === 'approve' ? { approvedBy: wid } : {}),
          ...(action === 'reject' ? { rejectedBy: wid, reason: opts.reason || '' } : {}),
        }),
      })))
      if (action === 'reject') { patchUi({ rejectingId: null, rejectReason: '' }) }
      onRefresh()
    } catch {} finally { patchUi({ processingReq: null }) }
  }
  // 申請を「スタッフ + status + reason」でグループ化
  // 同一条件のものを集約してまとめて承認/却下できるようにする。
  // reason は trim() で正規化（末尾スペース等の入力ゆれを吸収）
  const groupKey = (r: LeaveRequest) => `${r.workerId}_${r.status}_${(r.reason || '').trim()}`
  const groups: { key: string; items: LeaveRequest[] }[] = []
  const groupIdx: Record<string, number> = {}
  for (const r of filtered) {
    const k = groupKey(r)
    if (groupIdx[k] === undefined) {
      groupIdx[k] = groups.length
      groups.push({ key: k, items: [] })
    }
    groups[groupIdx[k]].items.push(r)
  }
  // 集約候補は pending / foreman_approved のみ（承認済み・却下・取消は集約しない）
  const isGroupable = (s: string) => s === 'pending' || s === 'foreman_approved'

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {(['all','pending','foreman_approved','approved','rejected','cancelled'] as const).map(key => (
          <button key={key} onClick={() => patchUi({ filter: key })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${reqFilter === key ? 'bg-hibi-navy text-white' : 'bg-white dark:bg-gray-800 text-gray-500 hover:bg-gray-100'}`}>
            {key === 'all' ? 'すべて' : key === 'pending' ? '職長待ち' : key === 'foreman_approved' ? '最終承認待ち' : key === 'approved' ? '承認済み' : key === 'cancelled' ? '取り消し' : '却下'}
            {key === 'pending' && leaveRequests.filter(r => r.status === 'pending').length > 0 && (
              <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5">{leaveRequests.filter(r => r.status === 'pending').length}</span>
            )}
            {key === 'foreman_approved' && leaveRequests.filter(r => r.status === 'foreman_approved').length > 0 && (
              <span className="ml-1 bg-orange-500 text-white text-[10px] rounded-full px-1.5">{leaveRequests.filter(r => r.status === 'foreman_approved').length}</span>
            )}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center text-gray-400">申請はありません</div>
      ) : (
        <div className="space-y-3">
          {groups.map(group => {
            const items = group.items
            const first = items[0]
            const groupable = isGroupable(first.status) && items.length >= 2
            const expanded = expandedGroups.has(group.key)
            // 個別表示: グループ化しない、または展開中
            if (!groupable || expanded) {
              return (
                <div key={group.key} className="space-y-3">
                  {groupable && (
                    <div className="flex items-center gap-2 text-xs text-gray-500 px-1">
                      <button onClick={() => {
                        const next = new Set(expandedGroups)
                        next.delete(group.key)
                        patchUi({ expandedGroups: next })
                      }} className="text-blue-600 hover:underline">▲ 集約に戻す</button>
                      <span>{first.workerName}（{items.length}件）</span>
                    </div>
                  )}
                  {items.map(req => (
                    <div key={req.id} className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border p-4 ${req.status === 'pending' ? 'border-yellow-300' : req.status === 'foreman_approved' ? 'border-blue-300' : 'border-gray-200 dark:border-gray-700'}`}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-1">
                            <span className="font-bold text-hibi-navy dark:text-white">{req.workerName}</span>
                            <span className="text-gray-600 dark:text-gray-300 font-medium">{fmtDate(req.date)}</span>
                            <span className="text-xs text-gray-400">{getSiteName(req.siteId)}</span>
                          </div>
                          {req.reason && <div className="text-xs text-gray-500 mb-1">理由: {req.reason}</div>}
                          <div className="text-[10px] text-gray-400">
                            申請: {fmtTs(req.requestedAt)}
                            {req.foremanApprovedAt && ` / 職長承認: ${fmtTs(req.foremanApprovedAt)}`}
                            {req.reviewedAt ? ` / 最終承認: ${fmtTs(req.reviewedAt)}` : ''}
                          </div>
                          {req.status === 'rejected' && req.rejectedReason && <div className="text-[10px] text-red-500 mt-1">却下理由: {req.rejectedReason}</div>}
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          {req.status === 'pending' && (() => {
                            const isAdminLike = userRole === 'admin' || userRole === 'approver'
                            const canFA = isAdminLike || (userRole === 'foreman' && userForemanSites.includes(req.siteId))
                            const fName = resolveForemanName(req.siteId, req.date)
                            return (
                            <>
                              {canFA && (
                                <button onClick={() => handleForemanApprove(req.id)} disabled={processingReq === req.id}
                                  className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">{fName ? `${fName} 職長承認` : '職長承認'}</button>
                              )}
                              <button onClick={() => rejectingId === req.id ? handleReject(req.id) : patchUi({ rejectingId: req.id, rejectReason: '' })}
                                disabled={processingReq === req.id}
                                className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                            </>
                            )
                          })()}
                          {req.status === 'foreman_approved' && (() => {
                            const canFinal = userRole === 'admin' || userRole === 'approver'
                            const fName = resolveForemanName(req.siteId, req.date)
                            return (
                            <>
                              <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">{fName ? `${fName} 職長済` : '職長済'}</span>
                              {canFinal && (
                                <button onClick={() => handleApprove(req.id)} disabled={processingReq === req.id}
                                  className="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">最終承認</button>
                              )}
                              {canFinal && (
                                <button onClick={() => rejectingId === req.id ? handleReject(req.id) : patchUi({ rejectingId: req.id, rejectReason: '' })}
                                  disabled={processingReq === req.id}
                                  className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">却下</button>
                              )}
                            </>
                            )
                          })()}
                          {req.status === 'approved' && (
                            <>
                              <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold">承認済</span>
                              {(userRole === 'admin' || userRole === 'approver') && (
                                <button
                                  onClick={() => patchUi({ modifyingId: req.id, modifyNewDate: req.date })}
                                  disabled={processingReq === req.id}
                                  className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 rounded-full text-[10px] font-bold disabled:opacity-50"
                                  title="承認済み有給の日付を変更（誤申請修正）"
                                >
                                  📝 日付変更
                                </button>
                              )}
                            </>
                          )}
                          {req.status === 'rejected' && <span className="px-2 py-1 bg-red-100 text-red-600 rounded-full text-xs font-bold">却下</span>}
                          {req.status === 'cancelled' && <span className="px-2 py-1 bg-gray-200 text-gray-600 rounded-full text-xs font-bold">取り消し</span>}
                        </div>
                      </div>
                      {/* 日付変更モードの表示（承認済み有給の修正） */}
                      {modifyingId === req.id && (
                        <div className="mt-3 border-t pt-3 bg-amber-50 dark:bg-amber-900/20 -mx-4 -mb-4 px-4 pb-4 rounded-b-xl">
                          <div className="text-xs font-bold text-amber-800 dark:text-amber-300 mb-2">
                            📝 日付変更 — 承認済み有給の日付を修正します
                          </div>
                          <div className="text-[11px] text-amber-700 dark:text-amber-400 mb-2 leading-relaxed">
                            現在の日付: <strong>{fmtDate(req.date)}</strong><br/>
                            ※ 旧日付の出面データから「有給」を削除し、新日付に「有給」を書き込みます。<br/>
                            ※ 操作は監査ログに記録されます。
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="text-xs text-gray-600">新しい日付:</label>
                            <input
                              type="date"
                              value={modifyNewDate}
                              onChange={e => patchUi({ modifyNewDate: e.target.value })}
                              className="border border-amber-300 rounded-lg px-3 py-1.5 text-sm bg-white"
                            />
                            <button
                              onClick={() => handleModifyDate(req.id, modifyNewDate)}
                              disabled={processingReq === req.id || !modifyNewDate || modifyNewDate === req.date}
                              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold disabled:opacity-50"
                            >
                              {processingReq === req.id ? '処理中...' : '日付変更を実行'}
                            </button>
                            <button
                              onClick={() => patchUi({ modifyingId: null, modifyNewDate: '' })}
                              className="px-3 py-1.5 bg-gray-200 text-gray-600 rounded-lg text-xs"
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      )}
                      {rejectingId === req.id && (
                        <div className="mt-3 flex items-center gap-2 border-t pt-3">
                          <input type="text" value={rejectReason} onChange={e => patchUi({ rejectReason: e.target.value })} placeholder="却下理由（任意）"
                            className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-1.5 text-sm" />
                          <button onClick={() => handleReject(req.id)} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-bold">却下する</button>
                          <button onClick={() => patchUi({ rejectingId: null })} className="px-2 py-1.5 bg-gray-200 text-gray-600 rounded-lg text-xs">取消</button>
                        </div>
                      )}
                      {/* 日付変更履歴の表示（あれば） */}
                      {req.dateModifyHistory && req.dateModifyHistory.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-100 text-[10px] text-gray-500">
                          <span className="font-bold">📝 修正履歴:</span>
                          {req.dateModifyHistory.map((h, i) => (
                            <span key={i} className="ml-2">
                              {h.previousDate} → {h.newDate} ({fmtTs(h.modifiedAt)})
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            }
            // 集約表示（2件以上のグループ）
            const dates = items.map(r => r.date).sort()
            const ids = items.map(r => r.id)
            const bulkKey = `bulk:${first.status === 'pending' ? 'foreman_approve' : 'approve'}:${ids[0]}`
            const bulkRejectKey = `bulk:reject:${ids[0]}`
            const isAdminLike = userRole === 'admin' || userRole === 'approver'
            const canFA = isAdminLike || (userRole === 'foreman' && userForemanSites.includes(first.siteId))
            const canFinal = isAdminLike
            const fName = resolveForemanName(first.siteId, first.date)
            return (
              <div key={group.key} className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border p-4 ${first.status === 'pending' ? 'border-yellow-300' : 'border-blue-300'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-bold text-hibi-navy dark:text-white">{first.workerName}</span>
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full font-bold">{items.length}件</span>
                      <span className="text-xs text-gray-400">{getSiteName(first.siteId)}</span>
                      {first.status === 'foreman_approved' && (
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">{fName ? `${fName} 職長済` : '職長済'}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 break-words">
                      {dates.map(d => fmtDate(d)).join('・')}
                    </div>
                    {first.reason && <div className="text-xs text-gray-500">理由: {first.reason}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                    {first.status === 'pending' && canFA && (
                      <button onClick={() => handleBulkAction(ids, 'foreman_approve')} disabled={processingReq === bulkKey}
                        className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">
                        {fName ? `${fName} 一括職長承認` : '一括職長承認'}
                      </button>
                    )}
                    {first.status === 'foreman_approved' && canFinal && (
                      <button onClick={() => handleBulkAction(ids, 'approve')} disabled={processingReq === bulkKey}
                        className="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">
                        一括最終承認
                      </button>
                    )}
                    {(canFA || canFinal) && (
                      <button onClick={() => rejectingId === group.key ? handleBulkAction(ids, 'reject', { reason: rejectReason }) : patchUi({ rejectingId: group.key, rejectReason: '' })}
                        disabled={processingReq === bulkRejectKey}
                        className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">全て却下</button>
                    )}
                    <button onClick={() => {
                      const next = new Set(expandedGroups)
                      next.add(group.key)
                      patchUi({ expandedGroups: next })
                    }} className="px-2 py-1 text-xs text-blue-600 hover:underline">▼ 個別</button>
                  </div>
                </div>
                {rejectingId === group.key && (
                  <div className="mt-3 flex items-center gap-2 border-t pt-3">
                    <input type="text" value={rejectReason} onChange={e => patchUi({ rejectReason: e.target.value })} placeholder="却下理由（任意・全件共通）"
                      className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-1.5 text-sm" />
                    <button onClick={() => handleBulkAction(ids, 'reject', { reason: rejectReason })} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-bold">{items.length}件 却下</button>
                    <button onClick={() => patchUi({ rejectingId: null })} className="px-2 py-1.5 bg-gray-200 text-gray-600 rounded-lg text-xs">取消</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

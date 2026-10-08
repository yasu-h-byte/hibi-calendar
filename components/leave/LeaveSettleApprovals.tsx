'use client'

/**
 * 有給精算の承認（日本人の日給月給・2026-10-08 代表決定。決まりは lib/leave-settle.ts）
 *
 * - マイページ（token）: 政仁さん・代表に「承認待ち」だけを出す。対象外の人には何も出さない
 * - 休暇管理（password）: 承認待ち＋これまでの申請。承認済みの取り消し（残数を戻す）もここ
 * 承認・却下・取り消しはサーバで権限と上限（残数・年5日の枠・月24日）を確かめ直す。金額は出さない。
 */
import { useCallback, useEffect, useState } from 'react'
import { confirmDialog, confirmDanger, confirmWithReason } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { ymLabel, type LeaveSettleRequest } from '@/lib/leave-settle'

const STATUS: Record<LeaveSettleRequest['status'], { label: string; cls: string }> = {
  pending: { label: '承認待ち', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: '承認済み', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '却下', cls: 'bg-red-100 text-red-600' },
  cancelled: { label: '本人が取り消し', cls: 'bg-gray-200 text-gray-500' },
  revoked: { label: '承認の取り消し', cls: 'bg-gray-200 text-gray-500' },
}

export default function LeaveSettleApprovals({ token, password, canApprove = true }: {
  /** マイページから（政仁さん・代表） */
  token?: string
  /** 休暇管理から */
  password?: string
  /** 休暇管理で、最終承認の権限がある人か（無ければ見るだけ） */
  canApprove?: boolean
}) {
  const [requests, setRequests] = useState<LeaveSettleRequest[] | null>(null)
  const [busy, setBusy] = useState('')
  const [showAll, setShowAll] = useState(false)
  const isMypage = !!token

  const load = useCallback(async () => {
    try {
      const res = isMypage
        ? await fetch(`/api/leave-settle?token=${token}&scope=approvals`)
        : await fetch('/api/leave-settle', { headers: { 'x-admin-password': password || '' } })
      if (!res.ok) { setRequests([]); return }
      setRequests((await res.json()).requests || [])
    } catch { setRequests([]) }
  }, [isMypage, token, password])

  useEffect(() => { load() }, [load])

  const act = async (r: LeaveSettleRequest, action: 'approve' | 'reject' | 'revoke') => {
    const who = `${r.workerName || r.workerId}さん ${ymLabel(r.ym)}分 ${r.days}日`
    let reason: string | undefined
    if (action === 'approve') {
      if (!(await confirmDialog({
        title: `${who} の有給精算を承認しますか？`,
        description: '有給の残りから引いて、その月の給料に「有給精算手当」として足します。',
        confirmLabel: '承認する',
      }))) return
    } else if (action === 'reject') {
      const r2 = await confirmWithReason({ title: `${who} の有給精算を却下しますか？`, confirmLabel: '却下する', tone: 'danger', reason: { label: '却下の理由（本人に見えます）' } })
      if (r2 === null) return
      reason = r2
    } else {
      if (!(await confirmDanger({
        title: `${who} の承認を取り消しますか？`,
        description: '有給の残りに戻し、給料の有給精算手当からも外します。締めた月は取り消せません。',
        confirmLabel: '承認を取り消す',
      }))) return
    }
    setBusy(r.id)
    try {
      const res = await fetch('/api/leave-settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(password ? { 'x-admin-password': password } : {}) },
        body: JSON.stringify({ action, id: r.id, reason, ...(token ? { token } : {}) }),
      })
      if (!res.ok) {
        notify.failed(action === 'approve' ? '承認' : action === 'reject' ? '却下' : '取り消し',
          (await res.json().catch(() => null))?.error || 'サーバが受け付けませんでした')
        return
      }
      notify.success(action === 'approve' ? `${who} を承認しました` : action === 'reject' ? `${who} を却下しました` : `${who} の承認を取り消しました`)
      await load()
    } catch (e) {
      notify.failed('有給精算', e)
    } finally { setBusy('') }
  }

  if (requests === null) return null
  const pending = requests.filter(r => r.status === 'pending')
  // マイページは承認待ちがあるときだけ出す
  if (isMypage && pending.length === 0) return null
  const others = requests.filter(r => r.status !== 'pending')
  const shown = showAll ? others : others.slice(0, 10)

  const row = (r: LeaveSettleRequest) => (
    <div key={r.id} className="py-2 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-sm text-gray-800">{r.workerName || r.workerId}</span>
        <span className="text-sm text-gray-700 tabular-nums">{ymLabel(r.ym)}分 {r.days}日</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
        <span className="text-xs text-hibi-sub ml-auto">申請 {(() => { const t = new Date(r.requestedAt); return `${t.getMonth() + 1}/${t.getDate()}` })()}</span>
      </div>
      {r.reason && <div className="text-xs text-gray-600 mt-0.5">理由: {r.reason}</div>}
      {r.status === 'rejected' && r.rejectedReason && <div className="text-xs text-red-700 mt-0.5">却下の理由: {r.rejectedReason}</div>}
      {canApprove && r.status === 'pending' && (
        <div className="flex gap-2 mt-2">
          <button type="button" disabled={busy === r.id} onClick={() => act(r, 'approve')}
            className="flex-1 min-h-[44px] rounded-xl bg-green-600 text-white font-bold text-sm active:bg-green-700 disabled:opacity-40">承認する</button>
          <button type="button" disabled={busy === r.id} onClick={() => act(r, 'reject')}
            className="min-h-[44px] px-4 rounded-xl border-2 border-red-200 bg-red-50 text-red-700 font-bold text-sm active:bg-red-100 disabled:opacity-40">却下</button>
        </div>
      )}
      {!isMypage && canApprove && r.status === 'approved' && (
        <button type="button" disabled={busy === r.id} onClick={() => act(r, 'revoke')}
          className="mt-1.5 min-h-[36px] px-3 rounded-lg border border-gray-300 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40">承認を取り消す</button>
      )}
    </div>
  )

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="flex items-baseline gap-2 mb-1">
        <div className="text-sm font-bold text-gray-700">有給精算の申請</div>
        {pending.length > 0 && <span className="text-xs font-bold text-amber-700">承認待ち {pending.length}件</span>}
      </div>
      <p className="text-xs text-hibi-sub mb-2">日本人の日給月給の人が、有給の残りを給料に回す申請です（年5日の分は残す・月24日まで）。</p>
      {pending.length === 0 && others.length === 0 && <div className="text-sm text-gray-400 py-2">申請はありません</div>}
      {pending.map(row)}
      {!isMypage && others.length > 0 && (
        <details className="mt-2" open={pending.length === 0}>
          <summary className="text-xs font-bold text-gray-500 cursor-pointer py-1">これまでの申請（{others.length}件）</summary>
          {shown.map(row)}
          {!showAll && others.length > 10 && (
            <button type="button" onClick={() => setShowAll(true)} className="text-xs text-blue-600 font-bold mt-1">すべて見る</button>
          )}
        </details>
      )}
    </div>
  )
}

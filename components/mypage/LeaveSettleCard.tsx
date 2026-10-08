'use client'

/**
 * マイページの「有給精算」（日本人の日給月給の人だけ・2026-10-08 代表決定）
 *
 * 仕事の少ない月に、有給の残りを日数で給料に回す。決まりは lib/leave-settle.ts。
 * 対象外の人（月給・役員・外国人）には何も出さない（API が eligible:false を返す）。
 * 金額は出さない（日数だけ）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { SaveButton } from '@/components/ui/SaveButton'
import { confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { LEAVE_SETTLE_MONTH_CAP_DAYS, ymLabel, type LeaveSettleRequest } from '@/lib/leave-settle'

interface MonthOption {
  ym: string
  label: string
  maxDays: number
  blockReason?: string
  breakdown: { remainingFree: number; reserve: number; monthRoom: number } | null
}

const STATUS: Record<LeaveSettleRequest['status'], { label: string; cls: string }> = {
  pending: { label: '承認待ち', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: '承認済み', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '却下', cls: 'bg-red-100 text-red-600' },
  cancelled: { label: '取り消し', cls: 'bg-gray-200 text-gray-500' },
  revoked: { label: '承認の取り消し', cls: 'bg-gray-200 text-gray-500' },
}

export default function LeaveSettleCard({ token, onChanged }: { token: string; onChanged?: () => void }) {
  const [eligible, setEligible] = useState(false)
  const [months, setMonths] = useState<MonthOption[]>([])
  const [requests, setRequests] = useState<LeaveSettleRequest[]>([])
  const [ym, setYm] = useState('')
  const [days, setDays] = useState(1)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leave-settle?token=${token}`)
      if (!res.ok) return
      const d = await res.json()
      setEligible(!!d.eligible)
      if (!d.eligible) return
      const ms: MonthOption[] = d.months || []
      setMonths(ms)
      setRequests(d.requests || [])
      // 申請できる月があれば、新しい月を先に選ぶ
      setYm(prev => (prev && ms.some(m => m.ym === prev && m.maxDays > 0)) ? prev
        : ([...ms].reverse().find(m => m.maxDays > 0)?.ym || ms[ms.length - 1]?.ym || ''))
    } catch { /* 読めないときはカードを出さないだけ */ }
  }, [token])

  useEffect(() => { load() }, [load])

  if (!eligible) return null

  const cur = months.find(m => m.ym === ym)
  const max = cur?.maxDays ?? 0
  const d = Math.min(Math.max(1, days), Math.max(1, max))

  const submit = async (): Promise<{ ok: boolean; error?: string } | void> => {
    if (!cur || max <= 0) return
    const res = await fetch('/api/leave-settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request', token, ym, days: d }),
    })
    if (!res.ok) return { ok: false, error: (await res.json().catch(() => null))?.error || 'サーバが受け付けませんでした' }
    notify.success(`${cur.label}分の有給精算 ${d}日 を申請しました`)
    setDays(1)
    await load()
    onChanged?.()
  }

  const cancel = async (r: LeaveSettleRequest) => {
    if (!(await confirmDanger({ title: `${ymLabel(r.ym)}分の有給精算（${r.days}日）の申請を取り消しますか？`, confirmLabel: '取り消す' }))) return
    try {
      const res = await fetch('/api/leave-settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', token, id: r.id }),
      })
      if (!res.ok) {
        notify.failed('取り消し', (await res.json().catch(() => null))?.error || 'サーバが受け付けませんでした')
        return
      }
      await load()
      onChanged?.()
    } catch (e) { notify.failed('取り消し', e) }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="text-sm font-bold text-gray-500 mb-2 inline-flex items-center gap-1.5"><Icon name="yen" size={15} />有給精算（給料に回す）</div>
      <p className="text-xs text-hibi-sub leading-relaxed">
        仕事の少ない月に、有給の残りを給料に回せます（1日 = 日額1日分）。
        年5日の有給（現場が動いている日に休む分）は先に残しておきます。
        出勤・有給などと合わせて月{LEAVE_SETTLE_MONTH_CAP_DAYS}日までです。
      </p>

      {months.length > 1 && (
        <div className="flex gap-2 mt-3">
          {months.map(m => (
            <button key={m.ym} type="button" onClick={() => { setYm(m.ym); setDays(1) }}
              className={`flex-1 min-h-[44px] rounded-xl border-2 font-bold text-sm ${m.ym === ym ? 'border-hibi-amber bg-amber-50 text-hibi-charcoal' : 'border-gray-200 bg-white text-gray-500'}`}>
              {m.label}分
            </button>
          ))}
        </div>
      )}

      {cur && (max > 0 ? (
        <div className="mt-3">
          <div className="text-sm text-gray-700">
            {cur.label}分は <span className="font-extrabold text-lg tabular-nums">{max}</span> 日まで精算できます
            {(cur.breakdown?.reserve ?? 0) > 0 && (
              <span className="block text-xs text-hibi-sub mt-0.5">年5日のために {cur.breakdown!.reserve}日 は残しています</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button type="button" aria-label="1日へらす" onClick={() => setDays(Math.max(1, d - 1))} disabled={d <= 1}
              className="w-12 h-12 rounded-xl border-2 border-gray-300 text-xl font-extrabold disabled:opacity-30 active:bg-gray-100">−</button>
            <div className="flex-1 text-center">
              <span className="text-3xl font-extrabold tabular-nums">{d}</span>
              <span className="text-sm text-gray-500 ml-1">日</span>
            </div>
            <button type="button" aria-label="1日ふやす" onClick={() => setDays(Math.min(max, d + 1))} disabled={d >= max}
              className="w-12 h-12 rounded-xl border-2 border-gray-300 text-xl font-extrabold disabled:opacity-30 active:bg-gray-100">＋</button>
          </div>
          <SaveButton action="申請" label={`${cur.label}分 ${d}日 を申請する`} size="lg" className="w-full mt-3" onSave={submit} />
        </div>
      ) : (
        <div className="mt-3 text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
          {cur.label}分: {cur.blockReason || '精算できません'}
        </div>
      ))}

      {requests.length > 0 && (
        <div className="border-t border-gray-100 mt-4 pt-3 space-y-1">
          <div className="text-xs font-bold text-gray-500 mb-1">申請の履歴</div>
          {requests.slice(0, 12).map(r => (
            <div key={r.id}>
              <div className="flex items-center justify-between gap-2 min-h-[44px]">
                <span className="text-sm text-gray-700">{ymLabel(r.ym)}分 {r.days}日</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                {r.status === 'pending' && (
                  <button type="button" onClick={() => cancel(r)}
                    className="text-sm text-red-600 font-bold whitespace-nowrap min-h-[44px] px-3 rounded-xl border-2 border-red-200 bg-red-50 active:bg-red-100">
                    取り消す
                  </button>
                )}
              </div>
              {r.status === 'rejected' && r.rejectedReason && (
                <div className="text-sm text-red-800 -mt-1 mb-1">却下の理由: {r.rejectedReason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

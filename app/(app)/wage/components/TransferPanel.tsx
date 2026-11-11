'use client'

/**
 * 新卒（月給）→ 日給月給への移行（docs/wage-system.md 第13節・2026-11-11 代表決定）。
 *
 * 移行日と号は決まりから自動で出る（lib/jp-transfer.ts）。ここでは予定を見て、移行日が来たら確定する。
 * 人員マスタを手で直すと過去の月の計算まで変わるので、必ずこの画面から行う。
 */

import { useCallback, useEffect, useState } from 'react'
import { readAuth } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth } from '@/lib/api-client'
import { fmtYen as yen } from '@/lib/format'
import { confirmDialog, confirmDanger } from '@/lib/confirm-dialog'
import { dailyForStep, MAX_STEP } from '@/lib/jp-wage'
import {
  JP_TRANSFER_GRADE, JP_TRANSFER_MIN_AGE, NEW_GRAD_ANNUAL_WORK_DAYS,
  type TransferPlacement, type TransferSchedule, type TransferStatus,
} from '@/lib/jp-transfer'

interface Candidate {
  id: number; name: string; hireDate: string; monthly: number
  schedule: TransferSchedule; status: TransferStatus; placement: TransferPlacement
}
interface Rec {
  id: string; workerId: number; name: string; at: string
  fromMonthly: number; dailyFromMonthly: number
  toGrade: string; ruleStep: number; toStep: number; toDaily: number
  reason: string; decidedAt: string; cancelledAt?: string
}

const STATUS: Record<TransferStatus, { label: string; cls: string }> = {
  needInput: { label: '要入力', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  waiting:   { label: '月給のまま', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
  soon:      { label: 'もうすぐ', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  due:       { label: '確定してください', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

export default function TransferPanel({ onChanged }: { onChanged?: () => void }) {
  const [pw, setPw] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [records, setRecords] = useState<Rec[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stepById, setStepById] = useState<Record<number, string>>({})
  const [reasonById, setReasonById] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async (password: string) => {
    try {
      const res = await fetchWithAuth('/api/jp-wage/transfer', { password })
      if (!res.ok) throw new Error()
      const j = await res.json()
      setCandidates(j.candidates); setRecords(j.records)
    } catch { setErr('読み込みに失敗しました') } finally { setLoaded(true) }
  }, [])

  useEffect(() => {
    const raw = readAuth()
    const p = raw ? raw?.password : ''
    if (!p) { setLoaded(true); return }
    setPw(p); load(p)
  }, [load])

  const apply = async (c: Candidate) => {
    const step = stepById[c.id] ? Math.trunc(Number(stepById[c.id])) : c.placement.step
    const reason = (reasonById[c.id] || '').trim()
    if (!(await confirmDialog({
      title: `${c.name} さんを日給月給へ移しますか？`,
      description: `${c.schedule.date} から: 月給 ${yen(c.monthly)} → ${JP_TRANSFER_GRADE} ${step}号 日額 ${yen(dailyForStep(JP_TRANSFER_GRADE, step))}\n`
        + '人員マスタが書き換わり、記録に残ります。移行日より前の月は月給のまま計算されます。',
      confirmLabel: '移行を確定する',
    }))) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetchWithAuth('/api/jp-wage/transfer', { password: pw,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: c.id, step, reason }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `失敗しました（${res.status}）`)
      setMsg(`${c.name} さんを ${JP_TRANSFER_GRADE} ${step}号 の日給月給へ移しました`)
      await load(pw); onChanged?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失敗しました')
    } finally { setBusy(false) }
  }

  const cancel = async (r: Rec) => {
    if (!(await confirmDanger({
      title: `${r.name} さんの移行を取り消しますか？`,
      description: `月給 ${yen(r.fromMonthly)} に戻します。記録には「取り消し」として残ります。`,
      confirmLabel: '取り消す',
    }))) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetchWithAuth(`/api/jp-wage/transfer?id=${encodeURIComponent(r.id)}`, { password: pw, method: 'DELETE' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `失敗しました（${res.status}）`)
      setMsg(`${r.name} さんの移行を取り消しました`)
      await load(pw); onChanged?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失敗しました')
    } finally { setBusy(false) }
  }

  const th = 'px-3 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-3 py-2 align-top'
  const input = 'border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none'

  return (
    <div className="space-y-5">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">新卒の移行の決まり</div>
        <ul className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed list-disc pl-5 space-y-0.5">
          <li>中卒・高卒の新卒は<b>月給</b>で入り、<b>入社した翌年の10月1日</b>に日給月給（号俸制）へ移ります（4月入社なら1年半後）。</li>
          <li>ただし<b>{JP_TRANSFER_MIN_AGE}歳になっていること</b>。その日に{JP_TRANSFER_MIN_AGE}歳未満なら、<b>{JP_TRANSFER_MIN_AGE}歳の誕生日の翌月1日</b>に移ります（それまで月給のまま）。</li>
          <li>号は <b>{JP_TRANSFER_GRADE} で「月給を日額に直した額を上回る最初の号」</b>（日額 = 月給 × 12 ÷ {NEW_GRAD_ANNUAL_WORK_DAYS}日）。</li>
          <li>移ってから6ヶ月未満の年次改定（10月1日）は対象外です。評価による昇給はその次の改定から。</li>
        </ul>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">{err}</div>}
      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      <section>
        <h3 className="text-sm font-bold mb-2">月給の新卒（移行を待っている人）</h3>
        {!loaded ? (
          <p className="text-xs text-gray-400">読み込み中…</p>
        ) : candidates.length === 0 ? (
          <p className="text-xs text-gray-400">いま月給の新卒はいません。</p>
        ) : (
          <div className="space-y-3">
            {candidates.map(c => {
              const st = STATUS[c.status]
              const stepRaw = stepById[c.id]
              const step = stepRaw ? Math.trunc(Number(stepRaw)) : c.placement.step
              const stepOk = Number.isFinite(step) && step >= c.placement.step && step <= MAX_STEP
              const changed = step !== c.placement.step
              const reason = (reasonById[c.id] || '').trim()
              return (
                <div key={c.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="font-bold">{c.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${st.cls}`}>{st.label}</span>
                  </div>
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div><dt className="text-xs text-gray-500">入社日</dt><dd className="tabular-nums">{c.hireDate || '未登録'}</dd></div>
                    <div><dt className="text-xs text-gray-500">いまの月給</dt><dd className="tabular-nums">{yen(c.monthly)}</dd></div>
                    <div>
                      <dt className="text-xs text-gray-500">移行日</dt>
                      <dd className="tabular-nums font-bold">{c.schedule.date || '決まりません'}</dd>
                      {c.schedule.waitsForAge && (
                        <dd className="text-2xs text-gray-500">入社翌年の10月1日（{c.schedule.baseDate}）には{JP_TRANSFER_MIN_AGE}歳未満のため、{JP_TRANSFER_MIN_AGE}歳の誕生日の翌月1日</dd>
                      )}
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">移行後（決まりどおり）</dt>
                      <dd className="tabular-nums font-bold">{c.placement.grade} {c.placement.step}号 {yen(c.placement.daily)}</dd>
                      <dd className="text-2xs text-gray-500">月給を日額に直すと {yen(c.placement.dailyFromMonthly)}</dd>
                    </div>
                  </dl>

                  {c.status === 'needInput' && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-3">
                      {c.schedule.blockers.join('・')}。
                      <a href={`/workers?edit=${c.id}`} className="underline ml-1">人員マスタで入れる</a>
                    </p>
                  )}

                  {c.status === 'due' && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">号（{c.placement.step}号以上）</label>
                          <input type="number" min={c.placement.step} max={MAX_STEP} step={1}
                            value={stepRaw ?? String(c.placement.step)}
                            onChange={e => setStepById(s => ({ ...s, [c.id]: e.target.value }))}
                            className={`${input} w-24 tabular-nums`} />
                        </div>
                        <div className="flex-1 min-w-[14rem]">
                          <label className="text-xs text-gray-500 block mb-1">理由（決まりの号から変えるときは必須）</label>
                          <input type="text" value={reasonById[c.id] || ''}
                            onChange={e => setReasonById(s => ({ ...s, [c.id]: e.target.value }))}
                            placeholder="例：資格を取ったため 2号上げる"
                            className={`${input} w-full ${changed && !reason ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20' : ''}`} />
                        </div>
                        <button onClick={() => apply(c)}
                          disabled={busy || !stepOk || (changed && !reason)}
                          className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
                          {busy ? '処理中…' : '移行を確定する'}
                        </button>
                      </div>
                      {stepOk && (
                        <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 tabular-nums">
                          確定すると {c.schedule.date} から <b>{JP_TRANSFER_GRADE} {step}号 日額 {yen(dailyForStep(JP_TRANSFER_GRADE, step))}</b>。
                          移行日の月を締める前に確定してください。
                        </p>
                      )}
                    </div>
                  )}
                  {(c.status === 'waiting' || c.status === 'soon') && (
                    <p className="text-2xs text-gray-500 mt-3">移行日になると、ここで確定できるようになります。60日前から通知ベルでお知らせします。</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-bold mb-2">移行の記録</h3>
        {records.length === 0 ? (
          <p className="text-xs text-gray-400">まだ記録がありません。</p>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
            <table className="w-full text-sm min-w-[680px]">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className={`${th} text-left`}>移行日</th><th className={`${th} text-left`}>氏名</th>
                  <th className={`${th} text-right`}>月給</th><th className={`${th} text-left`}>移行後</th>
                  <th className={`${th} text-left`}>理由</th><th className={th}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {records.map(r => (
                  <tr key={r.id} className={r.cancelledAt ? 'text-gray-400' : ''}>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>{r.at}</td>
                    <td className={`${td} font-medium whitespace-nowrap`}>{r.name}</td>
                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{yen(r.fromMonthly)}</td>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>
                      <b>{r.toGrade} {r.toStep}号 {yen(r.toDaily)}</b>
                      {r.toStep !== r.ruleStep && <div className="text-2xs text-gray-500">決まりの号は {r.ruleStep}号</div>}
                    </td>
                    <td className={td}>{r.reason || '—'}</td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      {r.cancelledAt
                        ? <span className="text-xs">取り消し済み</span>
                        : <button onClick={() => cancel(r)} disabled={busy} className="text-xs text-red-600 dark:text-red-400 underline disabled:opacity-40">取り消す</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

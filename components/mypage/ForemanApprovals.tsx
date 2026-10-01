'use client'

import { useCallback, useEffect, useState } from 'react'

// マイページの「承認すること」（2026-10-01 代表依頼）
//   職長: 出面（全員入力済みの日をまとめて）・有給申請・帰国申請 の職長承認
//   政仁さん・代表: 出面の最終承認・有給／帰国申請の最終承認・職長がいない現場の代行・配置の見直し
//   屋外・日光の下で押すので、ボタンは大きく・色だけに頼らず文字で状態を書く。

interface AttendanceBlock {
  siteId: string
  siteName: string
  ym: string
  ymLabel: string
  ready: { day: number; dateISO: string; entered: number }[]
  missing: { day: number; dateISO: string; missingNames: string[] }[]
  elsewhereNames: string[]
  approvedCount: number
  proxy?: boolean
}
interface FinalBlock { siteId: string; siteName: string; ym: string; ymLabel: string; days: { day: number; dateISO: string }[]; finalCount: number }
type Stage = 'foreman' | 'final' | 'proxy'
interface LeaveItem { id: string; workerName: string; date: string; reason: string; siteName: string; stage: Stage }
interface HomeLeaveItem { id: string; workerName: string; startDate: string; endDate: string; reason: string; stage: Stage }
interface StaleItem { siteId: string; siteName: string; workerId: number; workerName: string; workingAt: string[] }
interface Data {
  isForeman: boolean
  role: 'foreman' | 'manager' | null
  attendance: AttendanceBlock[]
  finalAttendance: FinalBlock[]
  leaveRequests: LeaveItem[]
  homeLeaves: HomeLeaveItem[]
  stale: StaleItem[]
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土']
/** 2026-09-03 → 9/3（木） */
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}（${WEEK[new Date(`${iso}T00:00:00`).getDay()]}）`

const STAGE_LABEL: Record<Stage, string> = { foreman: '承認する', final: '最終承認する', proxy: '承認する（職長の代行）' }

export default function ForemanApprovals({ token, canApprove }: {
  token: string
  /** 承認欄を出す人か（職長・政仁さん・代表）。読み込み中の枠を出すかどうか。最終判断はサーバ */
  canApprove: boolean
}) {
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState<string>('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mypage/approvals?token=${token}`)
      if (res.ok) setData(await res.json())
    } catch { /* 承認欄が出ないだけ（マイページの他の部分は使える） */ }
  }, [token])
  useEffect(() => { load() }, [load])

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 5000) }
  const manager = data?.role === 'manager'

  const postDays = async (action: 'approve_days' | 'final_days', siteId: string, ym: string, days: number[], question: string) => {
    if (!confirm(question)) return
    setBusy(`${action}_${siteId}_${ym}`)
    try {
      const res = await fetch('/api/mypage/approvals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action, siteId, ym, days }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) { alert(j?.error || '承認できませんでした'); return }
      const skipped = (j?.skipped || []) as { day: number; reason: string }[]
      flash(`${j?.approvedDays?.length ?? 0}日分を${action === 'final_days' ? '最終承認' : '承認'}しました${skipped.length ? `（${skipped.length}日は条件がそろっていないため承認していません）` : ''}`)
      load()
    } catch { alert('通信エラーが発生しました') } finally { setBusy('') }
  }

  const actLeave = async (kind: 'leave' | 'home', id: string, stage: Stage, approve: boolean, label: string) => {
    let reason = ''
    if (approve) {
      const after = stage === 'foreman' ? '（このあと政仁さんが最終承認します）' : '（これで承認が完了します）'
      if (!confirm(`${label}\n\nこの申請を承認します${after}。よろしいですか？`)) return
    } else {
      const r = prompt(`${label}\n\n却下する理由を入れてください（本人に伝わります）`)
      if (r === null) return
      reason = r
    }
    setBusy(`${kind}_${id}`)
    try {
      const res = await fetch(kind === 'leave' ? '/api/leave-request' : '/api/home-long-leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(!approve
          ? { action: 'reject', requestId: id, token, reason }
          : stage === 'foreman'
            ? { action: 'foreman_approve', requestId: id, token }
            // 最終承認（職長がいない現場は代行して最終承認まで）
            : { action: 'approve', requestId: id, token }),
      })
      if (!res.ok) {
        // 理由の文（message）を優先して出す（帰国申請の期間内に出勤がある 409 は error がコード名だけ・2026-10-01）
        const j = await res.json().catch(() => null)
        alert(j?.message ?? j?.error ?? 'できませんでした')
        return
      }
      flash(!approve ? '却下しました。' : stage === 'foreman' ? '承認しました。政仁さんの最終承認を待ちます。' : '承認しました。')
      load()
    } catch { alert('通信エラーが発生しました') } finally { setBusy('') }
  }

  if (!data) {
    // 読み込み中（数秒かかることがある）。承認する人にだけ枠を先に出しておく（あとから急にカードが出て画面がずれないように）
    return canApprove ? (
      <div className="bg-white rounded-xl border-2 border-hibi-navy/20 shadow-sm p-4">
        <div className="text-base font-extrabold text-hibi-charcoal">承認すること</div>
        <div className="text-sm text-gray-400 mt-2">読み込み中...</div>
      </div>
    ) : null
  }
  if (!data.isForeman) return null

  const total = data.attendance.reduce((s, b) => s + b.ready.length, 0)
    + data.finalAttendance.reduce((s, b) => s + b.days.length, 0)
    + data.leaveRequests.length + data.homeLeaves.length

  return (
    <div className="bg-white rounded-xl border-2 border-hibi-navy/20 shadow-sm p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-base font-extrabold text-hibi-charcoal">承認すること</div>
        {total > 0
          ? <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-600 text-white">{total}件</span>
          : <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-800">ありません</span>}
      </div>
      {msg && <div className="bg-green-100 text-green-800 rounded-lg p-3 text-sm font-bold">{msg}</div>}

      {/* ── 出面の最終承認（政仁さん・代表） ── */}
      {data.finalAttendance.map(b => (
        <section key={`final_${b.siteId}_${b.ym}`} className="rounded-lg border border-gray-200 p-3 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="font-bold text-gray-900">出面の最終承認 <span className="text-gray-500 font-normal">{b.ymLabel}・{b.siteName}</span></div>
            <div className="text-xs text-gray-500 whitespace-nowrap">最終承認済み {b.finalCount}日</div>
          </div>
          <div className="text-xs text-gray-500">職長承認済みの日</div>
          <div className="flex flex-wrap gap-1.5">
            {b.days.map(d => <span key={d.day} className="text-xs px-2 py-1 rounded-md bg-green-50 text-green-800 font-bold tabular-nums">{md(d.dateISO)}</span>)}
          </div>
          <button disabled={!!busy}
            onClick={() => postDays('final_days', b.siteId, b.ym, b.days.map(d => d.day),
              `${b.siteName} の ${b.ymLabel}\n${b.days.map(d => md(d.dateISO)).join('、')}\n\nこの ${b.days.length}日分の出面を最終承認します。よろしいですか？`)}
            className="w-full rounded-xl py-3.5 bg-green-700 text-white text-base font-extrabold active:opacity-80 disabled:opacity-40">
            {busy === `final_days_${b.siteId}_${b.ym}` ? '最終承認中...' : `${b.days.length}日分を最終承認する`}
          </button>
        </section>
      ))}

      {/* ── 出面の職長承認（職長・代行） ── */}
      {data.attendance.map(b => (
        <section key={`${b.siteId}_${b.ym}`} className="rounded-lg border border-gray-200 p-3 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="font-bold text-gray-900">
              出面{b.proxy ? 'の職長承認（代行）' : ''} <span className="text-gray-500 font-normal">{b.ymLabel}・{b.siteName}</span>
            </div>
            <div className="text-xs text-gray-500 whitespace-nowrap">承認済み {b.approvedCount}日</div>
          </div>
          {b.ready.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {b.ready.map(d => (
                  <span key={d.day} className="text-xs px-2 py-1 rounded-md bg-blue-50 text-blue-800 font-bold tabular-nums">{md(d.dateISO)}</span>
                ))}
              </div>
              <button disabled={!!busy}
                onClick={() => postDays('approve_days', b.siteId, b.ym, b.ready.map(d => d.day),
                  `${b.siteName} の ${b.ymLabel}\n${b.ready.map(d => md(d.dateISO)).join('、')}\n\nこの ${b.ready.length}日分の出面を承認します。承認するとスタッフはその日を直せなくなります。よろしいですか？`)}
                className="w-full rounded-xl py-3.5 bg-hibi-navy text-white text-base font-extrabold active:opacity-80 disabled:opacity-40">
                {busy === `approve_days_${b.siteId}_${b.ym}` ? '承認中...' : `全員入力済みの ${b.ready.length}日分を承認する`}
              </button>
            </>
          ) : (
            <div className="text-sm text-gray-500">全員の入力がそろった未承認の日はありません</div>
          )}
          {b.missing.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
              <div className="text-xs font-bold text-amber-900 mb-1">入力がそろっていない日（そろうと承認できます。未入力のままだと欠勤になります）</div>
              <ul className="text-xs text-amber-900 space-y-0.5">
                {b.missing.slice(0, 8).map(d => (
                  <li key={d.day}><span className="tabular-nums font-bold">{md(d.dateISO)}</span> {d.missingNames.join('、')}</li>
                ))}
                {b.missing.length > 8 && <li>ほか {b.missing.length - 8}日</li>}
              </ul>
            </div>
          )}
          {b.elsewhereNames.length > 0 && (
            <div className="text-[11px] text-gray-500 leading-relaxed">
              {b.elsewhereNames.join('、')} さんは別の現場で入力しているため、この現場の未入力には数えていません
            </div>
          )}
        </section>
      ))}

      {/* ── 有給申請 ── */}
      {data.leaveRequests.length > 0 && (
        <section className="space-y-2">
          <div className="font-bold text-gray-900">有給の申請</div>
          {data.leaveRequests.map(r => {
            const label = `${r.workerName} さん・${md(r.date)}${r.reason ? `・${r.reason}` : ''}`
            return (
              <div key={r.id} className="rounded-lg border border-gray-200 p-3">
                <div className="text-sm"><b>{r.workerName}</b> さん <span className="tabular-nums font-bold">{md(r.date)}</span></div>
                <div className="text-xs text-gray-500">
                  {r.siteName}{r.reason && `・${r.reason}`}
                  {r.stage === 'final' && '・職長承認済み'}{r.stage === 'proxy' && '・職長がいない現場'}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
                  <button onClick={() => actLeave('leave', r.id, r.stage, true, label)} disabled={!!busy}
                    className="rounded-xl py-3 bg-hibi-navy text-white font-extrabold active:opacity-80 disabled:opacity-40">{STAGE_LABEL[r.stage]}</button>
                  <button onClick={() => actLeave('leave', r.id, r.stage, false, label)} disabled={!!busy}
                    className="rounded-xl py-3 px-4 border-2 border-red-300 text-red-700 font-bold active:bg-red-50 disabled:opacity-40">却下</button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* ── 帰国申請 ── */}
      {data.homeLeaves.length > 0 && (
        <section className="space-y-2">
          <div className="font-bold text-gray-900">帰国の申請</div>
          {data.homeLeaves.map(r => {
            const label = `${r.workerName} さん・${md(r.startDate)}〜${md(r.endDate)}`
            return (
              <div key={r.id} className="rounded-lg border border-gray-200 p-3">
                <div className="text-sm"><b>{r.workerName}</b> さん</div>
                <div className="text-sm tabular-nums font-bold">{md(r.startDate)} 〜 {md(r.endDate)}</div>
                <div className="text-xs text-gray-500">
                  {r.reason}{r.stage === 'final' && `${r.reason ? '・' : ''}職長承認済み`}{r.stage === 'proxy' && `${r.reason ? '・' : ''}職長がいない現場`}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
                  <button onClick={() => actLeave('home', r.id, r.stage, true, label)} disabled={!!busy}
                    className="rounded-xl py-3 bg-hibi-navy text-white font-extrabold active:opacity-80 disabled:opacity-40">{STAGE_LABEL[r.stage]}</button>
                  <button onClick={() => actLeave('home', r.id, r.stage, false, label)} disabled={!!busy}
                    className="rounded-xl py-3 px-4 border-2 border-red-300 text-red-700 font-bold active:bg-red-50 disabled:opacity-40">却下</button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* ── 配置の見直し（政仁さん・代表） ── */}
      {data.stale.length > 0 && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1.5">
          <div className="font-bold text-amber-900">配置の見直し</div>
          <div className="text-xs text-amber-900">2週間この現場で入力がなく、別の現場で働いている人です。移動したのであれば、前の現場の配置から外してください（PC の出面入力 → 配置）。掛け持ちならそのままで大丈夫です。</div>
          <ul className="text-sm text-amber-950 space-y-0.5">
            {data.stale.map(s => (
              <li key={`${s.siteId}_${s.workerId}`}><b>{s.workerName}</b> さん：{s.siteName} → いまは {s.workingAt.join('・')}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11px] text-gray-400 leading-relaxed">
        {manager
          ? '職長がいない現場（職種が職長でない人が登録されている現場）は、ここで職長承認を代行できます。'
          : 'ここで承認すると「職長承認済み」になります。最終承認は政仁さんが行います。'}
      </p>
    </div>
  )
}

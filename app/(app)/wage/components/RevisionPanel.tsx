'use client'

/**
 * 日本人社員の賃金改定（docs/wage-system.md 第4節・基準日 毎年10月1日）
 *
 * 評価を入力し、号俸表・年齢調整・利益調整から改定額を出して人員マスタへ反映する。
 * 下書きは Firestore に保存されるので、決算の数字が出るまで置いておける。
 *
 * ⚠️ 個人の賃金を一覧するため、代表（0）と事業責任者（1）以外には表示しない。
 *    評価を決めるのはこの2名と定められている（第4節）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Hyogo, RosterStatus, SpecialReason } from '@/lib/jp-wage'

const ALLOWED_VIEWERS = [0, 1]   // 代表・事業責任者

const yen = (v: number | null | undefined) => v == null ? '—' : '¥' + Math.round(v).toLocaleString()
const signedPitch = (v: number) => (v > 0 ? '+' : '') + v

/** 選んだ事由の合計（±3でクランプ）。サーバの specialAdjustment と同じ規則 */
function specialSum(keys: string[], reasons: SpecialReason[]): number {
  const raw = keys.reduce((a, k) => a + (reasons.find(r => r.key === k)?.pitch ?? 0), 0)
  return Math.max(-3, Math.min(3, raw))
}

interface Row {
  member: {
    id: number; name: string; grade: string; currentStep: number | null
    birthDate: string | null; hireDate?: string | null
    hyogo: Hyogo; reason?: string; specialKeys?: string[]
    fixed?: boolean; adjustment?: number; forceInclude?: boolean
  }
  status: RosterStatus
  result: null | {
    hyogoPitch: number; agePitch: number; profitPitch: number; specialPitch: number
    totalPitch: number; newStep: number; raisePerDay: number; upRate: number
  }
  oldTotal: number | null
  newTotal: number | null
  tenureMonths: number | null
  blockers: string[]
}

interface Payload {
  effective: string
  status: 'draft' | 'applied'
  profitRatePercent: number | null
  appliedAt: string | null
  entries: Record<string, { hyogo: Hyogo; reason?: string; specialKeys?: string[]; forceInclude?: boolean; comment?: string }>
  revision: {
    rows: Row[]
    balance: { counts: Record<Hyogo, number>; needB: number; needC: number; ok: boolean; messages: string[] }
    applied: number; blocked: number; ineligible: number
    raisePerDay: number; annualCost: number
  }
  meta: { specialReasons: SpecialReason[]; hyogoPitch: Record<Hyogo, number>; firstRevisionMinMonths: number }
}

const HYOGO_ORDER: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']

const STATUS_CHIP: Record<RosterStatus, { label: string; cls: string }> = {
  ok:         { label: '改定',   cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  fixed:      { label: '固定',   cls: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
  ineligible: { label: '対象外', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  blocked:    { label: '要入力', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
}

export default function RevisionPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [pw, setPw] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [profitInput, setProfitInput] = useState('')
  // 特別調整の事由は行を展開して選ぶ。表の中にポップオーバーを出すと位置合わせが崩れるため
  const [openSpecial, setOpenSpecial] = useState<number | null>(null)

  const load = useCallback(async (password: string) => {
    try {
      const res = await fetch('/api/jp-wage/revision', { headers: { 'x-admin-password': password } })
      if (!res.ok) throw new Error(`取得に失敗しました（${res.status}）`)
      const j: Payload = await res.json()
      setData(j)
      setProfitInput(j.profitRatePercent === null ? '' : String(j.profitRatePercent))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '不明なエラー')
    }
  }, [])

  useEffect(() => {
    let password = ''
    try {
      const raw = localStorage.getItem('hibi_auth')
      const parsed = raw ? JSON.parse(raw) : null
      password = parsed?.password || ''
      const wid = parsed?.user?.workerId
      // workerId 0（代表）は falsy なので、必ず includes で判定する
      if (typeof wid !== 'number' || !ALLOWED_VIEWERS.includes(wid)) { setAllowed(false); return }
      setAllowed(true); setPw(password)
    } catch { setAllowed(false); return }
    load(password)
  }, [load])

  const entries = data?.entries ?? {}

  /** 下書きを保存して読み直す。計算はサーバ側の1本に寄せる */
  const save = async (patch: { entries?: Payload['entries']; profitRatePercent?: number | null }) => {
    if (!data) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/revision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({ effective: data.effective, entries: patch.entries ?? entries, profitRatePercent: patch.profitRatePercent ?? data.profitRatePercent }),
      })
      if (!res.ok) throw new Error((await res.json()).error || `保存に失敗しました（${res.status}）`)
      await load(pw)
      setMsg('保存しました')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました')
    } finally { setBusy(false) }
  }

  const setEntry = (id: number, patch: Partial<Payload['entries'][string]>) => {
    const cur = entries[String(id)] || { hyogo: 'A' as Hyogo }
    save({ entries: { ...entries, [String(id)]: { ...cur, ...patch } } })
  }

  const apply = async () => {
    if (!data) return
    if (!confirm(`${data.effective} の改定を確定し、人員マスタへ反映します。\n\n昇給額 合計 ${yen(data.revision.raisePerDay)}/日（年 ${yen(data.revision.annualCost)}）\n\n確定後は編集できません。よろしいですか？`)) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({ effective: data.effective }),
      })
      const j = await res.json()
      if (!res.ok) {
        const detail = j.blocked ? j.blocked.map((b: { name: string; reasons: string[] }) => `${b.name}: ${b.reasons.join(' / ')}`).join('\n')
          : (j.messages || []).join('\n')
        throw new Error(`${j.error}\n${detail}`)
      }
      await load(pw)
      setMsg(`確定しました（${j.count}名に反映）`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '確定に失敗しました')
    } finally { setBusy(false) }
  }

  const totals = useMemo(() => {
    if (!data) return null
    const r = data.revision
    return { raise: r.raisePerDay, annual: r.annualCost, ok: r.applied, blocked: r.blocked, ineligible: r.ineligible }
  }, [data])

  if (allowed === null) return <div className="py-10 text-gray-500">読み込み中…</div>
  if (!allowed) return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
      <h2 className="text-base font-bold mb-1">この内容は表示できません</h2>
      <p className="text-sm text-gray-500">
        改定の画面は個人の賃金を一覧するため、代表と事業責任者のみが利用できます（第4節）。
        号俸表そのものは「号俸表」タブで確認できます。
      </p>
    </div>
  )
  if (err && !data) return <div className="py-6 text-red-600 whitespace-pre-wrap">エラー: {err}</div>
  if (!data || !totals) return <div className="py-10 text-gray-500">集計中…</div>

  const applied = data.status === 'applied'
  const th = 'px-3 py-2.5 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-3 py-2.5 align-top'

  return (
    <div className="space-y-5">

      <header>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h2 className="text-lg font-bold">年次改定</h2>
          {applied
            ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">確定済み</span>
            : <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">下書き</span>}
        </div>
        <p className="text-sm text-gray-500">
          基準日 <b className="tabular-nums">{data.effective}</b>
          {applied && data.appliedAt && <>（{data.appliedAt.slice(0, 10)} に確定）</>}
          ／ 対象 {data.revision.rows.length}名
        </p>
      </header>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{err}</div>}
      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      {/* ── 経常利益率と合計 ── */}
      <section className="grid gap-4 md:grid-cols-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <label className="text-xs text-gray-500 block mb-1">経常利益率（9月決算）</label>
          <div className="flex gap-2">
            <input
              type="number" step="0.1" value={profitInput} disabled={applied}
              onChange={e => setProfitInput(e.target.value)}
              placeholder="未入力"
              className="w-24 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm tabular-nums disabled:opacity-60"
            />
            <span className="self-center text-sm text-gray-500">%</span>
            {!applied && (
              <button onClick={() => save({ profitRatePercent: profitInput === '' ? null : Number(profitInput) })}
                disabled={busy}
                className="text-xs px-3 py-2 rounded-lg bg-hibi-navy text-white hover:opacity-90 disabled:opacity-50">保存</button>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            {data.profitRatePercent === null ? '未入力のうちは利益調整が 0 のまま計算されます。' : '第7節の表を当てはめて利益調整に反映しています。'}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500">昇給額 合計</div>
          <div className="text-2xl font-bold tabular-nums">{yen(totals.raise)}<span className="text-xs font-normal text-gray-400"> / 日</span></div>
          <div className="text-xs text-gray-500 mt-0.5">年間 {yen(totals.annual)}（290日換算）</div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 mb-1.5">内訳</div>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className={`px-2 py-0.5 rounded-full font-bold ${STATUS_CHIP.ok.cls}`}>改定 {totals.ok}</span>
            {totals.blocked > 0 && <span className={`px-2 py-0.5 rounded-full font-bold ${STATUS_CHIP.blocked.cls}`}>要入力 {totals.blocked}</span>}
            {totals.ineligible > 0 && <span className={`px-2 py-0.5 rounded-full font-bold ${STATUS_CHIP.ineligible.cls}`}>対象外 {totals.ineligible}</span>}
          </div>
        </div>
      </section>

      {/* ── ペア評価のバランス ── */}
      <section className={`rounded-xl border p-3 ${data.revision.balance.ok
        ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
        : 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold text-gray-500">評語の分布</span>
          {HYOGO_ORDER.map(h => (
            <span key={h} className="text-xs tabular-nums">
              {h} <b>{data.revision.balance.counts[h]}</b>
            </span>
          ))}
          {data.revision.balance.ok
            ? <span className="text-xs text-green-700 dark:text-green-400">ペアのルールを満たしています</span>
            : <span className="text-xs text-amber-800 dark:text-amber-300 font-bold">{data.revision.balance.messages.join(' / ')}</span>}
        </div>
        <p className="text-[11px] text-gray-400 mt-1">
          S を1人出したら B を1人、SS を1人出したら C を1人（第5節）。全体が A に寄りすぎず、昇給総額も自然に収まります。
        </p>
      </section>

      {/* ── 名簿 ── */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
        <table className="w-full text-sm min-w-[1020px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className={`${th} text-left`}>氏名</th>
              <th className={`${th} text-left`}>等級・号</th>
              <th className={`${th} text-right`}>年齢</th>
              <th className={`${th} text-right`}>在籍</th>
              <th className={`${th} text-right`}>現在の日額</th>
              <th className={`${th} text-left`}>評語</th>
              <th className={`${th} text-left`}>理由</th>
              <th className={`${th} text-center`}>特別調整</th>
              <th className={`${th} text-center`}>ピッチ内訳</th>
              <th className={`${th} text-right`}>改定後</th>
              <th className={`${th} text-right`}>昇給</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {data.revision.rows.map(r => {
              const m = r.member
              const e = entries[String(m.id)] || { hyogo: 'A' as Hyogo }
              const needsReason = ['SS', 'S', 'B', 'C'].includes(e.hyogo)
              const editable = !applied && r.status !== 'fixed'
              return (
                <tr key={m.id} className={r.status === 'blocked' ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}>
                  <td className={td}>
                    <div className="font-medium">{m.name}</div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${STATUS_CHIP[r.status].cls}`}>{STATUS_CHIP[r.status].label}</span>
                    {m.adjustment ? <div className="text-[10px] text-gray-400 mt-0.5">調整給 {yen(m.adjustment)}</div> : null}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    {m.currentStep === null
                      ? <span className="text-amber-700 dark:text-amber-400 text-xs">未設定</span>
                      : <span className="tabular-nums">{m.grade} <b>{m.currentStep}</b>号</span>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {m.birthDate ? ageAt(m.birthDate, data.effective) + '歳'
                      : <span className="text-amber-700 dark:text-amber-400 text-xs">未登録</span>}
                  </td>
                  <td className={`${td} text-right tabular-nums text-gray-500`}>
                    {r.tenureMonths === null ? '—' : r.tenureMonths >= 24 ? `${Math.floor(r.tenureMonths / 12)}年` : `${r.tenureMonths}ヶ月`}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{yen(r.oldTotal)}</td>

                  <td className={td}>
                    {r.status === 'fixed' ? <span className="text-xs text-gray-400">—</span> : (
                      <select
                        value={e.hyogo} disabled={!editable}
                        onChange={ev => setEntry(m.id, { hyogo: ev.target.value as Hyogo })}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-sm disabled:opacity-60"
                      >
                        {HYOGO_ORDER.map(h => (
                          <option key={h} value={h}>{h}（{signedPitch(data.meta.hyogoPitch[h])}）</option>
                        ))}
                      </select>
                    )}
                  </td>

                  <td className={`${td} w-56`}>
                    {r.status === 'fixed' ? <span className="text-xs text-gray-400">処遇固定</span> : (
                      <>
                        <input
                          type="text" defaultValue={e.reason || ''} disabled={!editable}
                          placeholder={needsReason ? '必須' : '任意'}
                          onBlur={ev => { if (ev.target.value !== (e.reason || '')) setEntry(m.id, { reason: ev.target.value }) }}
                          className={`w-full border rounded-lg px-2 py-1.5 text-xs dark:bg-gray-700 disabled:opacity-60 ${
                            needsReason && !e.reason?.trim()
                              ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                              : 'border-gray-300 dark:border-gray-600'}`}
                        />
                        <textarea
                          defaultValue={e.comment || ''} disabled={!editable} rows={2}
                          placeholder="給料表に載せる本人へのコメント"
                          onBlur={ev => { if (ev.target.value !== (e.comment || '')) setEntry(m.id, { comment: ev.target.value }) }}
                          className="w-full mt-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-[11px] leading-relaxed disabled:opacity-60"
                        />
                        {r.status === 'ineligible' && !applied && (
                          <button onClick={() => setEntry(m.id, { forceInclude: true })} disabled={busy}
                            className="mt-1 text-[10px] px-2 py-0.5 rounded border border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300">
                            今回の対象に含める
                          </button>
                        )}
                        {m.forceInclude && !applied && (
                          <button onClick={() => setEntry(m.id, { forceInclude: false })} disabled={busy}
                            className="mt-1 text-[10px] px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300">
                            対象から外す
                          </button>
                        )}
                      </>
                    )}
                  </td>

                  <td className={`${td} text-center whitespace-nowrap`}>
                    {r.status === 'fixed' ? <span className="text-xs text-gray-400">—</span> : (
                      <button
                        onClick={() => setOpenSpecial(openSpecial === m.id ? null : m.id)}
                        disabled={!editable}
                        className={`text-xs px-2 py-1 rounded-lg border transition disabled:opacity-60 ${
                          (e.specialKeys?.length ?? 0) > 0
                            ? 'border-hibi-navy text-hibi-navy font-bold dark:border-blue-400 dark:text-blue-300'
                            : 'border-gray-300 text-gray-400 dark:border-gray-600'}`}
                      >
                        {(e.specialKeys?.length ?? 0) > 0
                          ? `${signedPitch(specialSum(e.specialKeys!, data.meta.specialReasons))}（${e.specialKeys!.length}件）`
                          : 'なし'}
                      </button>
                    )}
                  </td>

                  <td className={`${td} text-center whitespace-nowrap`}>
                    {r.result ? (
                      <span className="text-xs tabular-nums text-gray-600 dark:text-gray-300">
                        評{signedPitch(r.result.hyogoPitch)} 齢{signedPitch(r.result.agePitch)} 益{signedPitch(r.result.profitPitch)} 特{signedPitch(r.result.specialPitch)}
                        <b className="ml-1.5 text-hibi-navy dark:text-blue-300">= {r.result.totalPitch}</b>
                      </span>
                    ) : <span className="text-[11px] text-gray-400">{r.blockers.join(' / ') || '—'}</span>}
                  </td>

                  <td className={`${td} text-right tabular-nums`}>
                    {r.result
                      ? <><b>{yen(r.newTotal)}</b><div className="text-[10px] text-gray-400">{r.result.newStep}号</div></>
                      : <span className="text-gray-400">{yen(r.newTotal)}</span>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {r.result && r.result.raisePerDay > 0
                      ? <><b className="text-green-700 dark:text-green-400">+{yen(r.result.raisePerDay)}</b>
                          <div className="text-[10px] text-gray-400">{(r.result.upRate * 100).toFixed(2)}%</div></>
                      : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              )
            })}
            {/* 特別調整の事由選択。開いている人の直下に差し込む */}
            {data.revision.rows.map(r => {
              const m = r.member
              if (openSpecial !== m.id) return null
              const e = entries[String(m.id)] || { hyogo: 'A' as Hyogo }
              const keys = e.specialKeys ?? []
              const sum = specialSum(keys, data.meta.specialReasons)
              return (
                <tr key={`sp-${m.id}`} className="bg-gray-50 dark:bg-gray-700/30">
                  <td colSpan={11} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline gap-2 mb-2">
                      <b className="text-sm">{m.name} の特別調整</b>
                      <span className="text-xs text-gray-500">
                        合計 <b className={sum < 0 ? 'text-red-600' : 'text-green-700 dark:text-green-400'}>{signedPitch(sum)}</b>
                        <span className="text-gray-400 ml-1">（±3が上限。超えた分は切り詰められます）</span>
                      </span>
                      <button onClick={() => setOpenSpecial(null)} className="ml-auto text-xs text-gray-500 underline">閉じる</button>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {data.meta.specialReasons.map(sr => {
                        const on = keys.includes(sr.key)
                        return (
                          <label key={sr.key} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${
                            on ? 'border-hibi-navy bg-white dark:bg-gray-800 dark:border-blue-400' : 'border-gray-200 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800'}`}>
                            <input
                              type="checkbox" checked={on} disabled={busy || applied}
                              onChange={ev => {
                                const next = ev.target.checked ? [...keys, sr.key] : keys.filter(k => k !== sr.key)
                                setEntry(m.id, { specialKeys: next })
                              }}
                              className="mt-0.5"
                            />
                            <span className="text-xs leading-relaxed">
                              {sr.label}
                              <b className={`ml-1.5 ${sr.pitch < 0 ? 'text-red-600' : 'text-green-700 dark:text-green-400'}`}>{signedPitch(sr.pitch)}</b>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── 確定後: 本人へ渡す通知書 ── */}
      {applied && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            <b>本人へ渡す給料表</b>
            <div className="text-[11px] text-gray-400 mt-0.5">
              とび事業部給料表の様式でA4横1枚ずつ出力します。金額は確定時に凍結した値を使うので、
              あとから号俸表を変えても給料表の数字は動きません。
            </div>
          </div>
          <a href={`/wage/notice?effective=${data.effective}`} target="_blank" rel="noopener noreferrer"
            className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90">
            🖨 給料表を開く
          </a>
        </section>
      )}

      {/* ── 確定 ── */}
      {!applied && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            確定すると人員マスタの号と日額が書き換わり、<b>以後この改定は編集できません</b>。
            <div className="text-[11px] text-gray-400 mt-0.5">
              要入力が残っている・評語のバランスが取れていない場合は確定できません。
            </div>
          </div>
          <button onClick={apply} disabled={busy || totals.blocked > 0 || !data.revision.balance.ok || data.profitRatePercent === null}
            className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? '処理中…' : '改定を確定する'}
          </button>
        </section>
      )}

      <p className="text-[11px] text-gray-400">
        号俸表・評語・年齢調整・利益調整・特別調整の定義は <code>docs/wage-system.md</code>。
        在籍{data.meta.firstRevisionMinMonths}ヶ月未満の方は初回改定の対象外です（個別に含めることもできます）。
      </p>
    </div>
  )
}

/** 基準日時点の満年齢。サーバと同じ計算（文字列のまま比較する） */
function ageAt(birthDate: string, onDateIso: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const [oy, om, od] = onDateIso.split('-').map(Number)
  let age = oy - by
  if (om < bm || (om === bm && od < bd)) age -= 1
  return age
}

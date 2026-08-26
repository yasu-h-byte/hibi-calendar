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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
    discretionaryPitch?: number; discretionaryReason?: string
  }
  status: RosterStatus
  result: null | {
    hyogoPitch: number; agePitch: number; specialPitch: number; discretionaryPitch: number
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
  entries: Record<string, {
    hyogo: Hyogo; reason?: string; specialKeys?: string[]; forceInclude?: boolean; comment?: string
    discretionaryPitch?: number; discretionaryReason?: string
  }>
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
  // 特別調整の事由は行を展開して選ぶ。表の中にポップオーバーを出すと位置合わせが崩れるため
  const [openSpecial, setOpenSpecial] = useState<number | null>(null)

  const load = useCallback(async (password: string) => {
    try {
      const res = await fetch('/api/jp-wage/revision', { headers: { 'x-admin-password': password } })
      if (!res.ok) throw new Error(`取得に失敗しました（${res.status}）`)
      const j: Payload = await res.json()
      setData(j)
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
  const save = async (patch: { entries?: Payload['entries'] }) => {
    if (!data) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/revision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({ effective: data.effective, entries: patch.entries ?? entries }),
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
      <section className="grid gap-4 md:grid-cols-2">
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

      {/* ── 名簿 ──
          理由とコメントの入力欄を常時出すと表が縦に伸びて一覧できないため、
          行ごとの「編集」で開く形にしている。表は読むもの、パネルは書くもの。 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
        <table className="w-full text-sm min-w-[880px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className={`${th} text-left`}>氏名</th>
              <th className={`${th} text-left`}>等級・号</th>
              <th className={`${th} text-right`}>年齢 / 在籍</th>
              <th className={`${th} text-right`}>現在</th>
              <th className={`${th} text-left`}>評語</th>
              <th className={`${th} text-left`}>内訳</th>
              <th className={`${th} text-right`}>改定後</th>
              <th className={`${th} text-right`}>昇給</th>
              <th className={`${th} text-center`}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {data.revision.rows.map(r => {
              const m = r.member
              const e = entries[String(m.id)] || { hyogo: 'A' as Hyogo }
              const editable = !applied && r.status !== 'fixed'
              const open = openSpecial === m.id
              const sp = specialSum(e.specialKeys ?? [], data.meta.specialReasons)
              const dp = e.discretionaryPitch ?? 0
              const needsReason = ['SS', 'S', 'B', 'C'].includes(e.hyogo)
              const missing = (needsReason && !e.reason?.trim()) || (dp !== 0 && !e.discretionaryReason?.trim())

              return (
                <Fragment key={m.id}>
                  <tr className={`${open ? 'bg-gray-50 dark:bg-gray-700/30' : ''} ${r.status === 'blocked' ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''}`}>
                    <td className={`${td} whitespace-nowrap`}>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{m.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${STATUS_CHIP[r.status].cls}`}>{STATUS_CHIP[r.status].label}</span>
                      </div>
                      {m.adjustment ? (
                        <div className="text-[10px] text-gray-400 mt-0.5">調整給 {yen(m.adjustment)}</div>
                      ) : null}
                    </td>

                    <td className={`${td} whitespace-nowrap`}>
                      {m.currentStep === null
                        ? <span className="text-amber-700 dark:text-amber-400 text-xs">未設定</span>
                        : <span className="tabular-nums">{m.grade === 'doko' ? '土工' : m.grade} <b>{m.currentStep}</b>号</span>}
                    </td>

                    <td className={`${td} text-right whitespace-nowrap tabular-nums text-gray-500`}>
                      {m.birthDate ? `${ageAt(m.birthDate, data.effective)}歳` : <span className="text-amber-700 dark:text-amber-400 text-xs">生年月日なし</span>}
                      <span className="text-gray-300 dark:text-gray-600 mx-1">/</span>
                      {r.tenureMonths === null
                        ? <span className="text-gray-400">—</span>
                        : r.tenureMonths >= 24 ? `${Math.floor(r.tenureMonths / 12)}年` : `${r.tenureMonths}ヶ月`}
                    </td>

                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{yen(r.oldTotal)}</td>

                    <td className={td}>
                      {r.status === 'fixed' ? <span className="text-xs text-gray-400">—</span> : (
                        <select
                          value={e.hyogo} disabled={!editable}
                          onChange={ev => setEntry(m.id, { hyogo: ev.target.value as Hyogo })}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-2 py-1 text-sm disabled:opacity-60"
                        >
                          {HYOGO_ORDER.map(h => (
                            <option key={h} value={h}>{h}（{signedPitch(data.meta.hyogoPitch[h])}）</option>
                          ))}
                        </select>
                      )}
                    </td>

                    <td className={`${td} whitespace-nowrap`}>
                      {r.result ? (
                        <span className="text-xs tabular-nums text-gray-500">
                          {signedPitch(r.result.hyogoPitch)}
                          <span className="text-gray-300 dark:text-gray-600 mx-0.5">·</span>{signedPitch(r.result.agePitch)}
                          {r.result.specialPitch !== 0 && <><span className="text-gray-300 dark:text-gray-600 mx-0.5">·</span><span className="text-gray-700 dark:text-gray-200">{signedPitch(r.result.specialPitch)}</span></>}
                          {r.result.discretionaryPitch !== 0 && <><span className="text-gray-300 dark:text-gray-600 mx-0.5">·</span><b className="text-hibi-navy dark:text-blue-300">{signedPitch(r.result.discretionaryPitch)}</b></>}
                          <b className="ml-1.5 text-gray-900 dark:text-white">= {r.result.totalPitch}</b>
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-700 dark:text-amber-400">{r.blockers[0] || '—'}</span>
                      )}
                    </td>

                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>
                      {r.result
                        ? <><b>{yen(r.newTotal)}</b><div className="text-[10px] text-gray-400">{r.result.newStep}号</div></>
                        : <span className="text-gray-400">{yen(r.newTotal)}</span>}
                    </td>

                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>
                      {r.result && r.result.raisePerDay > 0 ? (
                        <>
                          <b className="text-green-700 dark:text-green-400">+{yen(r.result.raisePerDay)}</b>
                          <div className="text-[10px] text-gray-400">{(r.result.upRate * 100).toFixed(2)}%</div>
                        </>
                      ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    <td className={`${td} text-center whitespace-nowrap`}>
                      {r.status === 'fixed' ? <span className="text-xs text-gray-300 dark:text-gray-600">—</span> : (
                        <button
                          onClick={() => setOpenSpecial(open ? null : m.id)}
                          className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${
                            missing
                              ? 'border-amber-400 bg-amber-50 text-amber-800 font-bold dark:bg-amber-900/30 dark:text-amber-300'
                              : (sp !== 0 || dp !== 0 || e.reason || e.comment)
                                ? 'border-hibi-navy text-hibi-navy dark:border-blue-400 dark:text-blue-300'
                                : 'border-gray-300 text-gray-400 dark:border-gray-600'
                          }`}
                        >
                          {missing ? '要入力' : open ? '閉じる' : '編集'}
                        </button>
                      )}
                    </td>
                  </tr>

                  {open && (
                    <tr className="bg-gray-50 dark:bg-gray-700/30">
                      <td colSpan={9} className="px-4 py-4">
                        <div className="grid gap-4 lg:grid-cols-2">
                          {/* 左: 理由とコメント */}
                          <div className="space-y-3">
                            <div>
                              <label className="text-xs font-bold block mb-1">
                                評価の理由
                                {needsReason && <span className="text-amber-700 dark:text-amber-400 ml-1.5 font-normal">（{e.hyogo}評価には必須）</span>}
                              </label>
                              <input
                                type="text" defaultValue={e.reason || ''} disabled={!editable}
                                placeholder={needsReason ? '必須' : 'A評価は記入不要'}
                                onBlur={ev => { if (ev.target.value !== (e.reason || '')) setEntry(m.id, { reason: ev.target.value }) }}
                                className={`w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 disabled:opacity-60 ${
                                  needsReason && !e.reason?.trim()
                                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                                    : 'border-gray-300 dark:border-gray-600'}`}
                              />
                            </div>
                            <div>
                              <label className="text-xs font-bold block mb-1">給料表に載せるコメント</label>
                              <textarea
                                defaultValue={e.comment || ''} disabled={!editable} rows={3}
                                placeholder="本人へのメッセージ。給料表の右下に入ります"
                                onBlur={ev => { if (ev.target.value !== (e.comment || '')) setEntry(m.id, { comment: ev.target.value }) }}
                                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded-lg px-3 py-2 text-xs leading-relaxed disabled:opacity-60"
                              />
                            </div>
                            {r.status === 'ineligible' && !applied && (
                              <button onClick={() => setEntry(m.id, { forceInclude: true })} disabled={busy}
                                className="text-xs px-3 py-1.5 rounded-lg border border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300">
                                今回の対象に含める
                              </button>
                            )}
                            {m.forceInclude && !applied && (
                              <button onClick={() => setEntry(m.id, { forceInclude: false })} disabled={busy}
                                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300">
                                対象から外す
                              </button>
                            )}
                          </div>

                          {/* 右: 特別調整と代表加算 */}
                          <div className="space-y-3">
                            <div>
                              <div className="flex items-baseline gap-2 mb-1.5">
                                <span className="text-xs font-bold">特別調整</span>
                                <span className="text-[11px] text-gray-500">
                                  合計 <b className={sp < 0 ? 'text-red-600' : 'text-green-700 dark:text-green-400'}>{signedPitch(sp)}</b>（±3が上限）
                                </span>
                              </div>
                              <div className="grid gap-1 sm:grid-cols-2">
                                {data.meta.specialReasons.map(sr => {
                                  const keys = e.specialKeys ?? []
                                  const on = keys.includes(sr.key)
                                  return (
                                    <label key={sr.key} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 cursor-pointer transition ${
                                      on ? 'border-hibi-navy bg-white dark:bg-gray-800 dark:border-blue-400' : 'border-gray-200 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800'}`}>
                                      <input
                                        type="checkbox" checked={on} disabled={busy || applied}
                                        onChange={ev => setEntry(m.id, { specialKeys: ev.target.checked ? [...keys, sr.key] : keys.filter(k => k !== sr.key) })}
                                        className="mt-0.5"
                                      />
                                      <span className="text-[11px] leading-snug">
                                        {sr.label}
                                        <b className={`ml-1 ${sr.pitch < 0 ? 'text-red-600' : 'text-green-700 dark:text-green-400'}`}>{signedPitch(sr.pitch)}</b>
                                      </span>
                                    </label>
                                  )
                                })}
                              </div>
                            </div>

                            <div className="pt-3 border-t border-gray-200 dark:border-gray-600">
                              <div className="flex items-baseline gap-2 mb-1.5">
                                <span className="text-xs font-bold">代表加算</span>
                                <span className="text-[11px] text-gray-500">事由に当てはまらない分を直接動かす（上限なし）</span>
                              </div>
                              <div className="flex flex-wrap items-start gap-2">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number" step={1} disabled={busy || applied}
                                    value={e.discretionaryPitch ?? 0}
                                    onChange={ev => setEntry(m.id, { discretionaryPitch: Number(ev.target.value) || 0 })}
                                    className="w-20 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded-lg px-2 py-2 text-sm tabular-nums"
                                  />
                                  <span className="text-xs text-gray-500">号</span>
                                </div>
                                <input
                                  type="text" disabled={busy || applied}
                                  defaultValue={e.discretionaryReason || ''}
                                  placeholder={dp !== 0 ? '理由（必須）' : '理由'}
                                  onBlur={ev => { if (ev.target.value !== (e.discretionaryReason || '')) setEntry(m.id, { discretionaryReason: ev.target.value }) }}
                                  className={`flex-1 min-w-[200px] border rounded-lg px-3 py-2 text-xs dark:bg-gray-800 ${
                                    dp !== 0 && !e.discretionaryReason?.trim()
                                      ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                                      : 'border-gray-300 dark:border-gray-600'}`}
                                />
                              </div>
                              {dp !== 0 && (
                                <p className="text-[11px] text-gray-500 mt-1.5">
                                  号を {signedPitch(dp)} 動かします。<b>理由は給料表と監査証跡に残ります。</b>
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
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
          <button onClick={apply} disabled={busy || totals.blocked > 0 || !data.revision.balance.ok}
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

'use client'

/**
 * 日本人社員の賃金改定（docs/wage-system.md 第4節・基準日 毎年10月1日）
 *
 * 評価を入力し、号俸表・年齢調整・特別調整から改定額を出して人員マスタへ反映する。
 * 下書きは Firestore に保存されるので、決算の数字が出るまで置いておける。
 *
 * ⚠️ 個人の賃金を一覧するため、代表（0）と事業責任者（1）以外には表示しない。
 *    評価を決めるのはこの2名と定められている（第4節）。
 */

import { staffLinkOrigin } from '@/lib/public-origin'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Hyogo, RosterStatus, SpecialReason } from '@/lib/jp-wage'
import LaborCostPanel from './LaborCostPanel'

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
  /** 改定前に実際に払っている日額（workerId → 円） */
  paidBefore?: Record<string, number>
  /** その改定期の有給の付与日数（workerId → 日。無い人は既定の20日） */
  paidLeaveDays?: Record<string, number>
  /** 本人のマイページの合言葉（workerId → {name, token}） */
  mypageTokens?: Record<string, { name: string; token: string }>
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

  /**
   * 下書きを保存して読み直す。計算はサーバ側の1本に寄せる。
   * 2026-10-02 総合点検: 送るのは「1人分の差分」（entryPatch）だけにし、サーバで今の entries にマージする。
   *   旧: 描画時点の entries 全体を送って丸ごと置き換えていたので、保存→再読込の間（1〜2秒）に
   *   続けて別の人の評語を変えると、前の人の変更が古い entries で上書きされて黙って元に戻っていた。
   *   保存は1本ずつ順に送る（saveChain）。前の保存が終わる前の操作も、順番どおりに積まれる
   */
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const save = (body: { entryPatch?: Record<string, Partial<Payload['entries'][string]>>; profitRatePercent?: number | null }) => {
    if (!data) return
    const effective = data.effective
    const run = async () => {
      setBusy(true); setMsg('')
      try {
        const res = await fetch('/api/jp-wage/revision', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
          body: JSON.stringify({ effective, ...body }),
        })
        if (!res.ok) throw new Error((await res.json()).error || `保存に失敗しました（${res.status}）`)
        await load(pw)
        setMsg('保存しました')
      } catch (e) {
        setErr(e instanceof Error ? e.message : '保存に失敗しました')
      } finally { setBusy(false) }
    }
    saveChain.current = saveChain.current.then(run, run)
  }

  const setEntry = (id: number, patch: Partial<Payload['entries'][string]>) => {
    save({ entryPatch: { [String(id)]: patch } })
  }

  const apply = async () => {
    if (!data) return
    // 2026-09-30: 評価を保存するつもりで押され、全員Aのまま確定された事故の再発防止。
    //   入力は自動保存なので、このボタンは「最後に1回」だけ。文字を打たないと進めない
    const typed = prompt(
      `${data.effective} の改定を確定し、人員マスタの号と日額を書き換えます。\n`
      + `評語・コメントの入力は自動で保存されています。保存のためにこのボタンを押す必要はありません。\n\n`
      + `昇給額 合計 ${yen(data.revision.raisePerDay)}/日（年 ${yen(data.revision.annualCost)}）\n\n`
      + `確定する場合は「確定」と入力してください。`)
    if (typed === null) return
    if (typed.trim() !== '確定') { setErr('「確定」と入力されなかったので、確定しませんでした'); return }
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

  /** 確定の取り消し（2026-09-30）。人員マスタを改定前に戻し、下書きに戻す。評語・コメントは残る */
  const unapply = async () => {
    if (!data) return
    const typed = prompt(
      `${data.effective} の改定の確定を取り消します。\n\n`
      + `・人員マスタの号と日額を、改定前（9月まで払っていた額）に戻します\n`
      + `・評語・理由・コメントは残り、下書きとして入力し直せます\n`
      + `・入れ直したら、もう一度「改定を確定する」を押してください\n\n`
      + `取り消す場合は「取り消し」と入力してください。`)
    if (typed === null) return
    if (typed.trim() !== '取り消し') { setErr('「取り消し」と入力されなかったので、取り消しませんでした'); return }
    setBusy(true); setMsg(''); setErr('')
    try {
      const res = await fetch(`/api/jp-wage/revision?effective=${data.effective}`, {
        method: 'DELETE', headers: { 'x-admin-password': pw },
      })
      const j = await res.json()
      if (!res.ok) throw new Error([j.error, ...(j.conflicts || [])].join('\n'))
      await load(pw)
      setMsg(`確定を取り消しました（${j.count}名を改定前に戻しました）。評語・コメントを入れ直して、もう一度確定してください`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '取り消しに失敗しました')
    } finally { setBusy(false) }
  }

  const totals = useMemo(() => {
    if (!data) return null
    const r = data.revision
    // 平均昇給率（2026-08-28 追加）:
    //   総額ベース = 昇給合計 ÷ 名簿全員の現在日額合計（処遇固定も母数に含む＝人件費の伸び）
    //   単純平均   = 昇給者ごとの率の平均（個人の体感に近い）
    const oldSum = r.rows.reduce((s2, row) => s2 + (row.oldTotal ?? 0), 0)
    const rates = r.rows.filter(row => row.result).map(row => row.result!.upRate)
    return {
      raise: r.raisePerDay, annual: r.annualCost,
      ok: r.applied, blocked: r.blocked, ineligible: r.ineligible,
      avgRateTotal: oldSum > 0 ? r.raisePerDay / oldSum : 0,
      avgRateSimple: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0,
    }
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
            ? <span className="text-2xs px-2 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">確定済み</span>
            : <span className="text-2xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">下書き</span>}
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
          <div className="flex flex-wrap items-baseline gap-x-3">
            <div className="text-2xl font-bold tabular-nums">{yen(totals.raise)}<span className="text-xs font-normal text-gray-400"> / 日</span></div>
            <div className="text-lg font-bold tabular-nums text-green-700 dark:text-green-400">
              {(totals.avgRateTotal * 100).toFixed(2)}%
              <span className="text-xs font-normal text-gray-400"> 平均昇給率</span>
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            年間 {yen(totals.annual)}（290日換算）／
            昇給者{totals.ok}名の単純平均 {(totals.avgRateSimple * 100).toFixed(2)}%
          </div>
          <div className="text-2xs text-gray-400 mt-0.5">
            平均昇給率 = 昇給合計 ÷ 名簿全員の現在日額合計（処遇固定・対象外も母数に含む）
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 mb-1.5">内訳</div>
          <div className="flex flex-wrap gap-1.5 text-2xs">
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
        <p className="text-2xs text-gray-400 mt-1">
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
                        <span className={`text-3xs px-1.5 py-0.5 rounded-full font-bold ${STATUS_CHIP[r.status].cls}`}>{STATUS_CHIP[r.status].label}</span>
                      </div>
                      {m.adjustment ? (
                        <div className="text-3xs text-gray-400 mt-0.5">調整給 {yen(m.adjustment)}</div>
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
                        <span className="text-2xs text-amber-700 dark:text-amber-400">{r.blockers[0] || '—'}</span>
                      )}
                    </td>

                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>
                      {r.result
                        ? <><b>{yen(r.newTotal)}</b><div className="text-3xs text-gray-400">{r.result.newStep}号</div></>
                        : <span className="text-gray-400">{yen(r.newTotal)}</span>}
                    </td>

                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>
                      {r.result && r.result.raisePerDay > 0 ? (
                        <>
                          <b className="text-green-700 dark:text-green-400">+{yen(r.result.raisePerDay)}</b>
                          <div className="text-3xs text-gray-400">{(r.result.upRate * 100).toFixed(2)}%</div>
                        </>
                      ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    <td className={`${td} text-center whitespace-nowrap`}>
                      {r.status === 'fixed' ? <span className="text-xs text-gray-300 dark:text-gray-600">—</span> : (
                        <button
                          onClick={() => setOpenSpecial(open ? null : m.id)}
                          className={`text-2xs px-2.5 py-1 rounded-lg border transition ${
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
                                <span className="text-2xs text-gray-500">
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
                                      <span className="text-2xs leading-snug">
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
                                <span className="text-2xs text-gray-500">事由に当てはまらない分を直接動かす（上限なし）</span>
                              </div>
                              <div className="flex flex-wrap items-start gap-2">
                                {/* 2026-08-28: number input の onChange 即保存は、1文字ごとに
                                    保存→再取得→disabled が走って入力が消える・カーソルが飛ぶ
                                    不安定さがあった。1クリック=1保存の ± ボタンに置き換える */}
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button" disabled={busy || applied}
                                    onClick={() => setEntry(m.id, { discretionaryPitch: dp - 1 })}
                                    className="w-9 h-9 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 text-base font-bold hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40"
                                  >−</button>
                                  <span className={`w-12 text-center text-sm font-bold tabular-nums ${
                                    dp > 0 ? 'text-green-700 dark:text-green-400' : dp < 0 ? 'text-red-600' : ''}`}>
                                    {dp === 0 ? '0' : signedPitch(dp)}
                                  </span>
                                  <button
                                    type="button" disabled={busy || applied}
                                    onClick={() => setEntry(m.id, { discretionaryPitch: dp + 1 })}
                                    className="w-9 h-9 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 text-base font-bold hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40"
                                  >＋</button>
                                  <span className="text-xs text-gray-500">号</span>
                                </div>
                                <input
                                  type="text" disabled={busy || applied}
                                  defaultValue={e.discretionaryReason || ''}
                                  placeholder={dp !== 0 ? '本人へのメッセージ（必須・給料表に載ります）' : '本人へのメッセージ'}
                                  onBlur={ev => { if (ev.target.value !== (e.discretionaryReason || '')) setEntry(m.id, { discretionaryReason: ev.target.value }) }}
                                  className={`flex-1 min-w-[200px] border rounded-lg px-3 py-2 text-xs dark:bg-gray-800 ${
                                    dp !== 0 && !e.discretionaryReason?.trim()
                                      ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                                      : 'border-gray-300 dark:border-gray-600'}`}
                                />
                              </div>
                              {dp !== 0 && (
                                <p className="text-2xs text-gray-500 mt-1.5">
                                  号を {signedPitch(dp)} 動かします。<b>この文章は本人へのメッセージとして、給料表の号数の表の下にそのまま載ります</b>（監査証跡にも残ります）。
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

      {/* ── 新旧比較と人件費の増加（2026-09-30）── */}
      <LaborCostPanel
        effective={data.effective}
        rows={data.revision.rows.filter(r => r.status === 'ok' && r.result).map(r => ({
          id: r.member.id, name: r.member.name, hyogo: r.member.hyogo, birthDate: r.member.birthDate,
          oldStep: r.member.currentStep, newStep: r.result!.newStep,
          paidBefore: data.paidBefore?.[String(r.member.id)] ?? r.oldTotal,
          newDaily: r.newTotal,
          paidLeaveDays: data.paidLeaveDays?.[String(r.member.id)],
        }))}
      />

      {/* ── 確定後: 本人へ渡す通知書 ── */}
      {applied && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            <b>本人へ渡す給料表</b>
            <div className="text-2xs text-gray-400 mt-0.5">
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

      {/* ── 本人へ送る（2026-09-30）── 一人ずつ、給料表（PDF）とマイページのURLを送る */}
      {applied && data.mypageTokens && (
        <SendList
          effective={data.effective}
          rows={Object.entries(data.mypageTokens).map(([id, v]) => {
            const r = data.revision.rows.find(x => String(x.member.id) === id)
            // 処遇固定の人には給料表を出さない（マイページのURLだけ送る・2026-10-01 代表決定）
            return { id, name: v.name, token: v.token, hasSheet: !!r && r.newTotal != null && r.status === 'ok', fixed: r?.status === 'fixed' }
          })}
        />
      )}

      {/* ── 確定の取り消し（2026-09-30）── */}
      {applied && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-red-200 dark:border-red-900/50 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            <b>評価を入れ直す</b>
            <div className="text-2xs text-gray-400 mt-0.5">
              確定を取り消すと、人員マスタの号と日額が改定前に戻り、下書きとして評語・コメントを入れ直せます。
              改定月以降の給与を締めた後は取り消せません。
            </div>
          </div>
          <button onClick={unapply} disabled={busy}
            className="px-5 py-2.5 rounded-lg border-2 border-red-300 text-red-700 dark:text-red-300 font-bold text-sm hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40">
            {busy ? '処理中…' : '確定を取り消す'}
          </button>
        </section>
      )}

      {/* ── 確定 ── */}
      {!applied && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            評語・コメントの入力は<b>自動で保存</b>されています。このボタンは、全員の評価が決まったあと最後に1回だけ押します。<br />
            確定すると人員マスタの号と日額が書き換わり、編集できなくなります（取り消しはできます）。
            <div className="text-2xs text-gray-400 mt-0.5">
              要入力が残っている・評語のバランスが取れていない場合は確定できません。
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
          <a href={`/wage/notice?effective=${data.effective}`} target="_blank" rel="noopener noreferrer"
            className="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 font-bold text-sm hover:bg-gray-50 dark:hover:bg-gray-700">
            🖨 給料表の見本（未確定）
          </a>
          <button onClick={apply} disabled={busy || totals.blocked > 0 || !data.revision.balance.ok}
            className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? '処理中…' : '改定を確定する'}
          </button>
          </div>
        </section>
      )}

      <p className="text-2xs text-gray-400">
        号俸表・評語・年齢調整・特別調整の定義は <code>docs/wage-system.md</code>。
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

/** 本人へ送る一覧。給料表は一人分を開いて「印刷 → PDFに保存」、URLと文面はコピーしてLINE等で送る */
function SendList({ effective, rows }: {
  effective: string
  rows: { id: string; name: string; token: string; hasSheet: boolean; fixed?: boolean }[]
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const fy = Number(effective.slice(0, 4)) + 1
  const [y, m, d] = effective.split('-').map(Number)
  // 配るURLは本番のドメイン（お試しサイトで開いていても・2026-10-01）
  const url = (t: string) => `${staffLinkOrigin()}/mypage/${t}`
  const message = (r: { name: string; token: string; hasSheet: boolean; fixed?: boolean }) => [
    `${r.name.replace(/\s/g, '')}さん`,
    'お疲れさまです。',
    ...(r.hasSheet ? [
      `${fy}年度（${y}年${m}月${d}日改定）の給料表をお送りします。`,
      // 処遇固定の人は号俸制の外なので「給料のしくみ」は付けない（代表 2026-10-01）
      ...(r.fixed ? [] : ['あわせて、給料のしくみを説明した1枚も付けています。']),
      '',
    ] : []),
    '有給の残り日数や道具代の残りを確認できる「マイページ」を用意しました。',
    '下のURLをスマホで開いて、ブックマーク（ホーム画面に追加）しておいてください。',
    url(r.token),
    '※ このURLはご本人専用です。ほかの人には送らないでください。',
    '',
    'わからないことがあれば、いつでも聞いてください。',
  ].join('\n')
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500) }
    catch { alert('コピーできませんでした') }
  }
  const btn = 'px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-xs font-bold hover:bg-gray-50 dark:hover:bg-gray-700 whitespace-nowrap'
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div>
        <b className="text-sm">本人へ送る</b>
        <div className="text-2xs text-gray-400 mt-0.5 leading-relaxed">
          一人ずつ「給料表を開く」→ 印刷 →「PDFに保存」（ファイル名に名前が入ります）。送る文面にはマイページのURLが入っています。
          URLはご本人専用の合言葉なので、グループではなく1対1で送ってください。
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {rows.map(r => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="w-28 text-sm font-bold">{r.name}</span>
            {r.hasSheet ? (
              <a href={`/wage/notice?effective=${effective}&worker=${r.id}`} target="_blank" rel="noopener noreferrer"
                className={`${btn} bg-hibi-navy text-white border-hibi-navy hover:opacity-90 hover:bg-hibi-navy`}>🖨 給料表を開く</a>
            ) : (
              <span className="text-2xs text-gray-400 w-[104px]">{r.fixed ? '給料表は配らない（処遇固定）' : '給料表なし'}</span>
            )}
            <button type="button" className={btn} onClick={() => copy(`u${r.id}`, url(r.token))}>
              {copied === `u${r.id}` ? '✓ コピーしました' : '🔗 URLをコピー'}
            </button>
            <button type="button" className={btn} onClick={() => copy(`m${r.id}`, message(r))}>
              {copied === `m${r.id}` ? '✓ コピーしました' : '✉ 送る文面をコピー'}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

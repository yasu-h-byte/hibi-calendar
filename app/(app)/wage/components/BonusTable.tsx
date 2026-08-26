'use client'

/**
 * 賞与の点数表（docs/wage-system.md 第7節）。
 *
 * 表は `lib/jp-wage.ts` の bonusPoints から生成する。写して持つと配分と表がズレる。
 * 原資を入れると、いまの在籍者でいくらになるかを試算できる。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  bonusPoints, allocateBonus, GRADE_LABELS, GRADES_IN_ORDER,
  type JpGrade, type Hyogo, type BonusMember,
} from '@/lib/jp-wage'

interface BonusRecord {
  id: string; label: string; paidOn: string; pool: number
  totalPoints: number; unit: number; total: number
  allocations: Array<{ workerId: number; name: string; grade: string; hyogo: Hyogo; points: number; amount: number }>
}

const HY: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']
const RATIO = { SS: '5%', S: '15%', A: '60%', B: '15%', C: '5%' }
const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

export default function BonusTable() {
  const [pw, setPw] = useState('')
  const [pool, setPool] = useState('1200000')
  const [label, setLabel] = useState('')
  const [paidOn, setPaidOn] = useState(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }))
  const [members, setMembers] = useState<Array<BonusMember & { name: string }>>([])
  const [records, setRecords] = useState<BonusRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async (password: string) => {
    try {
      const [wr, br] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/jp-wage/bonus', { headers: { 'x-admin-password': password } }),
      ])
      // 評語は年次改定で決めたものを初期値にする（賞与と昇給で別の評価を付けない）
      const bj = br.ok ? await br.json() : { records: [], hyogo: {} }
      setRecords(bj.records || [])
      if (wr.ok) {
        const j = await wr.json()
        setMembers((j.workers as Record<string, unknown>[])
          .filter(w => !w.retired && w.jpGrade && Number(w.id) !== 1)
          .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
          .map(w => ({
            workerId: Number(w.id), name: String(w.name),
            grade: String(w.jpGrade) as JpGrade,
            hyogo: (bj.hyogo?.[String(w.id)] as Hyogo) || 'A',
          })))
      }
    } catch { /* 試算が出せなくても表は見られる */ }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const p = raw ? JSON.parse(raw)?.password : ''
      if (!p) return
      setPw(p); load(p)
    } catch { /* noop */ }
  }, [load])

  const poolNum = Number(pool) || 0
  const result = members.length ? allocateBonus(poolNum, members) : null

  const save = async () => {
    if (!result) return
    if (!confirm(`「${label}」として配分を確定します。\n\n原資 ${yen(poolNum)} ／ ${members.length}名\n支給合計 ${yen(result.allocations.reduce((s, a) => s + a.amount, 0))}\n\n記録として残ります。よろしいですか？`)) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({
          label, paidOn, pool: poolNum,
          hyogo: Object.fromEntries(members.map(m => [String(m.workerId), m.hyogo])),
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `失敗しました（${res.status}）`)
      setMsg(`「${label}」を保存しました`)
      setLabel('')
      await load(pw)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました')
    } finally { setBusy(false) }
  }

  const th = 'px-2.5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-5">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">賞与の決め方</div>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
          ① 代表が業績を見て<b>原資（総額）</b>を決める　→　② 各人に<b>等級 × 評語</b>で点数をつける　→　
          ③ <b>単価 = 原資 ÷ 合計点</b>　→　④ 点数 × 単価（千円切り上げ）<br />
          <b>業績連動はこの原資の決定に集約しています。</b>配分側にも昇給側にも係数は掛けません（掛けると二重連動になるため）。
        </p>
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">点数表</h3>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className={`${th} text-left`}>等級</th>
                <th className={`${th} text-left`}>役割</th>
                {HY.map(h => <th key={h} className={`${th} text-right`}>{h}</th>)}
              </tr>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className={`${th} text-left`} colSpan={2}>分布の目安</th>
                {HY.map(h => <th key={h} className={`${th} text-right font-normal`}>{RATIO[h]}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {GRADES_IN_ORDER.map(g => (
                <tr key={g}>
                  <td className="px-2.5 py-2 font-bold">{g === 'doko' ? '土工' : g}</td>
                  <td className="px-2.5 py-2 text-gray-600 dark:text-gray-300">{GRADE_LABELS[g]}</td>
                  {HY.map(h => (
                    <td key={h} className={`${td} ${h === 'A' ? 'font-bold' : ''}`}>{bonusPoints(g, h)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
          評語は「等級を上下にずらす」のと同じ（SS＝2段上 / S＝1段上 / B＝1段下 / C＝2段下）。
          分布の目安は左右対称で、第5節のペアのルール（S を1人なら B を1人、SS を1人なら C を1人）と同じ思想。
          土工は3G相当（旧配分表で班長と同額だった扱いを踏襲）。
        </p>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">{err}</div>}
      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      <div>
        <h3 className="text-sm font-bold mb-2">配分</h3>
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">支給名</label>
            <input
              type="text" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="例：2026年 冬季賞与"
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">原資（円）</label>
            <input
              type="number" step="100000" value={pool} onChange={e => setPool(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">支給日</label>
            <input
              type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        {result && (
          <p className="text-xs text-gray-500 mb-3">
            合計 {result.totalPoints}点 ／ 1点あたり <b>{result.unit.toFixed(2)}円</b>
          </p>
        )}

        {!result ? (
          <p className="text-xs text-gray-400">在籍者の等級が読み込めませんでした。</p>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-sm min-w-[460px]">
                <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className={`${th} text-left`}>氏名</th><th className={`${th} text-left`}>等級</th>
                    <th className={`${th} text-left`}>評語</th>
                    <th className={`${th} text-right`}>点数</th><th className={`${th} text-right`}>支給額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {result.allocations
                    .map((a, i) => ({ ...a, name: members[i].name, idx: i }))
                    .sort((x, y) => y.points - x.points)
                    .map(a => (
                      <tr key={a.workerId}>
                        <td className="px-2.5 py-2 whitespace-nowrap">{a.name}</td>
                        <td className="px-2.5 py-2 text-gray-500">{a.grade === 'doko' ? '土工' : a.grade}</td>
                        <td className="px-2.5 py-1.5">
                          <select
                            value={a.hyogo} disabled={busy}
                            onChange={ev => setMembers(ms => ms.map((m, i) => i === a.idx ? { ...m, hyogo: ev.target.value as Hyogo } : m))}
                            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-2 py-1 text-sm"
                          >
                            {HY.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </td>
                        <td className={td}>{a.points}</td>
                        <td className={`${td} font-bold`}>{yen(a.amount)}</td>
                      </tr>
                    ))}
                  <tr className="bg-gray-50 dark:bg-gray-700/30 font-bold">
                    <td className="px-2.5 py-2" colSpan={3}>合計 {result.allocations.length}名</td>
                    <td className={td}>{result.totalPoints}</td>
                    <td className={td}>{yen(result.allocations.reduce((s, a) => s + a.amount, 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <button
                onClick={save} disabled={busy || !label.trim() || poolNum <= 0}
                className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? '保存中…' : 'この配分を確定して保存'}
              </button>
              <span className="text-[11px] text-gray-500">
                評語の初期値は年次改定で決めたもの。千円切り上げのぶん、合計は原資をわずかに超えます。役員・事務は対象外。
              </span>
            </div>
          </>
        )}
      </div>
      <section>
        <h3 className="text-sm font-bold mb-2">支給の履歴</h3>
        {records.length === 0 ? (
          <p className="text-xs text-gray-400">まだ記録がありません。</p>
        ) : (
          <div className="space-y-2">
            {records.map(r => (
              <details key={r.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <summary className="cursor-pointer px-4 py-3 text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <b>{r.label}</b>
                  <span className="text-xs text-gray-500 tabular-nums">{r.paidOn}</span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    原資 {yen(r.pool)} ／ {r.allocations.length}名 ／ 支給計 {yen(r.total)}
                  </span>
                </summary>
                <div className="px-4 pb-3 overflow-x-auto">
                  <table className="w-full text-xs min-w-[420px]">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {r.allocations.slice().sort((a, b) => b.points - a.points).map(a => (
                        <tr key={a.workerId}>
                          <td className="py-1.5">{a.name}</td>
                          <td className="py-1.5 text-gray-500">{a.grade === 'doko' ? '土工' : a.grade} / {a.hyogo}</td>
                          <td className="py-1.5 text-right tabular-nums text-gray-500">{a.points}点</td>
                          <td className="py-1.5 text-right tabular-nums font-bold">{yen(a.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-gray-400 mt-2">1点あたり {r.unit.toFixed(2)}円（合計 {r.totalPoints}点）</p>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

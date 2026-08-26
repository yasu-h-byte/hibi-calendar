'use client'

/**
 * 昇格（docs/wage-system.md 第9節）。
 *
 * 等級を上げると、新等級で「現在の日額を上回る最初の号」へ読み替わる（日額は下がらない）。
 * 人員マスタを直接書き換えるだけだと「いつ・なぜ昇格したか」が残らないので、
 * この画面から行い、履歴として積む。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  promote, dailyForStep, capDaily, GRADE_LABELS, GRADES_IN_ORDER, type JpGrade,
} from '@/lib/jp-wage'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

interface W { id: number; name: string; grade: JpGrade | ''; step: number | null; daily: number }
interface Rec {
  id: string; workerId: number; name: string; at: string
  fromGrade: string; fromStep: number | null; fromDaily: number
  toGrade: string; toStep: number; toDaily: number
  addPitch: number; reason: string
}

export default function PromotionPanel() {
  const [pw, setPw] = useState('')
  const [workers, setWorkers] = useState<W[]>([])
  const [records, setRecords] = useState<Rec[]>([])
  const [sel, setSel] = useState<number | ''>('')
  const [toGrade, setToGrade] = useState<JpGrade | ''>('')
  const [addPitch, setAddPitch] = useState('0')
  const [reason, setReason] = useState('')
  const [at, setAt] = useState(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async (password: string) => {
    try {
      const [wr, pr] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/jp-wage/promotion', { headers: { 'x-admin-password': password } }),
      ])
      if (wr.ok) {
        const j = await wr.json()
        setWorkers((j.workers as Record<string, unknown>[])
          .filter(w => !w.retired && (!w.visaType || w.visaType === 'none'))
          .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
          .map(w => ({
            id: Number(w.id), name: String(w.name),
            grade: (w.jpGrade as JpGrade) || '', step: w.jpStep ? Number(w.jpStep) : null,
            daily: Number(w.rate) || 0,
          })))
      }
      if (pr.ok) setRecords((await pr.json()).records)
    } catch { setErr('読み込みに失敗しました') }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const p = raw ? JSON.parse(raw)?.password : ''
      if (!p) return
      setPw(p); load(p)
    } catch { /* 履歴が出せなくても致命的ではない */ }
  }, [load])

  const target = workers.find(w => w.id === sel)
  const pitch = Math.max(0, Number(addPitch) || 0)
  const preview = target && toGrade && target.daily > 0 && target.daily <= capDaily(toGrade)
    ? promote(toGrade, target.daily, pitch)
    : null
  const overCap = !!(target && toGrade && target.daily > capDaily(toGrade))

  const apply = async () => {
    if (!target || !toGrade || !preview) return
    if (!confirm(
      `${target.name} さんを ${toGrade} ${GRADE_LABELS[toGrade]} へ昇格します。\n\n` +
      `${target.grade || '未設定'} ${target.step ?? '—'}号 ${yen(target.daily)}\n` +
      `　→ ${toGrade} ${preview.newStep}号 ${yen(preview.newDaily)}\n\n` +
      `人員マスタが書き換わり、履歴に残ります。よろしいですか？`
    )) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/promotion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({ workerId: target.id, toGrade, addPitch: pitch, reason, at }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `失敗しました（${res.status}）`)
      setMsg(`${target.name} さんを ${toGrade} ${preview.newStep}号 へ昇格しました`)
      setSel(''); setToGrade(''); setAddPitch('0'); setReason('')
      await load(pw)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失敗しました')
    } finally { setBusy(false) }
  }

  const th = 'px-3 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-3 py-2 align-top'
  const input = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none'

  return (
    <div className="space-y-5">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">昇格の考え方</div>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
          等級は<b>役割</b>が変わったときに上がります（在籍年数では上がりません）。
          新等級で「現在の日額を上回る最初の号」へ読み替えるので、<b>日額は下がりません</b>。
          年次改定と同時に昇格する場合は、読み替えた号に当期の合計ピッチを足します。<br />
          壁は <b>4G 上級班長 → 5G 職長</b> の間。「職長という役職で現場を任されたとき」が基準です。
        </p>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">{err}</div>}
      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-bold mb-3">昇格させる</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs text-gray-500 block mb-1">対象者</label>
            <select value={sel} onChange={e => { setSel(e.target.value ? Number(e.target.value) : ''); setToGrade('') }} className={input}>
              <option value="">選択してください</option>
              {workers.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}（{w.grade ? `${w.grade} ${w.step ?? '—'}号` : '等級未設定'}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">新しい等級</label>
            <select value={toGrade} onChange={e => setToGrade(e.target.value as JpGrade)} disabled={!target} className={input}>
              <option value="">選択してください</option>
              {GRADES_IN_ORDER.filter(g => g !== target?.grade).map(g => (
                <option key={g} value={g}>{g === 'doko' ? '土工' : g} {GRADE_LABELS[g]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">当期ピッチの加算</label>
            <input type="number" min={0} step={1} value={addPitch} onChange={e => setAddPitch(e.target.value)} className={`${input} tabular-nums`} />
            <p className="text-[10px] text-gray-400 mt-1">年次改定と同時なら合計ピッチを入れる</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">昇格日</label>
            <input type="date" value={at} onChange={e => setAt(e.target.value)} className={input} />
          </div>
        </div>

        <div className="mt-3">
          <label className="text-xs text-gray-500 block mb-1">昇格の理由（必須）</label>
          <input
            type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="例：笹塚現場の職長として着任"
            className={`${input} ${!reason.trim() ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20' : ''}`}
          />
        </div>

        {overCap && target && toGrade && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-3">
            現在の日額 {yen(target.daily)} が {toGrade} の上限 {yen(capDaily(toGrade))} を超えています。この等級には収容できません。
          </p>
        )}

        {target && preview && (
          <div className="mt-3 rounded-lg bg-gray-50 dark:bg-gray-700/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 tabular-nums">
              <span className="text-gray-500">
                {target.grade ? `${target.grade === 'doko' ? '土工' : target.grade} ${target.step ?? '—'}号` : '等級未設定'} {yen(target.daily)}
              </span>
              <span className="text-gray-400">→</span>
              <b>{toGrade === 'doko' ? '土工' : toGrade} {preview.newStep}号 {yen(preview.newDaily)}</b>
              {preview.newDaily > target.daily && (
                <span className="text-green-700 dark:text-green-400 font-bold">+{yen(preview.newDaily - target.daily)}</span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              読み替え先は {preview.readStep}号（現在の日額を上回る最初の号）
              {pitch > 0 && <>。そこに当期 {pitch} ピッチを加算して {preview.newStep}号</>}。
              上限は {yen(capDaily(toGrade as JpGrade))}。
            </p>
          </div>
        )}

        <button
          onClick={apply}
          disabled={busy || !target || !toGrade || !preview || !reason.trim()}
          className="mt-3 px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? '処理中…' : '昇格を確定する'}
        </button>
      </section>

      <section>
        <h3 className="text-sm font-bold mb-2">昇格の履歴</h3>
        {records.length === 0 ? (
          <p className="text-xs text-gray-400">まだ記録がありません。</p>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
            <table className="w-full text-sm min-w-[680px]">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className={`${th} text-left`}>昇格日</th><th className={`${th} text-left`}>氏名</th>
                  <th className={`${th} text-left`}>変更</th><th className={`${th} text-right`}>日額</th>
                  <th className={`${th} text-left`}>理由</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {records.map(r => (
                  <tr key={r.id}>
                    <td className={`${td} tabular-nums text-gray-500 whitespace-nowrap`}>{r.at}</td>
                    <td className={`${td} font-medium whitespace-nowrap`}>{r.name}</td>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>
                      <span className="text-gray-500">{r.fromGrade || '—'} {r.fromStep ?? '—'}号</span>
                      <span className="text-gray-400 mx-1">→</span>
                      <b>{r.toGrade} {r.toStep}号</b>
                    </td>
                    <td className={`${td} text-right tabular-nums whitespace-nowrap`}>
                      {yen(r.toDaily)}
                      {r.toDaily > r.fromDaily && (
                        <div className="text-[10px] text-green-700 dark:text-green-400">+{yen(r.toDaily - r.fromDaily)}</div>
                      )}
                    </td>
                    <td className={`${td} text-gray-600 dark:text-gray-300`}>{r.reason}</td>
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

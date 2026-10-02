'use client'
/**
 * 年次改定の新旧比較と人件費の見込み（2026-09-30 代表依頼）
 *
 * 1人ずつ「改定前（今払っている日額）→ 改定後」の日額・年収を並べ、
 * 会社負担の法定福利費を含めた人件費が年間いくら増えるかを出す。
 * 年収は給料表と同じ「日額 ×（稼働290日＋その人の有給の付与日数）」（20日の人は310日・2026-10-01 から本人の付与日数）。計算は lib/labor-cost.ts。
 * 料率は加入先・年度で変わるので、画面で変えられる（この端末に保存）。
 */
import { useEffect, useMemo, useState } from 'react'
import { ageOn, ANNUAL_DAYS, normalizePaidLeaveDays } from '@/lib/jp-wage'
import {
  DEFAULT_WELFARE_RATES, WELFARE_RATE_LABELS, laborCostDelta, totalWelfarePercent, type WelfareRates,
} from '@/lib/labor-cost'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const plus = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + '¥' + Math.abs(Math.round(v)).toLocaleString()
const STORE_KEY = 'hibi_welfare_rates'

export interface LaborCostInputRow {
  id: number
  name: string
  hyogo: string
  birthDate: string | null
  oldStep: number | null
  newStep: number | null
  /** 改定前（今払っている日額） */
  paidBefore: number | null
  /** 改定後の日額 */
  newDaily: number | null
  /** その改定期の有給の付与日数（無ければ既定の20日） */
  paidLeaveDays?: number
}

export default function LaborCostPanel({ rows, effective }: { rows: LaborCostInputRow[]; effective: string }) {
  const [rates, setRates] = useState<WelfareRates>(DEFAULT_WELFARE_RATES)
  const [showRates, setShowRates] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) setRates({ ...DEFAULT_WELFARE_RATES, ...JSON.parse(raw) })
    } catch { /* 既定値のまま */ }
  }, [])
  const setRate = (k: keyof WelfareRates, v: number) => {
    const next = { ...rates, [k]: v }
    setRates(next)
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* 保存できなくても計算はする */ }
  }

  const calc = useMemo(() => rows
    .filter(r => r.paidBefore != null && r.newDaily != null)
    .map(r => {
      const age = r.birthDate ? ageOn(r.birthDate, effective) : null
      return { r, age, d: laborCostDelta(r.paidBefore!, r.newDaily!, ANNUAL_DAYS + normalizePaidLeaveDays(r.paidLeaveDays), age, rates) }
    }), [rows, rates, effective])

  const sum = calc.reduce((a, { d }) => ({
    prevAnnual: a.prevAnnual + d.prevAnnual, newAnnual: a.newAnnual + d.newAnnual,
    pay: a.pay + d.payIncrease, welfare: a.welfare + d.welfareIncrease, total: a.total + d.totalIncrease,
    prevCost: a.prevCost + d.prevAnnual + d.prevWelfare,
  }), { prevAnnual: 0, newAnnual: 0, pay: 0, welfare: 0, total: 0, prevCost: 0 })

  if (calc.length === 0) return null
  const th = 'px-3 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap text-right'
  const td = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'

  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold">新旧比較と人件費の増加（年額の見込み）</h3>
        <button type="button" onClick={() => setShowRates(!showRates)} className="text-xs text-hibi-navy dark:text-blue-300 underline">
          法定福利費の料率 {totalWelfarePercent(rates, false).toFixed(2)}%（40〜64歳は {totalWelfarePercent(rates, true).toFixed(2)}%）{showRates ? '▲' : '▼'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-3">
          <div className="text-xs text-gray-500">給与の増加</div>
          <div className="text-lg font-bold tabular-nums">{plus(sum.pay)}</div>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-3">
          <div className="text-xs text-gray-500">法定福利費の増加（会社負担）</div>
          <div className="text-lg font-bold tabular-nums">{plus(sum.welfare)}</div>
        </div>
        <div className="rounded-lg bg-hibi-navy/5 dark:bg-blue-900/20 border border-hibi-navy/20 p-3">
          <div className="text-xs text-gray-500">人件費の増加 合計</div>
          <div className="text-xl font-extrabold tabular-nums text-hibi-navy dark:text-blue-200">{plus(sum.total)}</div>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 p-3">
          <div className="text-xs text-gray-500">人件費の伸び（対象{calc.length}名）</div>
          <div className="text-lg font-bold tabular-nums">{sum.prevCost > 0 ? `+${(sum.total / sum.prevCost * 100).toFixed(2)}%` : '—'}</div>
          <div className="text-xxs text-gray-400 tabular-nums">{yen(sum.prevCost)} → {yen(sum.prevCost + sum.total)}</div>
        </div>
      </div>

      {showRates && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {(Object.keys(WELFARE_RATE_LABELS) as (keyof WelfareRates)[]).map(k => (
              <label key={k} className="text-xs flex items-center justify-between gap-2">
                <span>{WELFARE_RATE_LABELS[k]}</span>
                <span className="flex items-center gap-1">
                  <input type="number" step="0.001" min={0} value={rates[k]}
                    onChange={e => setRate(k, Math.max(0, Number(e.target.value) || 0))}
                    className="w-20 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-2 py-1 text-right tabular-nums" />%
                </span>
              </label>
            ))}
          </div>
          <p className="text-xxs text-gray-400 mt-2 leading-relaxed">
            いずれも会社負担分。既定値は2026年度の目安（協会けんぽ東京・建設の事業）です。加入先の実際の料率に合わせて直してください（この端末に保存）。
            <button type="button" onClick={() => { setRates(DEFAULT_WELFARE_RATES); try { localStorage.removeItem(STORE_KEY) } catch { /* noop */ } }}
              className="ml-2 underline">既定値に戻す</button>
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className={`${th} text-left`}>名前</th>
              <th className={`${th} text-center`}>評語</th>
              <th className={th}>号</th>
              <th className={th}>日額 改定前 → 改定後</th>
              <th className={th}>年収 改定前 → 改定後</th>
              <th className={th}>給与の増</th>
              <th className={th}>法定福利費の増</th>
              <th className={th}>人件費の増</th>
            </tr>
          </thead>
          <tbody>
            {calc.map(({ r, d }) => (
              <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/60">
                <td className="px-3 py-2 whitespace-nowrap">{r.name}</td>
                <td className="px-3 py-2 text-center">{r.hyogo}</td>
                <td className={td}>{r.oldStep ?? '—'} → {r.newStep ?? '—'}</td>
                <td className={td}>{yen(r.paidBefore!)} → <b>{yen(r.newDaily!)}</b> <span className="text-xs text-green-700 dark:text-green-400">{plus(r.newDaily! - r.paidBefore!)}</span></td>
                <td className={td}>{yen(d.prevAnnual)} → {yen(d.newAnnual)}</td>
                <td className={td}>{plus(d.payIncrease)}</td>
                <td className={td}>{plus(d.welfareIncrease)}</td>
                <td className={`${td} font-bold`}>{plus(d.totalIncrease)}</td>
              </tr>
            ))}
            <tr className="font-bold bg-gray-50 dark:bg-gray-700/40">
              <td className="px-3 py-2" colSpan={4}>合計</td>
              <td className={td}>{yen(sum.prevAnnual)} → {yen(sum.newAnnual)}</td>
              <td className={td}>{plus(sum.pay)}</td>
              <td className={td}>{plus(sum.welfare)}</td>
              <td className={td}>{plus(sum.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xxs text-gray-400 leading-relaxed">
        改定前は「今払っている日額」（号俸表の額ではなく実際の支払額）。年収は給料表と同じ 日額 ×（稼働290日＋その人の有給の付与日数。20日の人は310日）。
        法定福利費は年収÷12を月額とみなした概算で、厚生年金は標準報酬の上限（月65万円）で頭打ち、介護保険は40〜64歳だけ。
        残業代・賞与・労災保険（下請は元請の現場労災）は含みません。実際の保険料は標準報酬の等級と改定時期で前後します。
      </p>
    </section>
  )
}

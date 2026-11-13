'use client'
/**
 * 平均日給の推移（/wage-average）のグラフ2つ。手書きの SVG（グラフ用のライブラリは入れていない）。
 * Tailwind のクラスは完全な文字列で書く（組み立てると CSS が生成されない・CLAUDE.md）。
 */
import { useState } from 'react'
import type { AvgWagePoint, Decomposition } from '@/lib/avg-wage'

export const yenRound = (v: number) => `${Math.round(v).toLocaleString()}円`
export const signedYen = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString()}円`
export const ymLabel = (ym: string) => `${ym.slice(0, 4)}年${Number(ym.slice(4, 6))}月`
const ymShort = (ym: string) => `${ym.slice(2, 4)}/${Number(ym.slice(4, 6))}`

/** 「きりのいい」目盛りの幅 */
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count)
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

const SERIES = [
  { key: 'all', label: '全体', line: 'stroke-sky-600 dark:stroke-sky-400', dot: 'fill-sky-600 dark:fill-sky-400', dash: undefined },
  { key: 'jp', label: '日本人', line: 'stroke-orange-500', dot: 'fill-orange-500', dash: '6 4' },
  { key: 'foreign', label: '外国人', line: 'stroke-emerald-600 dark:stroke-emerald-400', dot: 'fill-emerald-600 dark:fill-emerald-400', dash: '2 3' },
] as const

/** ① 平均日給の推移（全体・日本人・外国人）＋目標線 */
export function TrendChart({ points, target }: { points: AvgWagePoint[]; target: number | null }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = 260, L = 56, R = 12, T = 12, B = 30
  const vals = points.flatMap(p => [p.all.avg, p.jp.avg, p.foreign.avg]).filter((v): v is number => v !== null)
  if (target !== null) vals.push(target)
  if (vals.length === 0) return <p className="text-sm text-hibi-sub dark:text-gray-400 py-8 text-center">まだ記録がありません</p>
  const step = niceStep(Math.max(...vals) - Math.min(...vals), 4)
  const lo = Math.floor(Math.min(...vals) / step) * step, hi = Math.ceil(Math.max(...vals) / step) * step + (Math.max(...vals) === Math.min(...vals) ? step : 0)
  const x = (i: number) => L + (points.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1))
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / Math.max(1, hi - lo)
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v)
  const labelEvery = Math.max(1, Math.ceil(points.length / 12))
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={`平均日給の推移。最新 ${points.length ? ymLabel(points[points.length - 1].ym) : ''}`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-gray-500 dark:fill-gray-400 text-2xs">{v.toLocaleString()}</text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) && (
          <text key={p.ym} x={x(i)} y={H - 10} textAnchor="middle" className="fill-gray-500 dark:fill-gray-400 text-2xs">{ymShort(p.ym)}</text>
        ))}
        {target !== null && (
          <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1.5} strokeDasharray="5 4" />
        )}
        {SERIES.map(s => {
          const pts = points.map((p, i) => ({ i, v: p[s.key].avg, restored: p.source === 'restored' })).filter(q => q.v !== null) as { i: number; v: number; restored: boolean }[]
          return (
            <g key={s.key}>
              <polyline fill="none" className={s.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dash} points={pts.map(q => `${x(q.i)},${y(q.v)}`).join(' ')} />
              {pts.map(q => q.restored
                ? <circle key={q.i} cx={x(q.i)} cy={y(q.v)} r={3.5} className={`${s.line} fill-white dark:fill-gray-900`} strokeWidth={1.5} />
                : <circle key={q.i} cx={x(q.i)} cy={y(q.v)} r={3.5} className={s.dot} />)}
            </g>
          )
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />}
        {points.map((p, i) => (
          <rect key={p.ym} x={x(i) - (W - L - R) / Math.max(2, points.length) / 2} y={T} height={H - T - B}
            width={(W - L - R) / Math.max(2, points.length)} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && points[hover] && (
        <div className="absolute top-2 right-2 rounded-lg border border-hibi-line dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 px-3 py-2 text-xs text-gray-800 dark:text-gray-200 tabular-nums pointer-events-none">
          <div className="font-bold mb-1">{ymLabel(points[hover].ym)}{points[hover].source === 'restored' && <span className="ml-1 font-normal text-hibi-sub">（参考）</span>}</div>
          {SERIES.map(s => {
            const st = points[hover][s.key]
            return <div key={s.key}>{s.label} {st.avg !== null ? yenRound(st.avg) : '—'}<span className="text-hibi-sub dark:text-gray-400">（{st.n}人）</span></div>
          })}
        </div>
      )}
    </div>
  )
}

export function TrendLegend({ showTarget }: { showTarget: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-hibi-sub dark:text-gray-400">
      <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="stroke-sky-600 dark:stroke-sky-400" strokeWidth="2" /></svg>全体</span>
      <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="stroke-orange-500" strokeWidth="2" strokeDasharray="6 4" /></svg>日本人</span>
      <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="stroke-emerald-600 dark:stroke-emerald-400" strokeWidth="2" strokeDasharray="2 3" /></svg>外国人</span>
      {showTarget && <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="stroke-gray-500 dark:stroke-gray-400" strokeWidth="1.5" strokeDasharray="5 4" /></svg>目標</span>}
      <span className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" className="stroke-gray-500 fill-white dark:fill-gray-900" strokeWidth="1.5" /></svg>白抜き＝人員マスタからさかのぼった点（参考）</span>
    </div>
  )
}

/** ② 前の点 → 辞めた人 → 昇給 → 入った人 → 今の点 の滝グラフ */
export function WaterfallChart({ d, fromLabel, toLabel }: { d: Decomposition; fromLabel: string; toLabel: string }) {
  if (d.avgFrom === null || d.avgTo === null) {
    return <p className="text-sm text-hibi-sub dark:text-gray-400 py-8 text-center">比べる人がいません</p>
  }
  const steps: { label: string; sub: string; from: number; to: number; kind: 'total' | 'up' | 'down' | 'zero' }[] = []
  let run = d.avgFrom
  steps.push({ label: fromLabel, sub: `${d.nFrom}人`, from: 0, to: d.avgFrom, kind: 'total' })
  const add = (label: string, sub: string, v: number) => {
    steps.push({ label, sub, from: run, to: run + v, kind: Math.round(v) === 0 ? 'zero' : v > 0 ? 'up' : 'down' })
    run += v
  }
  add('辞めた人', `${d.leavers}人`, d.leaverEffect)
  add('続けている人の昇給', `${d.stayers}人`, d.raiseEffect)
  add('新しく入った人', `${d.joiners}人`, d.joinerEffect)
  steps.push({ label: toLabel, sub: `${d.nTo}人`, from: 0, to: d.avgTo, kind: 'total' })

  const W = 720, H = 250, L = 56, R = 12, T = 22, B = 40
  const tops = steps.flatMap(s => s.kind === 'total' ? [s.to] : [s.from, s.to])
  const span = Math.max(...tops) - Math.min(...tops)
  const step = niceStep(Math.max(span, 1) * 1.6, 4)
  const lo = Math.floor((Math.min(...tops) - span * 0.3) / step) * step
  const hi = Math.ceil((Math.max(...tops) + span * 0.15) / step) * step + (span === 0 ? step : 0)
  const y = (v: number) => T + ((hi - Math.max(lo, v)) * (H - T - B)) / Math.max(1, hi - lo)
  const slot = (W - L - R) / steps.length
  const bw = Math.min(56, slot * 0.55)
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v)
  const FILL = { total: 'fill-gray-400 dark:fill-gray-500', up: 'fill-orange-500', down: 'fill-sky-600 dark:fill-sky-500', zero: 'fill-gray-300 dark:fill-gray-600' } as const
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
      aria-label={`${fromLabel} ${yenRound(d.avgFrom)}、辞めた人 ${signedYen(d.leaverEffect)}、昇給 ${signedYen(d.raiseEffect)}、入った人 ${signedYen(d.joinerEffect)}、${toLabel} ${yenRound(d.avgTo)}`}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-gray-500 dark:fill-gray-400 text-2xs">{v.toLocaleString()}</text>
        </g>
      ))}
      {steps.map((s, i) => {
        const cx = L + slot * i + slot / 2
        const top = y(Math.max(s.from, s.to)), bottom = s.kind === 'total' ? y(lo) : y(Math.min(s.from, s.to))
        const h = Math.max(2, bottom - top)
        const val = s.kind === 'total' ? yenRound(s.to) : signedYen(s.to - s.from)
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={top} width={bw} height={h} rx={3} className={FILL[s.kind]} />
            {i < steps.length - 1 && (
              <line x1={cx + bw / 2} x2={cx + slot - bw / 2} y1={y(s.to)} y2={y(s.to)} className="stroke-gray-400 dark:stroke-gray-500" strokeWidth={1} strokeDasharray="2 2" />
            )}
            <text x={cx} y={top - 6} textAnchor="middle" className="fill-gray-800 dark:fill-gray-200 text-2xs font-bold">{val}</text>
            <text x={cx} y={H - 22} textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-2xs">{s.label}</text>
            <text x={cx} y={H - 8} textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-2xs">{s.sub}</text>
          </g>
        )
      })}
    </svg>
  )
}

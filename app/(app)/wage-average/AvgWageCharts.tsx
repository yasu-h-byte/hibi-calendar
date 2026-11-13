'use client'
/**
 * 平均日給の推移（/wage-average）のグラフ2つ。手書きの SVG（グラフ用のライブラリは入れていない）。
 * Tailwind のクラスは完全な文字列で書く（組み立てると CSS が生成されない・CLAUDE.md）。
 */
import { useState } from 'react'
import type { AvgWagePoint, Decomposition, RaisePeriod } from '@/lib/avg-wage'

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
  // 横軸は時間（年1回の資料の点と毎月の点が混ざるので、点の順番ではなく月で並べる）
  const mi = points.map(p => Number(p.ym.slice(0, 4)) * 12 + Number(p.ym.slice(4, 6)) - 1)
  const m0 = mi[0] ?? 0, mSpan = Math.max(1, (mi[mi.length - 1] ?? 0) - m0)
  const x = (i: number) => L + (points.length <= 1 ? (W - L - R) / 2 : ((mi[i] - m0) * (W - L - R)) / mSpan)
  // マウスを当てる幅: 隣の点との中間まで
  const edge = (i: number, side: -1 | 1) => {
    const j = i + side
    return j < 0 || j >= points.length ? x(i) + side * 8 : (x(i) + x(j)) / 2
  }
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / Math.max(1, hi - lo)
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v)
  // 目盛りの文字: 右端（最新）から左へ、間が詰まりすぎない点だけ
  const labelIdx = new Set<number>()
  let prevX = Infinity
  for (let i = points.length - 1; i >= 0; i--) {
    if (prevX - x(i) >= 44) { labelIdx.add(i); prevX = x(i) }
  }
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
        {points.map((p, i) => labelIdx.has(i) && (
          <text key={p.ym} x={x(i)} y={H - 10} textAnchor="middle" className="fill-gray-500 dark:fill-gray-400 text-2xs">{ymShort(p.ym)}</text>
        ))}
        {target !== null && (
          <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1.5} strokeDasharray="5 4" />
        )}
        {SERIES.map(s => {
          const pts = points.map((p, i) => ({ i, v: p[s.key].avg, src: p.source })).filter(q => q.v !== null) as { i: number; v: number; src: AvgWagePoint['source'] }[]
          return (
            <g key={s.key}>
              <polyline fill="none" className={s.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dash} points={pts.map(q => `${x(q.i)},${y(q.v)}`).join(' ')} />
              {pts.map(q => q.src === 'document'
                ? <rect key={q.i} x={x(q.i) - 3.5} y={y(q.v) - 3.5} width={7} height={7} className={`${s.line} fill-white dark:fill-gray-900`} strokeWidth={1.5} />
                : q.src === 'restored'
                  ? <circle key={q.i} cx={x(q.i)} cy={y(q.v)} r={3.5} className={`${s.line} fill-white dark:fill-gray-900`} strokeWidth={1.5} />
                  : <circle key={q.i} cx={x(q.i)} cy={y(q.v)} r={3.5} className={s.dot} />)}
            </g>
          )
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />}
        {points.map((p, i) => (
          <rect key={p.ym} x={edge(i, -1)} y={T} height={H - T - B}
            width={Math.max(1, edge(i, 1) - edge(i, -1))} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && points[hover] && (
        <div className="absolute top-2 right-2 rounded-lg border border-hibi-line dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 px-3 py-2 text-xs text-gray-800 dark:text-gray-200 tabular-nums pointer-events-none">
          <div className="font-bold mb-1">{ymLabel(points[hover].ym)}{points[hover].source === 'restored' && <span className="ml-1 font-normal text-hibi-sub">（参考）</span>}{points[hover].source === 'document' && <span className="ml-1 font-normal text-hibi-sub">【資料から】</span>}</div>
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
      <span className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" className="stroke-gray-500 fill-white dark:fill-gray-900" strokeWidth="1.5" /></svg>四角＝【資料から】給料解説書の10月1日の確定日給（日本人だけ）</span>
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

/**
 * ③ 月ごとの昇給: 隣り合う点のあいだに、続けている人の日給がいくら上がったか（合計・円／日）を、日本人と外国人で積み上げる。
 * 資料の年（12か月ぶん）は1年分の合計なので、薄い色で区別する。
 */
export function RaiseChart({ raises }: { raises: RaisePeriod[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const rows = raises.filter(r => (r.jp?.total ?? 0) + (r.foreign?.total ?? 0) > 0 || r.months === 1)
  if (rows.length === 0) return <p className="text-sm text-hibi-sub dark:text-gray-400 py-8 text-center">まだ比べられる点がありません</p>
  const W = 720, H = 220, L = 56, R = 12, T = 18, B = 30
  const mi = rows.map(r => Number(r.to.slice(0, 4)) * 12 + Number(r.to.slice(4, 6)) - 1)
  const m0 = mi[0], mSpan = Math.max(1, mi[mi.length - 1] - m0)
  const x = (i: number) => L + 10 + (rows.length <= 1 ? (W - L - R - 20) / 2 : ((mi[i] - m0) * (W - L - R - 20)) / mSpan)
  const tot = (r: RaisePeriod) => (r.jp?.total ?? 0) + (r.foreign?.total ?? 0)
  const max = Math.max(1, ...rows.map(tot))
  const step = niceStep(max, 4)
  const hi = Math.ceil(max / step) * step
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / hi
  const ticks: number[] = []
  for (let v = 0; v <= hi + 1e-6; v += step) ticks.push(v)
  // 棒の幅: 隣の点との間隔のいちばん狭いところに合わせる（毎月の点が詰まって重ならないように）
  let gap = Infinity
  for (let i = 1; i < rows.length; i++) gap = Math.min(gap, x(i) - x(i - 1))
  const bw = Math.max(3, Math.min(22, (Number.isFinite(gap) ? gap : 40) * 0.7))
  const labelIdx = new Set<number>()
  let prevX = Infinity
  for (let i = rows.length - 1; i >= 0; i--) if (prevX - x(i) >= 44) { labelIdx.add(i); prevX = x(i) }
  const h = hover !== null ? rows[hover] : null
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="期間ごとの昇給の合計（日本人・外国人）" onMouseLeave={() => setHover(null)}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-gray-500 dark:fill-gray-400 text-2xs">{v.toLocaleString()}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const jp = r.jp?.total ?? 0, fo = r.foreign?.total ?? 0
          const yearly = r.months > 1
          return (
            <g key={r.from + r.to} onMouseEnter={() => setHover(i)}>
              <rect x={x(i) - Math.max(bw, 10) / 2} y={T} width={Math.max(bw, 10)} height={H - T - B} fill="transparent" />
              {jp > 0 && <rect x={x(i) - bw / 2} y={y(jp)} width={bw} height={Math.max(1, y(0) - y(jp))} rx={2}
                className={yearly ? 'fill-orange-300 dark:fill-orange-700' : 'fill-orange-500'} />}
              {fo > 0 && <rect x={x(i) - bw / 2} y={y(jp + fo)} width={bw} height={Math.max(1, y(jp) - y(jp + fo))} rx={2}
                className="fill-emerald-600 dark:fill-emerald-500" />}
              {labelIdx.has(i) && <text x={x(i)} y={H - 10} textAnchor="middle" className="fill-gray-500 dark:fill-gray-400 text-2xs">{ymShort(r.to)}</text>}
            </g>
          )
        })}
      </svg>
      {h && (
        <div className="absolute top-1 right-2 rounded-lg border border-hibi-line dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 px-3 py-2 text-xs text-gray-800 dark:text-gray-200 tabular-nums pointer-events-none">
          <div className="font-bold mb-1">{ymLabel(h.from)} → {ymLabel(h.to)}{h.months > 1 && <span className="ml-1 font-normal text-hibi-sub">（{h.months}か月分）</span>}</div>
          <RaiseLine label="日本人" s={h.jp} />
          <RaiseLine label="外国人" s={h.foreign} />
        </div>
      )}
    </div>
  )
}

export function RaiseLine({ label, s }: { label: string; s: RaisePeriod['jp'] }) {
  if (!s) return <div>{label} <span className="text-hibi-sub dark:text-gray-400">資料なし</span></div>
  if (s.raised === 0) return <div>{label} 昇給なし<span className="text-hibi-sub dark:text-gray-400">（{s.stayers}人）</span></div>
  return (
    <div>{label} {s.raised}人・合計 +{Math.round(s.total).toLocaleString()}円／日
      <span className="text-hibi-sub dark:text-gray-400">（1人あたり +{Math.round(s.total / s.raised).toLocaleString()}円）</span>
    </div>
  )
}

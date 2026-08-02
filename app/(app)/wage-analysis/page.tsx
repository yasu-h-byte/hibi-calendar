'use client'

/**
 * 賃金分析（代表専用）
 *
 * ベトナム人スタッフの「在籍年数に対して相対的に高い／低い」を複数基準で可視化する。
 * 今後の昇給評価（/evaluation）とは別軸の参考資料。
 *
 * ⚠️ 個人の賃金を一覧するため、代表（workerId=0）以外には表示しない。
 *    データ取得も /api/workers（管理者パスワード必須）経由のみ。
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  buildWageAnalysis, modelWage, findInversions, stageIQROutliers,
  STAGES, TOKYO_MIN_WAGE, MODEL_RAISE_RATE,
  MARKET_REFERENCE, KENSETSU_TOKUTEI, type WageAnalysis, type WageRow,
} from '@/lib/wage-analysis'

const OWNER_ID = 0 // 日比靖仁

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const signed = (v: number) => (v >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString()

export default function WageAnalysisPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [rows, setRows] = useState<WageAnalysis | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let pw = ''
    try {
      const raw = localStorage.getItem('hibi_auth')
      const parsed = raw ? JSON.parse(raw) : null
      pw = parsed?.password || ''
      if (parsed?.user?.workerId !== OWNER_ID) { setAllowed(false); return }
      setAllowed(true)
    } catch { setAllowed(false); return }

    ;(async () => {
      try {
        const res = await fetch('/api/workers', { headers: { 'x-admin-password': pw } })
        if (!res.ok) throw new Error('取得に失敗しました')
        const { workers } = await res.json()
        const today = new Date()
        const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        const target = (workers as Record<string, unknown>[])
          .filter(w => w.visaType && w.visaType !== 'none' && !w.retired && Number(w.hourlyRate) > 0)
          .map(w => ({
            id: Number(w.id), name: String(w.name), visaType: String(w.visaType),
            hireDate: String(w.hireDate || ''), hourlyRate: Number(w.hourlyRate),
          }))
        setRows(buildWageAnalysis(target, todayIso))
      } catch (e) {
        setErr(e instanceof Error ? e.message : '不明なエラー')
      }
    })()
  }, [])

  if (allowed === null) return <div className="p-6 text-gray-500">読み込み中…</div>
  if (!allowed) return (
    <div className="p-6">
      <h1 className="text-lg font-semibold mb-2">閲覧権限がありません</h1>
      <p className="text-sm text-gray-500">この資料は代表のみが閲覧できます。</p>
      <Link href="/docs" className="text-sm text-blue-600 mt-3 inline-block">← 資料一覧へ</Link>
    </div>
  )
  if (err) return <div className="p-6 text-red-600">エラー: {err}</div>
  if (!rows) return <div className="p-6 text-gray-500">集計中…</div>

  return <Report a={rows} />
}

function Report({ a }: { a: WageAnalysis }) {
  const rows = a.rows
  const lows = rows.filter(r => r.allLow)
  const highs = rows.filter(r => r.allHigh)
  const withCagr = rows.filter(r => r.cagr !== null)
  const avgCagr = withCagr.length ? withCagr.reduce((s, r) => s + r.cagr!, 0) / withCagr.length : 0
  const avgReal = withCagr.length ? withCagr.reduce((s, r) => s + (r.realGain ?? 0), 0) / withCagr.length : 0

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-8">
      <header>
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-xl font-semibold">賃金分析</h1>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800">代表のみ</span>
        </div>
        <p className="text-sm text-gray-500">
          在籍{rows.length}名／東京都最低賃金 現在 {yen(a.currentMinWage)}。
          在籍年数に対して相対的に高い・低いを3つの基準で判定しています。今後の昇給評価とは別軸の参考資料です。
        </p>
      </header>

      <section className="grid sm:grid-cols-2 gap-3">
        <Flag tone="low" title="3基準すべてで低い" items={lows} />
        <Flag tone="high" title="3基準すべてで高い" items={highs} />
      </section>

      <Card title="① 在籍年数 × 時給" note="青の実線＝各段階の平均（この線より下が段階内で低い）。灰の破線＝全体平均。赤＝一貫して低い人、青＝一貫して高い人。点にカーソルを合わせる（スマホはタップ）と氏名と内訳が出ます。">
        <Scatter a={a} />
      </Card>

      <Card title="② 年平均昇給率（入社時の東京都最低賃金が起点）" note={`起点＝入社時の最低賃金を10円単位で切上げ。灰色の細い棒＝同期間の最賃上昇率。両者の差が実質的な昇給。平均 ${avgCagr.toFixed(2)}%（実質 +${avgReal.toFixed(2)}pt）。`}>
        <CagrChart rows={rows} />
      </Card>

      <Card title="③ 3つの基準での位置" note={`A＝同じ段階の平均との差／B＝全体傾向線（${Math.round(a.trend.a)}+${Math.round(a.trend.b)}×年）との差／C＝同期入社者との差。3つとも赤なら要検討。基準が食い違う人は別の材料が要る。`}>
        <Matrix rows={rows} />
      </Card>

      <Card title="④ 段階ごとの賃金と段差" note="制度上の段階（1年目=実習1号／2〜3年目=2号／4〜5年目=3号／6年目〜=特定技能）ごとの平均と、移行時の昇給率。">
        <StageTable a={a} />
      </Card>

      <Card title={`⑤ 今後の昇給モデル（年${(MODEL_RAISE_RATE * 100).toFixed(0)}％・10年で約2倍）`}
        note={`起点は新規入社と同じ ${yen(a.modelStart)}。定率なので上げ幅は年々大きくなる（1年目 +${yen(modelWage(a.modelStart, 1) - a.modelStart)} → 10年目 +${yen(modelWage(a.modelStart, 10) - modelWage(a.modelStart, 9))}）。`}>
        <ModelTable a={a} />
      </Card>

      <Card title="⑥ 現在の在籍者とモデルの差"
        note="＋＝モデルより高い（今後の昇給を抑える余地がある）／−＝モデルより低い（追いつかせる対象）。段階的に昇給スピードを調整する際の目安。">
        <ModelGap a={a} />
      </Card>

      <Card title="⑦ 参考データ（外部・法令）"
        note="いずれも全国値。東京都は地域別最低賃金が全国最高のため、実勢はこれより高いとみて読むこと。">
        <Reference a={a} />
      </Card>

      <Card title="⑧ 逆転・外れ値チェック"
        note="「在籍が長いのに時給が低い」ペアの全数調査（Kendall の順位相関）と、段階内の箱ひげ（IQR）基準の外れ値。昇給協議で個別に確認する候補。">
        <AnomalyCheck a={a} />
      </Card>

      <DataTable a={a} />

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer py-1">東京都最低賃金の推移（計算の前提）</summary>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {TOKYO_MIN_WAGE.map(m => (
            <span key={m.from}>{m.from.slice(0, 7)} {yen(m.yen)}</span>
          ))}
        </div>
        <p className="mt-2">2020年はコロナ禍により改定なし。毎年10月に改定されるため、<code>lib/wage-analysis.ts</code> の表に追記が必要。</p>
      </details>
    </div>
  )
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-1">{title}</h2>
      {note && <p className="text-xs text-gray-500 mb-2 leading-relaxed">{note}</p>}
      {children}
    </section>
  )
}

function Flag({ tone, title, items }: { tone: 'low' | 'high'; title: string; items: WageRow[] }) {
  const border = tone === 'low' ? 'border-l-red-500' : 'border-l-blue-500'
  return (
    <div className={`bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border-l-4 ${border}`}>
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-sm font-semibold mt-1 leading-relaxed">
        {items.length
          ? items.map(r => <div key={r.id}>{r.name}（{r.years}年 {yen(r.hourly)}）</div>)
          : <span className="text-gray-400 font-normal">該当なし</span>}
      </div>
    </div>
  )
}

/** 散布図のツールチップ。SVG内に描くので最後にレンダリングして最前面にする。 */
function Tip({ r, x, y, W }: { r: WageRow; x: number; y: number; W: number }) {
  const lines = [
    `${r.years}年 ／ ${STAGES[r.stage].key}`,
    `時給 ${yen(r.hourly)}（月額 ${yen(r.hourly * 140)}）`,
    `段階内平均との差 ${signed(r.devStage)}`,
    r.devCohort !== null ? `同期との差 ${signed(r.devCohort)}` : '同期なし',
    `7%モデルとの差 ${signed(r.devModel)}`,
  ]
  // 名前(baseline by+17) + 明細(by+34 から 15px 間隔)。最終行の下に余白を残す
  const w = 214, h = 30 + lines.length * 15
  // 右端に近ければ左側に出す。上端に近ければ下に出す。
  const flipX = x + w + 18 > W
  const bx = flipX ? x - w - 14 : x + 14
  const by = Math.max(2, y - h / 2)
  return (
    <g pointerEvents="none">
      <rect x={bx} y={by} width={w} height={h} rx={6}
        className="fill-gray-900/95 dark:fill-gray-100/95" />
      <text x={bx + 10} y={by + 17} className="fill-white dark:fill-gray-900 text-[12px] font-semibold">{r.name}</text>
      {lines.map((t, i) => (
        <text key={i} x={bx + 10} y={by + 34 + i * 15} className="fill-gray-300 dark:fill-gray-600 text-[11px]">{t}</text>
      ))}
    </g>
  )
}

function Scatter({ a }: { a: WageAnalysis }) {
  const rows = a.rows
  const [hover, setHover] = useState<WageRow | null>(null)
  const W = 900, H = 420, ML = 74, MR = 20, MT = 14, MB = 62
  const PW = W - ML - MR, PH = H - MT - MB
  const hs = rows.map(r => r.hourly)
  const y0 = Math.floor((Math.min(...hs) - 120) / 100) * 100
  const y1 = Math.ceil((Math.max(...hs) + 120) / 100) * 100
  const x1 = Math.max(10.5, Math.ceil(Math.max(...rows.map(r => r.years)) + 0.7))
  const px = (v: number) => ML + ((v + 0.5) / (x1 + 0.5)) * PW
  const py = (v: number) => MT + ((y1 - v) / (y1 - y0)) * PH
  const ticks: number[] = []
  for (let t = y0; t <= y1; t += 200) ticks.push(t)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="在籍年数と時給の散布図">
      {ticks.map(t => (
        <g key={t}>
          <line x1={ML} y1={py(t)} x2={ML + PW} y2={py(t)} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth={1} />
          <text x={ML - 8} y={py(t) + 4} textAnchor="end" className="fill-gray-400 text-[11px]">{yen(t)}</text>
        </g>
      ))}
      {Array.from({ length: Math.floor(x1 / 2) + 1 }, (_, i) => i * 2).map(t => (
        <text key={t} x={px(t)} y={MT + PH + 18} textAnchor="middle" className="fill-gray-400 text-[11px]">{t}年</text>
      ))}
      <line x1={ML} y1={py(a.overallAvg)} x2={ML + PW} y2={py(a.overallAvg)} stroke="currentColor" strokeDasharray="6 5" className="text-gray-400" strokeWidth={1.5} />
      {STAGES.slice(0, 4).map((s, i) => a.stageAvg[i] > 0 && (
        <g key={s.key}>
          <line x1={px(s.from)} y1={py(a.stageAvg[i])} x2={px(Math.min(s.to, x1))} y2={py(a.stageAvg[i])} stroke="currentColor" className="text-blue-600 dark:text-blue-400" strokeWidth={2.5} />
          <text x={(px(s.from) + px(Math.min(s.to, x1))) / 2} y={MT + PH + 36} textAnchor="middle" className="fill-gray-500 text-[11px] font-semibold">{s.key}</text>
          <text x={(px(s.from) + px(Math.min(s.to, x1))) / 2} y={MT + PH + 50} textAnchor="middle" className="fill-blue-600 dark:fill-blue-400 text-[10px]">平均 {yen(a.stageAvg[i])}</text>
        </g>
      ))}
      {rows.map(r => (
        <g key={r.id}>
          <circle cx={px(r.years)} cy={py(r.hourly)} r={hover?.id === r.id ? 10 : r.allLow || r.allHigh ? 8 : 6}
            className={r.allLow ? 'fill-red-500' : r.allHigh ? 'fill-blue-600 dark:fill-blue-400' : 'fill-gray-400'}
            stroke="white" strokeWidth={1.5} />
          {(r.allLow || r.allHigh) && (
            <text x={px(r.years) + 12} y={py(r.hourly) + 4}
              className={`text-[11px] font-semibold ${r.allLow ? 'fill-red-600' : 'fill-blue-600 dark:fill-blue-400'}`}>{r.name}</text>
          )}
          {/* 当たり判定を広めに取る。点が小さいと拾いにくいため */}
          <circle cx={px(r.years)} cy={py(r.hourly)} r={16} fill="transparent"
            className="cursor-pointer"
            onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)}
            onClick={() => setHover(r)} />
        </g>
      ))}
      {hover && <Tip r={hover} x={px(hover.years)} y={py(hover.hourly)} W={W} />}
    </svg>
  )
}

function CagrChart({ rows }: { rows: WageRow[] }) {
  const list = rows.filter(r => r.cagr !== null).sort((x, y) => y.cagr! - x.cagr!)
  if (!list.length) return <p className="text-sm text-gray-400">対象者がいません</p>
  const max = Math.max(...list.map(r => r.cagr!)) * 1.1
  return (
    <div className="space-y-1.5">
      {list.map(r => (
        <div key={r.id} className="flex items-center gap-2 text-xs">
          <span className="w-40 shrink-0 text-right text-gray-500 truncate">{r.name}</span>
          <span className="w-11 shrink-0 text-right text-gray-400">{r.years}年</span>
          <div className="flex-1 relative h-6">
            <div className={`absolute inset-y-1 left-0 rounded ${r.allLow ? 'bg-red-500' : r.allHigh ? 'bg-blue-600' : 'bg-gray-400'}`}
              style={{ width: `${(r.cagr! / max) * 100}%` }} />
            <div className="absolute inset-y-[9px] left-0 rounded-sm bg-gray-600/70 dark:bg-gray-300/50"
              style={{ width: `${((r.minWageCagr ?? 0) / max) * 100}%` }} />
          </div>
          <span className="w-32 shrink-0 tabular-nums text-gray-600 dark:text-gray-300">
            {r.cagr!.toFixed(2)}%
            <span className="text-gray-400"> 実質+{(r.realGain ?? 0).toFixed(1)}pt</span>
          </span>
          <span className="w-24 shrink-0 text-right tabular-nums text-gray-400">
            {yen(r.startWage)}→{yen(r.hourly)}
          </span>
        </div>
      ))}
    </div>
  )
}

function Matrix({ rows }: { rows: WageRow[] }) {
  const list = [...rows].sort((x, y) =>
    (x.devStage + x.devTrend + (x.devCohort ?? 0)) - (y.devStage + y.devTrend + (y.devCohort ?? 0)))
  const max = 260
  const Bar = ({ v }: { v: number | null }) => {
    if (v === null) return <div className="flex-1 text-center text-[10px] text-gray-400">同期なし</div>
    const w = Math.min(Math.abs(v) / max, 1) * 50
    return (
      <div className="flex-1 relative h-5">
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-200 dark:bg-gray-700" />
        <div className={`absolute inset-y-1 rounded-sm ${v < -20 ? 'bg-red-500' : v > 20 ? 'bg-blue-600' : 'bg-gray-400'}`}
          style={v < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
        <span className="absolute top-0 text-[10px] tabular-nums text-gray-500 whitespace-nowrap"
          style={v < 0
            ? { right: `calc(50% + ${w}%)`, paddingRight: 4 }
            : { left: `calc(50% + ${w}%)`, paddingLeft: 4 }}>{signed(v)}</span>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] text-gray-500 font-semibold mb-1">
        <span className="w-40 shrink-0" />
        <span className="flex-1 text-center">A 段階内平均</span>
        <span className="flex-1 text-center">B 全体傾向線</span>
        <span className="flex-1 text-center">C 同期</span>
      </div>
      <div className="space-y-1">
        {list.map(r => (
          <div key={r.id} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-right text-xs text-gray-500 truncate" title={`${r.years}年 ${yen(r.hourly)}`}>{r.name}</span>
            <Bar v={r.devStage} /><Bar v={r.devTrend} /><Bar v={r.devCohort} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StageTable({ a }: { a: WageAnalysis }) {
  const counts = [0, 1, 2, 3, 4].map(i => a.rows.filter(r => r.stage === i).length)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-800 text-white">
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-left">段階</th>
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1.5">在籍</th>
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1.5">人数</th>
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1.5">平均時給</th>
            <th className="border border-gray-300 dark:border-gray-600 px-2 py-1.5">前段階からの昇給</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((s, i) => {
            if (!counts[i]) return null
            const prev = [...Array(i).keys()].reverse().find(j => counts[j] > 0)
            const jump = prev !== undefined ? (a.stageAvg[i] / a.stageAvg[prev] - 1) * 100 : null
            return (
              <tr key={s.key}>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">{s.key}</td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-center text-gray-500">{s.years}</td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-center">{counts[i]}</td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums">{yen(a.stageAvg[i])}</td>
                <td className={`border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums font-semibold ${jump !== null && jump > 30 ? 'text-blue-600 dark:text-blue-400' : ''}`}>
                  {jump !== null ? `+${jump.toFixed(1)}%（${signed(a.stageAvg[i] - a.stageAvg[prev!])}）` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ModelTable({ a }: { a: WageAnalysis }) {
  const years = Array.from({ length: 11 }, (_, i) => i)
  const th = 'border border-gray-300 dark:border-gray-600 px-2 py-1.5'
  const td = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const max = modelWage(a.modelStart, 10)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-800 text-white">
            <th className={th}>在籍</th><th className={th}>時給</th><th className={th}>前年から</th>
            <th className={th}>月額換算(140h)</th><th className={th}>起点比</th>
            <th className={`${th} w-1/3`}>推移</th>
          </tr>
        </thead>
        <tbody>
          {years.map(n => {
            const v = modelWage(a.modelStart, n)
            const p = n ? modelWage(a.modelStart, n - 1) : null
            return (
              <tr key={n} className={n === 0 || n === 10 ? 'bg-blue-50 dark:bg-blue-900/20' : ''}>
                <td className={td}>{n}年</td>
                <td className={`${td} font-semibold`}>{yen(v)}</td>
                <td className={td}>{p ? '+' + yen(v - p) : '—'}</td>
                <td className={td}>{yen(v * 140)}</td>
                <td className={td}>{(v / a.modelStart).toFixed(2)}倍</td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">
                  <div className="h-3 rounded bg-blue-600 dark:bg-blue-500" style={{ width: `${(v / max) * 100}%` }} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ModelGap({ a }: { a: WageAnalysis }) {
  const list = [...a.rows].sort((x, y) => y.devModel - x.devModel)
  const max = Math.max(...list.map(r => Math.abs(r.devModel)), 1)
  return (
    <div className="space-y-1">
      {list.map(r => {
        const w = (Math.abs(r.devModel) / max) * 46
        const over = r.devModel > 40
        const under = r.devModel < -40
        return (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span className="w-40 shrink-0 text-right text-gray-500 truncate">{r.name}</span>
            <span className="w-11 shrink-0 text-right text-gray-400">{r.years}年</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">{yen(r.hourly)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-gray-400">{yen(r.model)}</span>
            <div className="flex-1 relative h-5">
              <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 dark:bg-gray-600" />
              <div className={`absolute inset-y-1 rounded-sm ${over ? 'bg-blue-600' : under ? 'bg-red-500' : 'bg-gray-400'}`}
                style={r.devModel < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
              <span className="absolute top-0 text-[10px] tabular-nums text-gray-500 whitespace-nowrap"
                style={r.devModel < 0 ? { right: `calc(50% + ${w}%)`, paddingRight: 4 } : { left: `calc(50% + ${w}%)`, paddingLeft: 4 }}>
                {signed(r.devModel)}
              </span>
            </div>
          </div>
        )
      })}
      <p className="text-[11px] text-gray-400 pt-2">
        左から 氏名／在籍／現在の時給／モデル時給／差。
        モデルより高い人は昇給を緩め、低い人は追いつかせることで、全体が年{(MODEL_RAISE_RATE * 100).toFixed(0)}％の軌道に乗る。
      </p>
    </div>
  )
}

function Reference({ a }: { a: WageAnalysis }) {
  const tokutei = a.rows.filter(r => r.visa.startsWith('特定'))
  const ng = tokutei.filter(r => r.hourly < a.tokuteiFloor)
  const nearest = [...tokutei].sort((x, y) => x.hourly - y.hourly)[0]
  const minRatePct = (KENSETSU_TOKUTEI.minAnnualRaiseMonthly / 140 / a.modelStart) * 100
  const th = 'border border-gray-300 dark:border-gray-600 px-2 py-1.5'
  const td = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-semibold mb-1">市場水準（月額）</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-800 text-white">
                <th className={`${th} text-left`}>区分</th><th className={th}>月額</th>
                <th className={th}>時給換算(140h)</th><th className={`${th} text-left`}>出典</th>
              </tr>
            </thead>
            <tbody>
              {MARKET_REFERENCE.map(m => (
                <tr key={m.label}>
                  <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">{m.label}</td>
                  <td className={td}>{yen(m.monthly)}</td>
                  <td className={td}>{yen(m.monthly / 140)}</td>
                  <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-gray-500">{m.note}</td>
                </tr>
              ))}
              <tr className="bg-blue-50 dark:bg-blue-900/20 font-semibold">
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">自社 平均</td>
                <td className={td}>{yen(a.overallAvg * 140)}</td>
                <td className={td}>{yen(a.overallAvg)}</td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-gray-500">在籍{a.rows.length}名</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs leading-relaxed">
        <div className="font-semibold mb-1">建設分野 特定技能1号の法令要件</div>
        <p className="text-gray-600 dark:text-gray-300">出典: {KENSETSU_TOKUTEI.source}</p>
        <ul className="mt-2 space-y-1.5 text-gray-700 dark:text-gray-200">
          <li>
            <b>① 報酬の下限</b>：所定内賃金 ÷ 月所定労働時間 ≧ 地域別最低賃金 × {KENSETSU_TOKUTEI.minWageMultiplier}
            <span className="block text-gray-500">
              東京都 {yen(a.currentMinWage)} × {KENSETSU_TOKUTEI.minWageMultiplier} = <b>{yen(a.tokuteiFloor)}／時</b>。
              {ng.length === 0
                ? <>特定技能{tokutei.length}名は<b className="text-green-700 dark:text-green-400">全員クリア</b>（最も近いのは {nearest?.name} {yen(nearest?.hourly ?? 0)}・下限比 {((nearest?.hourly ?? 0) / a.tokuteiFloor).toFixed(2)}倍）。</>
                : <b className="text-red-600"> {ng.map(r => r.name).join('・')} が下限割れ。要是正。</b>}
            </span>
          </li>
          <li>
            <b>② 定期昇給が必須</b>：年間の月額所定内賃金の上昇が {yen(KENSETSU_TOKUTEI.minAnnualRaiseMonthly)} 未満だと定期昇給と認められない
            <span className="block text-gray-500">
              時給換算で年 {yen(KENSETSU_TOKUTEI.minAnnualRaiseMonthly / 140)} 以上。起点 {yen(a.modelStart)} なら
              <b> 年{minRatePct.toFixed(2)}％が下限</b>。昇給スピードを落とす際も、これを下回らせない。
            </span>
          </li>
          <li>
            <b>③ 月給制が前提</b>：1号特定技能外国人への報酬は全て月給制であることが前提とされている
          </li>
        </ul>
      </div>
    </div>
  )
}

function AnomalyCheck({ a }: { a: WageAnalysis }) {
  const inv = findInversions(a.rows)
  const outliers = stageIQROutliers(a.rows)
  const tauPct = ((1 - inv.discordant / Math.max(1, inv.concordant + inv.discordant)) * 100)
  return (
    <div className="space-y-4">
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 text-xs leading-relaxed">
        在籍差0.3年超の全 {inv.concordant + inv.discordant} ペア中、逆転は
        <b> {inv.discordant} ペア</b>（順位一致率 {tauPct.toFixed(1)}%・Kendall τ = {inv.tau.toFixed(2)}）。
        {inv.tau >= 0.8
          ? ' τ が 0.8 以上なので、全体としては「長く働くほど高い」が保たれている。'
          : ' τ が 0.8 を下回っており、年功と時給の対応が崩れ始めている。'}
      </div>

      <div>
        <div className="text-xs font-semibold mb-1">逆転ペア（在籍が長いのに時給が低い）</div>
        {inv.pairs.length === 0 ? (
          <p className="text-xs text-gray-400">なし</p>
        ) : (
          <div className="space-y-1">
            {inv.pairs.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-56 shrink-0 text-right text-red-600 dark:text-red-400">
                  {p.senior.name}（{p.senior.years}年 {yen(p.senior.hourly)}）
                </span>
                <span className="text-gray-400">＜</span>
                <span className="w-56 shrink-0 text-blue-600 dark:text-blue-400">
                  {p.junior.name}（{p.junior.years}年 {yen(p.junior.hourly)}）
                </span>
                <span className="tabular-nums text-gray-500">差 {yen(p.gap)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-xs font-semibold mb-1">段階内の外れ値（IQR法・3名以上の段階のみ）</div>
        {outliers.length === 0 ? (
          <p className="text-xs text-gray-400">なし</p>
        ) : (
          <div className="space-y-1 text-xs">
            {outliers.map(o => (
              <div key={o.stage}>
                <span className="text-gray-500">{STAGES[o.stage].key}（Q1 {yen(o.q1)}〜Q3 {yen(o.q3)}）: </span>
                {o.high.map(r => (
                  <span key={r.id} className="text-blue-600 dark:text-blue-400 font-semibold mr-2">↑ {r.name} {yen(r.hourly)}</span>
                ))}
                {o.low.map(r => (
                  <span key={r.id} className="text-red-600 dark:text-red-400 font-semibold mr-2">↓ {r.name} {yen(r.hourly)}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DataTable({ a }: { a: WageAnalysis }) {
  const list = [...a.rows].sort((x, y) => y.hourly - x.hourly)
  const th = 'border border-gray-300 dark:border-gray-600 px-2 py-1.5'
  const td = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const cls = (v: number | null) => v === null ? '' : v < -a.threshold ? 'text-red-600 font-semibold' : v > a.threshold ? 'text-blue-600 dark:text-blue-400 font-semibold' : ''
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">データ</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-800 text-white">
              <th className={`${th} text-left`}>氏名</th>
              <th className={th}>在留資格</th><th className={th}>段階</th><th className={th}>入社</th>
              <th className={th}>在籍</th><th className={th}>起点</th><th className={th}>時給</th>
              <th className={th}>昇給率</th><th className={th}>実質</th>
              <th className={th}>A</th><th className={th}>B</th><th className={th}>C</th>
            </tr>
          </thead>
          <tbody>
            {list.map(r => (
              <tr key={r.id}>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">
                  {r.name}{r.stageException && <span className="text-amber-600 ml-1" title="在留資格と制度上の段階が一致しない">※</span>}
                </td>
                <td className={td}>{r.visa}</td>
                <td className={td}>{STAGES[r.stage].key}</td>
                <td className={td}>{r.hireDate ? r.hireDate.slice(0, 7) : '—'}</td>
                <td className={td}>{r.years}年</td>
                <td className={td}>{yen(r.startWage)}</td>
                <td className={td}>{yen(r.hourly)}</td>
                <td className={td}>{r.cagr !== null ? r.cagr.toFixed(2) + '%' : '—'}</td>
                <td className={td}>{r.realGain !== null ? '+' + r.realGain.toFixed(1) + 'pt' : '—'}</td>
                <td className={`${td} ${cls(r.devStage)}`}>{signed(r.devStage)}</td>
                <td className={`${td} ${cls(r.devTrend)}`}>{signed(r.devTrend)}</td>
                <td className={`${td} ${cls(r.devCohort)}`}>{r.devCohort !== null ? signed(r.devCohort) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-2">
        ※ 印＝在留資格と制度上の段階が一致しない人（試験不合格による早期移行など）。段階は在籍年数を優先。
      </p>
    </section>
  )
}

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
  buildWageAnalysis, STAGES, TOKYO_MIN_WAGE, type WageAnalysis, type WageRow,
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

      <Card title="① 在籍年数 × 時給" note="青の実線＝各段階の平均（この線より下が段階内で低い）。灰の破線＝全体平均。赤＝一貫して低い人、青＝一貫して高い人。">
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

function Scatter({ a }: { a: WageAnalysis }) {
  const rows = a.rows
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
          <circle cx={px(r.years)} cy={py(r.hourly)} r={r.allLow || r.allHigh ? 8 : 6}
            className={r.allLow ? 'fill-red-500' : r.allHigh ? 'fill-blue-600 dark:fill-blue-400' : 'fill-gray-400'}
            stroke="white" strokeWidth={1.5}>
            <title>{r.name}／{r.years}年／{yen(r.hourly)}</title>
          </circle>
          {(r.allLow || r.allHigh) && (
            <text x={px(r.years) + 12} y={py(r.hourly) + 4}
              className={`text-[11px] font-semibold ${r.allLow ? 'fill-red-600' : 'fill-blue-600 dark:fill-blue-400'}`}>{r.name}</text>
          )}
        </g>
      ))}
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

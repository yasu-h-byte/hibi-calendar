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

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  buildWageAnalysis, modelWage, findInversions, stageIQROutliers,
  STAGES, TOKYO_MIN_WAGE, MODEL_RAISE_RATE,
  MARKET_REFERENCE, KENSETSU_TOKUTEI,
  type WageAnalysis, type WageRow, type WageBasis,
} from '@/lib/wage-analysis'
import {
  curveWage, curveRaiseAt, CURVE_BASE_RAISE, CURVE_DECAY, CURVE_MIN_RAISE,
  WAGE_REVISION_2026_10, SCHEDULED_WAGE_CHANGES, MONTHLY_HOURS,
} from '@/lib/wage-curve'

const OWNER_ID = 0 // 日比靖仁

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const signed = (v: number) => (v >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString()

export default function WageAnalysisPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [rows, setRows] = useState<WageAnalysis | null>(null)
  const [err, setErr] = useState('')
  const [pw, setPw] = useState('')
  // 既定は「改定後」。10月以降どうなるかを見るのが今の主目的のため（2026-08-25 代表指示）
  const [basis, setBasis] = useState<WageBasis>('revised')

  const load = useCallback(async (password: string, b: WageBasis) => {
    {
      try {
        const res = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
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
        setRows(buildWageAnalysis(target, todayIso, 20, b))
      } catch (e) {
        setErr(e instanceof Error ? e.message : '不明なエラー')
      }
    }
  }, [])

  useEffect(() => {
    let password = ''
    try {
      const raw = localStorage.getItem('hibi_auth')
      const parsed = raw ? JSON.parse(raw) : null
      password = parsed?.password || ''
      if (parsed?.user?.workerId !== OWNER_ID) { setAllowed(false); return }
      setAllowed(true)
      setPw(password)
    } catch { setAllowed(false); return }
    load(password, basis)
  }, [load, basis])

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

  return (
    <Report
      a={rows}
      onApplied={() => load(pw, basis)}
      pw={pw}
      basis={basis}
      onBasis={setBasis}
    />
  )
}

function Report({ a, onApplied, pw, basis, onBasis }: {
  a: WageAnalysis; onApplied: () => void; pw: string
  basis: WageBasis; onBasis: (b: WageBasis) => void
}) {
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

        {/* 分析全体の基準を切り替える。①〜⑨とデータ表のすべてがこの基準で再計算される */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">集計の基準：</span>
          <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
            {([
              ['revised', '改定後（2026年10月以降）'],
              ['current', '現在の時給'],
            ] as [WageBasis, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => onBasis(k)}
                className={`text-xs px-3 py-1.5 transition ${basis === k
                  ? 'bg-hibi-navy text-white dark:bg-blue-700'
                  : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
          {basis === 'revised'
            ? <><b>9月21日の3号移行と10月1日の一律改定を反映した時給</b>で、①〜⑨とデータ表のすべてを計算しています。
              人員マスタはまだ書き換えていないので、当面の給与計算には使われません。</>
            : <><b>人員マスタの現在の時給</b>で計算しています。いま給与計算に使われている額です。</>}
        </p>
      </header>

      <RevisionBanner a={a} onApplied={onApplied} pw={pw} />
      <MinWageWatch a={a} />

      <section className="grid sm:grid-cols-2 gap-3">
        <Flag tone="low" title="3基準すべてで低い" items={lows} />
        <Flag tone="high" title="3基準すべてで高い" items={highs} />
      </section>

      <Card title="① 在籍年数 × 時給" note="緑の破線＝昇給カーブ（これが標準）。青の実線＝各段階の平均。灰の破線＝全体平均。赤＝一貫して低い人、青＝一貫して高い人。点にカーソルを合わせる（スマホはタップ）と氏名と内訳が出ます。">
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

      <Card title={`⑤ 昇給カーブ（昇給額 = ${CURVE_BASE_RAISE}円 − ${CURVE_DECAY}円 × 在籍年数）`}
        note={`2026-08 に年${(MODEL_RAISE_RATE * 100).toFixed(0)}％複利から切り替えた現行モデル。起点 ${yen(a.curveStart)}（東京都最低賃金 ${yen(a.currentMinWage)} の10円切上げ）。複利と違い上げ幅は年々小さくなる（1年目 +${yen(curveRaiseAt(0))} → 10年目 +${yen(curveRaiseAt(9))}、11年目以降は ${yen(CURVE_MIN_RAISE)} で下限）。若手が薄いという複利の弱点を直すのが目的。`}>
        <CurveChart a={a} />
        <CurveTable a={a} />
      </Card>

      <Card title="⑥ 在籍者とカーブの差"
        note="灰＝現在の時給とカーブの差／色つき＝2026年10月改定後の差。−＝カーブに届いていない（追いつかせる対象）、＋＝カーブより高い。">
        <CurveGap a={a} />
      </Card>

      <Card title="⑦ 賃金改定の影響"
        note={`事由の異なる改定を分けて表示している。一律改定の率（${((WAGE_REVISION_2026_10.rate ?? 0) * 100).toFixed(3)}％）はタンの要望額（月+2万円）から逆算したもの。月額は所定 ${MONTHLY_HOURS} 時間換算。`}>
        <RevisionTable a={a} />
      </Card>

      <Card title="⑧ 参考データ（外部・法令）"
        note="いずれも全国値。東京都は地域別最低賃金が全国最高のため、実勢はこれより高いとみて読むこと。">
        <Reference a={a} />
      </Card>

      <Card title="⑨ 逆転・外れ値チェック"
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
          ? items.map(r => (
            <div key={r.id}>
              {r.name}（{r.years}年 {yen(r.hourly)}）
              {r.context && (
                <span className="ml-1 text-[10px] font-normal px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {r.context.label}
                </span>
              )}
            </div>
          ))
          : <span className="text-gray-400 font-normal">該当なし</span>}
      </div>
      {items.some(r => r.context) && (
        <div className="text-[11px] text-gray-500 mt-2 space-y-1 leading-relaxed">
          {items.filter(r => r.context).map(r => (
            <p key={r.id}><b>{r.context!.label}</b>：{r.context!.detail}</p>
          ))}
        </div>
      )}
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
    `カーブとの差 ${signed(r.devCurve)}`,
    ...(r.revisionTarget ? [`10月改定後 ${yen(r.revised)}（${signed(r.devCurveRevised)}）`] : []),
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
  const x1 = Math.max(10.5, Math.ceil(Math.max(...rows.map(r => r.years)) + 0.7))
  // カーブも重ねるので、点だけでなくカーブの到達点も y 範囲に入れる
  const hs = [...rows.map(r => r.hourly), curveWage(a.curveStart, 0), curveWage(a.curveStart, x1)]
  const y0 = Math.floor((Math.min(...hs) - 120) / 100) * 100
  const y1 = Math.ceil((Math.max(...hs) + 120) / 100) * 100
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
      {/* 昇給カーブ。在籍者がカーブのどちら側にいるかを一目で見えるようにする */}
      <path
        d={Array.from({ length: Math.ceil(x1 * 4) + 1 }, (_, i) => {
          const yr = i / 4
          return `${i === 0 ? 'M' : 'L'}${px(yr).toFixed(1)},${py(curveWage(a.curveStart, yr)).toFixed(1)}`
        }).join(' ')}
        fill="none" stroke="currentColor" strokeWidth={2.2}
        className="text-emerald-600 dark:text-emerald-400" strokeDasharray="7 4" />
      <text x={px(x1) - 4} y={py(curveWage(a.curveStart, x1)) - 9} textAnchor="end"
        className="fill-emerald-600 dark:fill-emerald-400 text-[11px] font-semibold">昇給カーブ</text>
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

/**
 * 2026年10月 一律改定の実施状況。
 *
 * 人員マスタの時給が予定額に達したかどうかで「予定」「反映済み」を自動的に切り替える。
 * 実施後にこのバナーを消す作業が要らないようにしてある。
 */
/**
 * 予定を人員マスタへ反映するボタン付きのバナー。
 *
 * 書き込みは既存の `/api/workers`（action: 'update'）をそのまま使う。専用の書き込み経路を
 * 作らないのは、あの経路が `auditTrail`（労基法115条の3年証跡）と `activityLog` への
 * 記録を持っているため。ここで別経路を作ると証跡が残らない書き換えができてしまう。
 *
 * 日額 `rate` も一緒に更新する。給与計算自体は `hourlyRate × 7` から日額を導くので
 * `rate` は使われないが、人員マスタの表示が古い日額のまま残ると混乱するため揃える。
 */
function RevisionBanner({ a, onApplied, pw }: { a: WageAnalysis; onApplied: () => void; pw: string }) {
  const { changes, pending, annualCost } = a.revision
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [applyErr, setApplyErr] = useState('')
  const todayIso = a.todayIso

  /** その改定で実際に上がる人（すでに予定額以上なら対象外） */
  const pendingRows = (changeId: string) => {
    const c = SCHEDULED_WAGE_CHANGES.find(x => x.id === changeId)
    if (!c) return []
    // basis が 'revised' でも「まだ書き換わっていない人」を正しく拾うため currentHourly で判定
    return a.rows
      .filter(r => c.targets[r.id] !== undefined && r.currentHourly < c.targets[r.id])
      .map(r => ({ row: r, to: c.targets[r.id] }))
  }

  const apply = async (changeId: string) => {
    const list = pendingRows(changeId)
    if (!list.length) return
    setBusy(changeId); setApplyErr('')
    try {
      for (const { row, to } of list) {
        const res = await fetch('/api/workers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
          body: JSON.stringify({
            action: 'update', id: row.id,
            hourlyRate: to,
            rate: to * 7, // 所定7時間。日額表示を時給と揃える
          }),
        })
        if (!res.ok) throw new Error(`${row.name} の更新に失敗しました（${res.status}）`)
      }
      setConfirming(null)
      onApplied()
    } catch (e) {
      setApplyErr(e instanceof Error ? e.message : '反映に失敗しました')
    } finally {
      setBusy('')
    }
  }

  if (!changes.length) return null
  const done = pending === 0
  const box = done
    ? 'border-l-4 border-l-green-500 bg-green-50 dark:bg-green-900/20'
    : 'border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-900/20'
  return (
    <section className={`rounded-lg p-3 ${box}`}>
      <div className="text-sm font-semibold mb-2">予定されている賃金改定</div>
      <div className="space-y-1.5">
        {changes.map(c => (
          <div key={c.id} className="text-xs leading-relaxed">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="tabular-nums text-gray-500">{c.effective}</span>
              <span className="font-semibold">{c.label}</span>
              <span className="text-gray-500">
                {c.rate ? `一律 ${(c.rate * 100).toFixed(3)}％・` : ''}{c.count}名
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${c.pending === 0
                ? 'bg-green-100 text-green-800 dark:bg-green-800/40 dark:text-green-200'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-800/40 dark:text-amber-200'}`}>
                {c.pending === 0 ? '反映済み' : `未反映 ${c.pending}名`}
              </span>
              <span className="text-gray-500 tabular-nums">年 +{yen(c.annualCost)}</span>
              {c.pending > 0 && (
                c.effective <= todayIso ? (
                  <button
                    onClick={() => { setConfirming(c.id); setApplyErr('') }}
                    disabled={busy !== ''}
                    className="text-[11px] px-2 py-0.5 rounded border border-hibi-navy text-hibi-navy hover:bg-hibi-navy hover:text-white transition disabled:opacity-50 dark:border-blue-400 dark:text-blue-300"
                  >
                    人員マスタへ反映
                  </button>
                ) : (
                  <span className="text-[11px] text-gray-400">実施日になると反映ボタンが出ます</span>
                )
              )}
            </div>
            <div className="text-gray-500 pl-1">{c.reason}</div>

            {confirming === c.id && (
              <div className="mt-2 ml-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-3">
                <div className="font-semibold mb-1.5">この内容で人員マスタを書き換えます</div>
                <div className="space-y-0.5 mb-2">
                  {pendingRows(c.id).map(({ row, to }) => (
                    <div key={row.id} className="tabular-nums">
                      {row.name}　{yen(row.currentHourly)} → <b>{yen(to)}</b>
                      <span className="text-gray-500">（日額 {yen(row.currentHourly * 7)} → {yen(to * 7)}）</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
                  変更は監査証跡（auditTrail）に記録され、取り消しはできません。
                  当月の給与計算はこの新しい時給で行われます。
                  {c.effective.slice(-2) !== '01' && (
                    <> この改定は月の途中（{c.effective}）が実施日です。
                      システムは月内で時給を切り替えられないため、
                      <b>実施月は全日がこの新しい時給で計算されます</b>。</>
                  )}
                </p>
                {applyErr && <p className="text-[11px] text-red-600 mb-2">{applyErr}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => apply(c.id)}
                    disabled={busy !== ''}
                    className="text-xs px-3 py-1 rounded bg-hibi-navy text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy === c.id ? '反映中…' : '反映する'}
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    disabled={busy !== ''}
                    className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    やめる
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 pt-2 border-t border-gray-300/60 dark:border-gray-600/60 leading-relaxed">
        {done
          ? 'すべて人員マスタに反映済み。以下の分析は反映後の時給で計算しています。'
          : a.basis === 'revised'
            ? <><b>以下の分析は改定後の時給で計算しています</b>（上の「集計の基準」で切り替えられます）。
              人員マスタはまだ現在の額のままなので、給与計算には反映されていません。</>
            : <><b>以下の分析は現在の時給で計算しています</b>（⑥⑦とデータ表のみ改定後を併記）。
              上の「集計の基準」を切り替えると、改定後の姿で全体を見られます。</>}
        {' '}合計の年間人件費増は <b>{yen(annualCost)}</b>（所定 {MONTHLY_HOURS} 時間 × 12か月換算）。
      </p>
    </section>
  )
}

/**
 * 最低賃金まわりの監視。
 *
 * 東京都最賃は毎年10月に改定される。新規入社の時給は最賃に近いところに置かれるため、
 * 改定のたびに「法令割れ」が起きうる。改定額が公表される前に気付けるよう、
 * 直近の改定率で同じだけ上がった場合を仮に置いて余裕を測る。
 */
function MinWageWatch({ a }: { a: WageAnalysis }) {
  const mw = a.currentMinWage
  // 直近の改定率（据置きの年は除く）
  const hist = TOKYO_MIN_WAGE
  let lastRate = 0
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i].yen > hist[i - 1].yen) { lastRate = hist[i].yen / hist[i - 1].yen - 1; break }
  }
  const projected = Math.round(mw * (1 + lastRate))

  // 現時点で最賃を下回っている人（あってはならない）
  const under = a.rows.filter(r => r.currentHourly < mw)
  // 次の改定で下回りうる人
  const atRisk = a.rows.filter(r => r.currentHourly >= mw && r.revised < projected)
  // 特定技能1号の報酬下限（最賃×1.1）
  const tokuteiNg = a.rows.filter(r => r.visa.startsWith('特定') && r.revised < a.tokuteiFloor)

  if (!under.length && !atRisk.length && !tokuteiNg.length) return null

  const tone = under.length || tokuteiNg.length
    ? 'border-l-4 border-l-red-500 bg-red-50 dark:bg-red-900/20'
    : 'border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-900/20'

  return (
    <section className={`rounded-lg p-3 ${tone}`}>
      <div className="text-sm font-semibold">最低賃金の確認</div>
      <div className="text-xs text-gray-600 dark:text-gray-300 mt-1.5 space-y-1.5 leading-relaxed">
        {under.length > 0 && (
          <p className="text-red-700 dark:text-red-300">
            <b>現行の最低賃金 {yen(mw)} を下回っています（法令違反）</b>：
            {under.map(r => `${r.name} ${yen(r.currentHourly)}`).join('／')}
          </p>
        )}
        {tokuteiNg.length > 0 && (
          <p className="text-red-700 dark:text-red-300">
            <b>特定技能1号の報酬下限 {yen(a.tokuteiFloor)}（最賃×1.1）を下回っています</b>：
            {tokuteiNg.map(r => `${r.name} ${yen(r.revised)}`).join('／')}
          </p>
        )}
        {atRisk.length > 0 && (
          <p>
            <b>2026年10月の最賃改定で下回る可能性があります。</b>
            直近の改定率 {(lastRate * 100).toFixed(1)}％（{yen(hist[hist.length - 2].yen)} → {yen(mw)}）が
            もう一度あると最賃は <b>{yen(projected)}</b> になります。これを下回るのは
            {atRisk.map(r => `${r.name} ${yen(r.revised)}`).join('／')}。
            <b>方針は「下回るなら速やかに上回るよう改定する」</b>（2026-08 代表確認）。
            改定額が公示されたら <code>lib/wage-analysis.ts</code> の <code>TOKYO_MIN_WAGE</code> に追記すれば、
            ここが自動で「下回っている」の判定に切り替わります。
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * 昇給カーブのグラフ。
 *
 * 表（CurveTable）だけだと「毎年いくら上がるか」は読めても
 * **カーブの形**（前厚で後ろが寝る）と、在籍者がその線のどちら側にいるかが見えない。
 * 上段に時給の推移、下段に昇給額の逓減を並べて、両方を1枚で見えるようにする。
 */
function CurveChart({ a }: { a: WageAnalysis }) {
  const YEARS = 15
  const W = 900, H = 400, ML = 74, MR = 96, MT = 16, MB = 112
  const PW = W - ML - MR, PH = H - MT - MB

  const curveAt = (y: number) => curveWage(a.curveStart, y)
  const oldAt = (y: number) => modelWage(a.curveStart, y)
  const floor = a.tokuteiFloor

  const y0 = Math.floor((Math.min(a.curveStart, floor) - 150) / 100) * 100
  const y1 = Math.ceil((Math.max(curveAt(YEARS), oldAt(YEARS)) + 120) / 100) * 100
  const px = (v: number) => ML + (v / YEARS) * PW
  const py = (v: number) => MT + ((y1 - v) / (y1 - y0)) * PH

  const line = (f: (y: number) => number) =>
    Array.from({ length: YEARS * 4 + 1 }, (_, i) => {
      const yr = i / 4
      return `${i === 0 ? 'M' : 'L'}${px(yr).toFixed(1)},${py(f(yr)).toFixed(1)}`
    }).join(' ')

  const ticks: number[] = []
  for (let t = y0; t <= y1; t += 200) ticks.push(t)

  // 制度上の節目。ここで在留資格が変わる
  const MILESTONES = [
    { y: 3, label: '実習3号へ' },
    { y: 5, label: '特定技能へ' },
    { y: 10, label: '10年' },
  ]

  // 下段（昇給額の逓減）
  const BH = 46, BT = MT + PH + 46
  const maxRaise = curveRaiseAt(0)

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[560px]" role="img"
        aria-label="昇給カーブ（時給の推移と昇給額の逓減）">
        {/* 横グリッド */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={ML} y1={py(t)} x2={ML + PW} y2={py(t)} stroke="currentColor"
              className="text-gray-200 dark:text-gray-700" strokeWidth={1} />
            <text x={ML - 8} y={py(t) + 4} textAnchor="end" className="fill-gray-400 text-[11px]">{yen(t)}</text>
          </g>
        ))}

        {/* 節目の縦線 */}
        {MILESTONES.map(m => (
          <g key={m.y}>
            <line x1={px(m.y)} y1={MT} x2={px(m.y)} y2={MT + PH} stroke="currentColor"
              className="text-gray-300 dark:text-gray-600" strokeWidth={1} strokeDasharray="3 4" />
            <text x={px(m.y)} y={MT - 4} textAnchor="middle" className="fill-gray-400 text-[10px]">{m.label}</text>
          </g>
        ))}

        {/* 特定技能1号の報酬下限（最賃×1.1）。法令の余裕が見える */}
        <line x1={ML} y1={py(floor)} x2={ML + PW} y2={py(floor)} stroke="currentColor"
          className="text-amber-500" strokeWidth={1.5} strokeDasharray="8 4" />
        <text x={ML + PW + 6} y={py(floor) + 4} className="fill-amber-600 dark:fill-amber-400 text-[10px]">
          特定技能下限
        </text>

        {/* 旧7%複利（比較） */}
        <path d={line(oldAt)} fill="none" stroke="currentColor" strokeWidth={1.8}
          className="text-gray-400" strokeDasharray="5 5" />
        <text x={ML + PW + 6} y={py(oldAt(YEARS)) + 4} className="fill-gray-400 text-[10px]">旧7%複利</text>

        {/* 現行カーブ */}
        <path d={line(curveAt)} fill="none" stroke="currentColor" strokeWidth={3}
          className="text-emerald-600 dark:text-emerald-400" />
        <text x={ML + PW + 6} y={py(curveAt(YEARS)) + 4}
          className="fill-emerald-600 dark:fill-emerald-400 text-[11px] font-semibold">カーブ</text>

        {/* 整数年の点＋節目の金額 */}
        {Array.from({ length: YEARS + 1 }, (_, i) => i).map(i => (
          <g key={i}>
            <circle cx={px(i)} cy={py(curveAt(i))} r={3}
              className="fill-emerald-600 dark:fill-emerald-400" />
            {(i === 0 || i === 3 || i === 5 || i === 10 || i === 15) && (
              <text x={px(i)} y={py(curveAt(i)) - 10} textAnchor="middle"
                className="fill-emerald-700 dark:fill-emerald-300 text-[10px] font-semibold">{yen(curveAt(i))}</text>
            )}
          </g>
        ))}

        {/* 在籍者を重ねる。カーブのどちら側にいるかが一目で分かる */}
        {a.rows.filter(r => r.years <= YEARS).map(r => (
          <circle key={r.id} cx={px(r.years)} cy={py(r.hourly)} r={4.5}
            className={r.devCurve < -20 ? 'fill-red-500' : r.devCurve > 20 ? 'fill-blue-600 dark:fill-blue-400' : 'fill-gray-400'}
            stroke="white" strokeWidth={1.2}>
            <title>{`${r.name}（${r.years}年 ${yen(r.hourly)}・カーブとの差 ${signed(r.devCurve)}）`}</title>
          </circle>
        ))}

        {/* X軸ラベル */}
        {Array.from({ length: YEARS + 1 }, (_, i) => i).filter(i => i % 5 === 0 || i === 3).map(i => (
          <text key={i} x={px(i)} y={MT + PH + 18} textAnchor="middle" className="fill-gray-400 text-[11px]">{i}年</text>
        ))}

        {/* 下段: 昇給額の逓減 */}
        <text x={ML - 8} y={BT + 12} textAnchor="end" className="fill-gray-400 text-[11px]">昇給額</text>
        {Array.from({ length: YEARS }, (_, i) => i).map(i => {
          const v = curveRaiseAt(i)
          const bw = (PW / YEARS) * 0.62
          const bh = (v / maxRaise) * BH
          return (
            <g key={i}>
              <rect x={px(i + 0.5) - bw / 2} y={BT + (BH - bh)} width={bw} height={bh} rx={2}
                className={v === CURVE_MIN_RAISE ? 'fill-emerald-300 dark:fill-emerald-800' : 'fill-emerald-500 dark:fill-emerald-600'}>
                <title>{`${i}年目→${i + 1}年目: +${yen(v)}`}</title>
              </rect>
              {(i === 0 || i === 4 || i === 9 || i === 14) && (
                <text x={px(i + 0.5)} y={BT + BH + 13} textAnchor="middle" className="fill-gray-500 text-[10px]">+{v}</text>
              )}
            </g>
          )
        })}
      </svg>
      <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
        上＝時給の推移（緑の点は各年の到達額）。下＝その年の昇給額。
        {CURVE_BASE_RAISE}円から毎年{CURVE_DECAY}円ずつ減り、11年目以降は{CURVE_MIN_RAISE}円で止まる（薄い緑）。
        丸は現在の在籍者で、赤＝カーブを下回る／青＝上回る。
        旧7%複利は{(() => {
          let k = 0
          for (let i = 1; i <= YEARS; i++) if (oldAt(i) > curveAt(i)) { k = i; break }
          return k ? `${k}年目` : '後半'
        })()}以降でカーブを追い越す（＝ベテランに厚く、若手に薄い）。
      </p>
    </div>
  )
}

/** 昇給カーブの年次表。旧7%複利を隣に置いて、どこで差がつくかを見えるようにする。 */
function CurveTable({ a }: { a: WageAnalysis }) {
  const years = Array.from({ length: 16 }, (_, i) => i)
  const th = 'border border-gray-300 dark:border-gray-600 px-2 py-1.5'
  const td = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const max = curveWage(a.curveStart, 15)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-800 text-white">
            <th className={th}>在籍</th><th className={th}>昇給額</th><th className={th}>時給</th>
            <th className={th}>月額({MONTHLY_HOURS}h)</th><th className={th}>起点比</th>
            <th className={th}>旧7%複利</th>
            <th className={`${th} w-1/4`}>推移</th>
          </tr>
        </thead>
        <tbody>
          {years.map(n => {
            const v = curveWage(a.curveStart, n)
            const old = modelWage(a.curveStart, n)
            const mark = n === 0 || n === 3 || n === 5 || n === 10
            return (
              <tr key={n} className={mark ? 'bg-blue-50 dark:bg-blue-900/20' : ''}>
                <td className={td}>{n}年</td>
                <td className={td}>{n ? '+' + yen(curveRaiseAt(n - 1)) : '—'}</td>
                <td className={`${td} font-semibold`}>{yen(v)}</td>
                <td className={td}>{yen(v * MONTHLY_HOURS)}</td>
                <td className={td}>{(v / a.curveStart).toFixed(2)}倍</td>
                <td className={`${td} text-gray-400`}>{yen(old)}<span className="ml-1 text-[10px]">{signed(v - old)}</span></td>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">
                  <div className="h-3 rounded bg-blue-600 dark:bg-blue-500" style={{ width: `${(v / max) * 100}%` }} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-gray-400 pt-2 leading-relaxed">
        青帯は制度上の節目（入社／実習3号へ／特定技能へ／10年）。
        複利より若手が厚く、6年目以降は薄くなる。ベテランの処遇は賃金カーブではなく
        役割手当（職長・班長手当、特定技能2号の処遇、賞与）で対応する方針。
      </p>
      {a.entryWage !== null && a.entryWage !== a.curveStart && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 pt-1.5 leading-relaxed">
          実際の新規入社時給は {yen(a.entryWage)} で、カーブの起点 {yen(a.curveStart)} より
          {signed(a.entryWage - a.curveStart)}。入社時点ですでにカーブより
          {a.entryWage > a.curveStart ? '上' : '下'}にいるため、
          新入社者の「カーブとの差」は{a.entryWage > a.curveStart ? 'プラス' : 'マイナス'}に出ます。
        </p>
      )}
    </div>
  )
}

/** 在籍者とカーブの差。現行（灰）と改定後（色）を同じ行に重ねて、改定でどれだけ縮むかを見る。 */
function CurveGap({ a }: { a: WageAnalysis }) {
  const list = [...a.rows].sort((x, y) => y.devCurveRevised - x.devCurveRevised)
  // 薄い帯＝改定前の位置。basis を切り替えても「どこから動いたか」が消えないよう
  // r.devCurve（basis 依存）ではなく現在値との差を使う
  const devBefore = (r: WageRow) => r.currentHourly - r.curve
  const max = Math.max(...list.map(r => Math.max(Math.abs(devBefore(r)), Math.abs(r.devCurveRevised))), 1)
  return (
    <div className="space-y-1">
      {list.map(r => {
        const wNow = (Math.abs(devBefore(r)) / max) * 46
        const wRev = (Math.abs(r.devCurveRevised) / max) * 46
        const over = r.devCurveRevised > 40
        const under = r.devCurveRevised < -40
        const pos = (v: number, w: number) => v < 0
          ? { right: '50%', width: `${w}%` }
          : { left: '50%', width: `${w}%` }
        return (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span className="w-40 shrink-0 text-right text-gray-500 truncate">
              {r.name}{r.revisionTarget && <span className="text-amber-600 ml-1" title="2026年10月改定の対象">★</span>}
            </span>
            <span className="w-11 shrink-0 text-right text-gray-400">{r.years}年</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">{yen(r.revised)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-gray-400">{yen(r.curve)}</span>
            <div className="flex-1 relative h-5">
              <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 dark:bg-gray-600" />
              {/* 現行（改定前）の位置。改定対象だけ薄い灰で残す */}
              {r.revisionGain > 0 && (
                <div className="absolute inset-y-0 rounded-sm bg-gray-300 dark:bg-gray-600"
                  style={pos(devBefore(r), wNow)} />
              )}
              <div className={`absolute inset-y-1 rounded-sm ${over ? 'bg-blue-600' : under ? 'bg-red-500' : 'bg-gray-400'}`}
                style={pos(r.devCurveRevised, wRev)} />
              <span className="absolute top-0 text-[10px] tabular-nums text-gray-500 whitespace-nowrap"
                style={r.devCurveRevised < 0
                  ? { right: `calc(50% + ${wRev}%)`, paddingRight: 4 }
                  : { left: `calc(50% + ${wRev}%)`, paddingLeft: 4 }}>
                {signed(r.devCurveRevised)}
              </span>
            </div>
          </div>
        )
      })}
      <p className="text-[11px] text-gray-400 pt-2 leading-relaxed">
        左から 氏名／在籍／時給（★は改定後）／カーブ上の時給／差。
        薄い灰の帯は改定前の位置なので、帯が縮んだ分だけカーブに近づいたことになる。
      </p>
    </div>
  )
}

/** 賃金改定の明細。事由ごとに表を分け、前後比較と積み残しを示す。 */
function RevisionTable({ a }: { a: WageAnalysis }) {
  const th = 'border border-gray-300 dark:border-gray-600 px-2 py-1.5'
  const td = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const tl = 'border border-gray-200 dark:border-gray-700 px-2 py-1.5'

  // 改定してもなおカーブに届かない人
  const stillUnder = a.rows.filter(r => r.revisionTarget && r.devCurveRevised < -20)
  // 対象外なのにカーブを下回る人（今回の見直しから漏れていないかの確認）
  const outsideUnder = a.rows.filter(r => !r.revisionTarget && r.devCurve < -20)

  return (
    <div className="space-y-5">
      {a.revision.changes.map(c => {
        const change = SCHEDULED_WAGE_CHANGES.find(x => x.id === c.id)!
        // この改定の直前に確定している額（先行する改定があればその額）
        // 「改定前」は basis に左右されないよう、常にマスタの現在値から積む
        const priorOf = (id: number, current: number) => SCHEDULED_WAGE_CHANGES
          .slice(0, SCHEDULED_WAGE_CHANGES.indexOf(change))
          .reduce((v, p) => Math.max(v, p.targets[id] ?? 0), current)
        const list = a.rows
          .filter(r => change.targets[r.id] !== undefined)
          .sort((x, y) => (change.targets[y.id]) - (change.targets[x.id]))
        if (!list.length) return null
        const sum = (f: (r: WageRow) => number) => list.reduce((s, r) => s + f(r), 0)
        const gainOf = (r: WageRow) => change.targets[r.id] - priorOf(r.id, r.currentHourly)
        return (
          <div key={c.id}>
            <div className="text-xs font-semibold mb-1">
              {c.effective}　{c.label}
              {c.rate ? `（一律 ${(c.rate * 100).toFixed(3)}％）` : ''}・{list.length}名
            </div>
            <p className="text-[11px] text-gray-500 mb-1.5 leading-relaxed">{c.reason}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-800 text-white">
                    <th className={`${th} text-left`}>氏名</th><th className={`${th} text-left`}>在留資格</th>
                    <th className={th}>在籍</th><th className={th}>改定前</th><th className={th}>改定後</th>
                    <th className={th}>時給増</th><th className={th}>月額増</th>
                    <th className={th}>改定後月額</th><th className={th}>カーブとの差</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(r => {
                    const before = priorOf(r.id, r.currentHourly)
                    const after = change.targets[r.id]
                    return (
                      <tr key={r.id}>
                        <td className={tl}>{r.name}</td>
                        <td className={`${tl} text-gray-500`}>{r.visa}</td>
                        <td className={td}>{r.years}年</td>
                        <td className={`${td} text-gray-500`}>{yen(before)}</td>
                        <td className={`${td} font-semibold`}>{yen(after)}</td>
                        <td className={td}>+{yen(after - before)}</td>
                        <td className={td}>+{yen((after - before) * MONTHLY_HOURS)}</td>
                        <td className={td}>{yen(after * MONTHLY_HOURS)}</td>
                        <td className={`${td} ${after - r.curve < -20 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
                          {signed(after - r.curve)}
                          <span className="ml-1 text-[10px] text-gray-400">（改定前 {signed(before - r.curve)}）</span>
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-blue-50 dark:bg-blue-900/20 font-semibold">
                    <td className={tl} colSpan={3}>合計 {list.length}名</td>
                    <td className={td}>—</td><td className={td}>—</td>
                    <td className={td}>+{yen(sum(gainOf))}</td>
                    <td className={td}>+{yen(sum(r => gainOf(r) * MONTHLY_HOURS))}</td>
                    <td className={td}>{yen(sum(r => change.targets[r.id] * MONTHLY_HOURS))}</td>
                    <td className={`${td} text-gray-500`}>年 +{yen(c.annualCost)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="text-xs space-y-2 leading-relaxed">
        {stillUnder.length > 0 && (
          <div className="rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 border-l-4 border-l-gray-400">
            <div className="font-semibold mb-1">改定後もカーブに届かない人</div>
            <p className="text-gray-600 dark:text-gray-300">
              {stillUnder.map(r => `${r.name} ${signed(r.devCurveRevised)}`).join('／')}。
              一律の率での引き上げも、契約どおりの改定も、カーブとの差は縮むが揃いはしない。
              揃えるには個別に額で合わせる必要があり、それは評価（/evaluation）の議論になる。
              ラン コン ラップの差は言語面・出勤状況による評価差の反映として意図的に残しているもの。
            </p>
          </div>
        )}
        {outsideUnder.length > 0 && (
          <div className="rounded-lg p-3 bg-amber-50 dark:bg-amber-900/20 border-l-4 border-l-amber-500">
            <div className="font-semibold mb-1">今回の対象外だが、カーブを下回っている人</div>
            <div className="text-gray-600 dark:text-gray-300 space-y-1.5">
              {outsideUnder.map(r => (
                <p key={r.id}>
                  <b>{r.name}</b>（{r.years}年 {yen(r.hourly)}・{signed(r.devCurve)}）
                  {r.context ? `── ${r.context.detail}` : '── コロナ期より前の入社のため今回の一律改定には含めていないが、カーブとの差だけを見れば対象者と同じ状態にある。次の契約更新時の検討材料。'}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Reference({ a }: { a: WageAnalysis }) {
  const tokutei = a.rows.filter(r => r.visa.startsWith('特定'))
  const ng = tokutei.filter(r => r.hourly < a.tokuteiFloor)
  const nearest = [...tokutei].sort((x, y) => x.hourly - y.hourly)[0]
  const minRatePct = (KENSETSU_TOKUTEI.minAnnualRaiseMonthly / MONTHLY_HOURS / a.curveStart) * 100
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
              時給換算で年 {yen(KENSETSU_TOKUTEI.minAnnualRaiseMonthly / MONTHLY_HOURS)} 以上。起点 {yen(a.curveStart)} なら
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
  // 改定後にも同じ検査をかけ、一律改定で逆転が増減するかを見る
  const invRev = findInversions(a.rows.map(r => ({ ...r, hourly: r.revised })))
  const revChanged = a.rows.some(r => r.revisionGain > 0)
  return (
    <div className="space-y-4">
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 text-xs leading-relaxed">
        在籍差0.3年超の全 {inv.concordant + inv.discordant} ペア中、逆転は
        <b> {inv.discordant} ペア</b>（順位一致率 {tauPct.toFixed(1)}%・Kendall τ = {inv.tau.toFixed(2)}）。
        {inv.tau >= 0.8
          ? ' τ が 0.8 以上なので、全体としては「長く働くほど高い」が保たれている。'
          : ' τ が 0.8 を下回っており、年功と時給の対応が崩れ始めている。'}
        {revChanged && (
          <div className="mt-1.5 text-gray-500">
            2026年10月改定後は逆転 <b>{invRev.discordant} ペア</b>（τ = {invRev.tau.toFixed(2)}）。
            {invRev.discordant === inv.discordant
              ? '一律の率で上げているため順序は入れ替わらず、既存の逆転は解消も悪化もしない。解消するには個別に額で調整する必要がある。'
              : invRev.discordant < inv.discordant
                ? '改定によって逆転が減る。'
                : '改定によって逆転が増える。対象の選び方を見直す余地がある。'}
          </div>
        )}
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
                  {p.senior.name}{p.senior.context && <span className="text-gray-500" title={p.senior.context.detail}>（{p.senior.context.label}）</span>}
                  （{p.senior.years}年 {yen(p.senior.hourly)}）
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
              <th className={th}>{a.basis === 'revised' ? '現在（マスタ）' : '改定後'}</th>
              <th className={th}>カーブ</th><th className={th}>差</th>
              <th className={th}>昇給率</th><th className={th}>実質</th>
              <th className={th}>A</th><th className={th}>B</th><th className={th}>C</th>
            </tr>
          </thead>
          <tbody>
            {list.map(r => (
              <tr key={r.id}>
                <td className="border border-gray-200 dark:border-gray-700 px-2 py-1.5">
                  {r.name}
                  {r.stageException && <span className="text-amber-600 ml-1" title="在留資格と制度上の段階が一致しない">※</span>}
                  {r.context && <span className="text-gray-500 ml-1" title={r.context.detail}>（{r.context.label}）</span>}
                </td>
                <td className={td}>{r.visa}</td>
                <td className={td}>{STAGES[r.stage].key}</td>
                <td className={td}>{r.hireDate ? r.hireDate.slice(0, 7) : '—'}</td>
                <td className={td}>{r.years}年</td>
                <td className={td}>{yen(r.startWage)}</td>
                <td className={td}>{yen(r.hourly)}</td>
                <td className={`${td} ${r.revisionGain > 0 ? '' : 'text-gray-400'}`}>
                  {r.revisionGain > 0
                    ? (a.basis === 'revised' ? yen(r.currentHourly) : yen(r.revised))
                    : '—'}
                </td>
                <td className={`${td} text-gray-400`}>{yen(r.curve)}</td>
                <td className={`${td} ${cls(r.devCurve)}`}>{signed(r.devCurve)}</td>
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
        ※ 印＝在留資格と制度上の段階が一致しない人（試験不合格による早期移行など）。段階は在籍年数を優先。<br />
        {a.basis === 'revised'
          ? '「時給」は改定後の額。「現在（マスタ）」は人員マスタの現在値で、まだ書き換えていないため給与計算はこちらで動いている。'
          : '「時給」は人員マスタの現在値。「改定後」は予定を織り込んだ額（対象外は「—」）。'}
        「差」は「時給」とカーブ上の時給の差。
      </p>
    </section>
  )
}

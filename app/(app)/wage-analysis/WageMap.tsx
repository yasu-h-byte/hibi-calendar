'use client'

/**
 * 賃金分析 ① 賃金カーブ上の全員の位置（2026-09-14 page.tsx から分離）。
 * 静的プレビューで描画確認できるよう、ページ本体（代表ログイン必須）から切り出している。
 */
import { useState } from 'react'
import { STAGES, TOKYO_MIN_WAGE, KENSETSU_TOKUTEI, type WageAnalysis, type WageRow } from '@/lib/wage-analysis'
import { curveWage } from '@/lib/wage-curve'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const signed = (v: number) => (v >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString()

/** 散布図のツールチップ。SVG内に描くので最後にレンダリングして最前面にする。 */
function Tip({ r, x, y, W }: { r: WageRow; x: number; y: number; W: number }) {
  const lines = [
    `${r.years}年 ／ 在留資格 ${STAGES[r.visaStage >= 0 ? r.visaStage : r.stage].key}`,
    ...(r.stageException ? [`（在籍年数では${STAGES[r.stage].key}の段階）`] : []),
    `時給 ${yen(r.hourly)}（月額 ${yen(r.hourly * 140)}）`,
    `段階内平均との差 ${signed(r.devStage)}`,
    r.devCohort !== null ? `同期との差 ${signed(r.devCohort)}` : '同期なし',
    `カーブとの差 ${signed(r.devCurve)}`,
    ...(r.revised !== r.currentHourly ? [`今日 ${yen(r.currentHourly)} → 改定後 ${yen(r.revised)}`, `改定後のカーブとの差 ${signed(r.devCurveRevised)}`] : []),
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

/** 在留資格ごとの色（段階 index = STAGES の添字） */
const STAGE_FILL = ['fill-sky-400', 'fill-teal-500', 'fill-violet-500', 'fill-amber-500', 'fill-rose-600']

/**
 * 氏名の表示用の呼び名（名＝最後の語）。同じ呼び名が複数いる人だけミドルネームを付ける。
 * 例: グエン ヴァン タン と チュオン ドゥック タン → 「ヴァン タン」「ドゥック タン」
 */
function callNames(names: { id: number; name: string }[]): Map<number, string> {
  const last = (n: string) => n.split(/\s+/).filter(Boolean).slice(-1)[0] || n
  const count = new Map<string, number>()
  for (const x of names) count.set(last(x.name), (count.get(last(x.name)) || 0) + 1)
  return new Map(names.map(x => {
    const parts = x.name.split(/\s+/).filter(Boolean)
    const l = last(x.name)
    return [x.id, (count.get(l) || 0) > 1 && parts.length >= 2 ? parts.slice(-2).join(' ') : l]
  }))
}

/** 文字列の描画幅の目安（10.5px のフォント） */
function textW(t: string): number {
  let w = 0
  for (const ch of t) w += /[0-9,¥+\-−.\s]/.test(ch) ? 6.2 : 10.5
  return w
}

/**
 * 賃金カーブ上に全員をプロットする（2026-09-14 全面作り直し）。
 *
 * 工夫したこと:
 * - **全員に名前を直接付ける**。凡例やツールチップを見なくても誰がどこかが分かる。
 *   同じ在籍年数に人が固まる（同期入社）ので、ラベルは縦に押し出して重ならないように並べ、
 *   押し出した分は引き出し線でつなぐ。
 * - **今日→改定後を矢印で見せる**。適用開始日つきで登録した改定（3号移行・一律改定・2号移行・契約更新）で
 *   カーブとの位置関係がどう変わるかが1枚で見える。
 * - **カーブとの差を縦の細線で**。赤＝カーブに届いていない、青＝上回る。数字はツールチップに。
 * - 丸の色は在留資格（改定後の予定を含む）。最賃・特定技能の報酬下限も重ねる。
 */
export function WageMap({ a }: { a: WageAnalysis }) {
  const rows = a.rows
  const [hover, setHover] = useState<WageRow | null>(null)
  const W = 920, H = 560, ML = 70, MR = 130, MT = 20, MB = 70
  const PW = W - ML - MR, PH = H - MT - MB
  // 右端の人の名前を置く余白として 1.5 年分あける
  const x1 = Math.max(10.5, Math.ceil(Math.max(...rows.map(r => r.years)) + 1.5))
  const nextMw = TOKYO_MIN_WAGE.find(m => m.from > a.todayIso)?.yen ?? a.currentMinWage
  const tokuteiFloor = Math.round(nextMw * KENSETSU_TOKUTEI.minWageMultiplier)
  const hs = [...rows.map(r => r.currentHourly), ...rows.map(r => r.revised), nextMw, curveWage(a.curveStart, x1)]
  const y0 = Math.floor((Math.min(...hs) - 80) / 100) * 100
  const y1 = Math.ceil((Math.max(...hs) + 80) / 100) * 100
  const px = (v: number) => ML + (v / x1) * PW
  const py = (v: number) => MT + ((y1 - v) / (y1 - y0)) * PH
  const ticks: number[] = []
  for (let t = y0; t <= y1; t += 200) ticks.push(t)

  // 同じ位置に重なる人（同期入社で同額など）は左右に少しずらす
  const pts = rows.map(r => ({ r, x: px(r.years), y: py(r.revised) }))
  const seen = new Map<string, number>()
  for (const p of pts) {
    const k = `${Math.round(p.x / 6)}_${Math.round(p.y / 6)}`
    const n = seen.get(k) || 0
    seen.set(k, n + 1)
    p.x += n === 0 ? 0 : (n % 2 ? 7 : -7) * Math.ceil(n / 2)
  }

  // ── ラベルの配置 ──
  //   在籍年数が近い人（横 36px 以内）を1つの群にまとめ、群ごとに名前を縦一列に並べる。
  //   列は群の右（右隣の群が近ければ左）に置き、点とは引き出し線で結ぶ。
  //   同期入社で点が縦に密集しても、名前同士・点と名前が重ならない。
  const names = callNames(rows)
  const LH = 15
  const sortedX = [...pts].sort((m, n) => m.x - n.x)
  const clusters: (typeof pts)[] = []
  for (const p of sortedX) {
    const last = clusters[clusters.length - 1]
    if (last && p.x - last[last.length - 1].x <= 36) last.push(p)
    else clusters.push([p])
  }
  type Label = { p: (typeof pts)[number]; text: string; w: number; lx: number; ly: number; side: 'R' | 'L' }
  const labels: Label[] = []
  clusters.forEach((cl, ci) => {
    const minX = Math.min(...cl.map(p => p.x)), maxX = Math.max(...cl.map(p => p.x))
    const nextGap = ci + 1 < clusters.length ? Math.min(...clusters[ci + 1].map(p => p.x)) - maxX : Infinity
    const prevGap = ci > 0 ? minX - Math.max(...clusters[ci - 1].map(p => p.x)) : Infinity
    const items = cl.map(p => {
      const text = `${names.get(p.r.id)} ${yen(p.r.revised)}${p.r.stageException ? ' ※' : ''}`
      return { p, text, w: textW(text) }
    })
    const colW = Math.max(...items.map(i => i.w))
    const side: 'R' | 'L' = nextGap >= colW + 40 || prevGap < colW + 40 ? 'R' : 'L'
    const colX = side === 'R' ? maxX + 30 : minX - 30
    // 点の高さ順に並べ、重ならないよう下に押し出してから、群全体の中心を点の中心に戻す
    items.sort((m, n) => m.p.y - n.p.y)
    const ys = items.map(i => i.p.y + 4)
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < LH) ys[i] = ys[i - 1] + LH
    const shift = (items.reduce((t, i) => t + i.p.y + 4, 0) - ys.reduce((t, y) => t + y, 0)) / ys.length
    items.forEach((it, i) => labels.push({ p: it.p, text: it.text, w: it.w, lx: colX, ly: Math.max(MT + 10, ys[i] + shift), side }))
  })

  const curvePath = Array.from({ length: Math.ceil(x1 * 4) + 1 }, (_, i) => {
    const yr = i / 4
    return `${i === 0 ? 'M' : 'L'}${px(yr).toFixed(1)},${py(curveWage(a.curveStart, yr)).toFixed(1)}`
  }).join(' ')

  // 色分けは実際の在留資格（年数から推定した段階ではない）。例: 実習3号に合格せず特定1号へ移行した人
  const colorStage = (r: WageRow) => (r.visaStage >= 0 ? r.visaStage : r.stage)
  const stageUsed = Array.from(new Set(rows.map(colorStage))).sort()
  const exceptions = rows.filter(r => r.stageException)

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[680px]" role="img" aria-label="賃金カーブ上の全員の位置">
        <defs>
          <marker id="wm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="fill-gray-500 dark:fill-gray-400" />
          </marker>
        </defs>

        {/* 段階の帯（在籍年数の目安） */}
        {STAGES.slice(0, 4).map((st, i) => (
          <g key={st.key}>
            <rect x={px(st.from)} y={MT} width={Math.max(0, px(Math.min(st.to, x1)) - px(st.from))} height={PH}
              className={i % 2 ? 'fill-gray-50 dark:fill-gray-800/40' : 'fill-transparent'} />
            <text x={(px(st.from) + px(Math.min(st.to, x1))) / 2} y={MT + PH + 36} textAnchor="middle"
              className="fill-gray-500 text-[11px] font-semibold">{st.key}</text>
          </g>
        ))}

        {ticks.map(t => (
          <g key={t}>
            <line x1={ML} y1={py(t)} x2={ML + PW} y2={py(t)} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth={1} />
            <text x={ML - 8} y={py(t) + 4} textAnchor="end" className="fill-gray-400 text-[11px]">{yen(t)}</text>
          </g>
        ))}
        {Array.from({ length: Math.floor(x1) + 1 }, (_, i) => i).map(t => (
          <text key={t} x={px(t)} y={MT + PH + 18} textAnchor="middle" className="fill-gray-400 text-[11px]">{t}年</text>
        ))}

        {/* 最賃と特定技能の報酬下限 */}
        <line x1={ML} y1={py(nextMw)} x2={ML + PW} y2={py(nextMw)} stroke="currentColor" className="text-red-400" strokeWidth={1.2} strokeDasharray="4 4" />
        <text x={ML + PW - 4} y={py(nextMw) + 13} textAnchor="end" className="fill-red-500 text-[10px]">最低賃金 {yen(nextMw)}</text>
        <line x1={ML} y1={py(tokuteiFloor)} x2={ML + PW} y2={py(tokuteiFloor)} stroke="currentColor" className="text-amber-500" strokeWidth={1.2} strokeDasharray="8 4" />
        <text x={ML + PW - 4} y={py(tokuteiFloor) + 13} textAnchor="end" className="fill-amber-600 dark:fill-amber-400 text-[10px]">特定技能の報酬下限 {yen(tokuteiFloor)}（最賃×1.1）</text>

        {/* 賃金カーブ */}
        <path d={curvePath} fill="none" stroke="currentColor" strokeWidth={2.6} className="text-emerald-600 dark:text-emerald-400" />

        {/* カーブとの差（縦の細線） */}
        {pts.map(({ r, x, y }) => {
          const cy = py(r.curve)
          const below = r.devCurveRevised < 0
          return Math.abs(r.devCurveRevised) >= 10 && (
            <line key={`gap-${r.id}`} x1={x} y1={cy} x2={x} y2={y} stroke="currentColor" strokeWidth={1.2}
              className={below ? 'text-red-400/70' : 'text-blue-400/70'} />
          )
        })}

        {/* 今日 → 改定後 */}
        {pts.map(({ r, x, y }) => {
          const yNow = py(r.currentHourly)
          const moved = Math.abs(r.revised - r.currentHourly) >= 1
          return (
            <g key={`mv-${r.id}`}>
              {moved && (
                <>
                  <circle cx={x} cy={yNow} r={5} className="fill-white dark:fill-gray-900" stroke="currentColor" strokeWidth={1.5}>
                  </circle>
                  <line x1={x} y1={yNow - 6} x2={x} y2={y + 8} stroke="currentColor" strokeWidth={1.4}
                    className="text-gray-500 dark:text-gray-400" markerEnd="url(#wm-arrow)" />
                </>
              )}
            </g>
          )
        })}

        {/* 改定後の点 */}
        {pts.map(({ r, x, y }) => (
          <g key={`pt-${r.id}`}>
            <circle cx={x} cy={y} r={hover?.id === r.id ? 8.5 : 6.5} className={STAGE_FILL[colorStage(r)] || 'fill-gray-400'} stroke="white" strokeWidth={1.5} />
            <circle cx={x} cy={y} r={15} fill="transparent" className="cursor-pointer"
              onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} onClick={() => setHover(r)} />
          </g>
        ))}

        {/* 名前（群ごとに縦一列。点とは引き出し線で結ぶ） */}
        {labels.map(l => {
          const edgeX = l.side === 'R' ? l.lx - 6 : l.lx + 6
          return (
            <g key={`lb-${l.p.r.id}`} pointerEvents="none">
              <line x1={l.p.x + (l.side === 'R' ? 7 : -7)} y1={l.p.y} x2={edgeX} y2={l.ly - 4}
                stroke="currentColor" strokeWidth={0.8} className="text-gray-300 dark:text-gray-600" />
              <text x={l.lx} y={l.ly} textAnchor={l.side === 'R' ? 'start' : 'end'}
                className={`text-[10.5px] ${l.p.r.devCurveRevised < -40 ? 'fill-red-600 dark:fill-red-400 font-semibold' : 'fill-gray-700 dark:fill-gray-200'}`}>
                {l.text}
              </text>
            </g>
          )
        })}

        {/* 凡例 */}
        <g transform={`translate(${ML + PW + 14}, ${MT + 6})`}>
          <line x1={0} y1={-4} x2={16} y2={-4} stroke="currentColor" strokeWidth={2.6} className="text-emerald-600 dark:text-emerald-400" />
          <text x={20} y={0} className="fill-emerald-700 dark:fill-emerald-300 text-[10px] font-semibold">賃金カーブ（評価A）</text>
          <g transform="translate(0, 22)">
          <text x={0} y={0} className="fill-gray-500 text-[10px] font-semibold">在留資格</text>
          {stageUsed.map((si, i) => (
            <g key={si} transform={`translate(0, ${14 + i * 16})`}>
              <circle cx={5} cy={-3} r={5} className={STAGE_FILL[si]} />
              <text x={14} y={1} className="fill-gray-600 dark:fill-gray-300 text-[10px]">{STAGES[si].key}</text>
            </g>
          ))}
          <g transform={`translate(0, ${24 + stageUsed.length * 16})`}>
            <circle cx={5} cy={-3} r={4.5} className="fill-white dark:fill-gray-900" stroke="currentColor" strokeWidth={1.5} />
            <text x={14} y={1} className="fill-gray-600 dark:fill-gray-300 text-[10px]">今日の時給</text>
            <circle cx={5} cy={13} r={5} className="fill-gray-500" />
            <text x={14} y={17} className="fill-gray-600 dark:fill-gray-300 text-[10px]">改定後</text>
            <line x1={0} y1={30} x2={10} y2={30} stroke="currentColor" strokeWidth={1.5} className="text-red-400" />
            <text x={14} y={33} className="fill-gray-600 dark:fill-gray-300 text-[10px]">カーブ未満</text>
            <line x1={0} y1={46} x2={10} y2={46} stroke="currentColor" strokeWidth={1.5} className="text-blue-400" />
            <text x={14} y={49} className="fill-gray-600 dark:fill-gray-300 text-[10px]">カーブ超</text>
          </g>
          </g>
        </g>

        {hover && <Tip r={hover} x={pts.find(p => p.r.id === hover.id)!.x} y={pts.find(p => p.r.id === hover.id)!.y} W={W} />}
      </svg>
      <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
        名前の横の金額は改定後の時給。赤字はカーブを40円以上下回る人。縦の細線の長さがカーブとの差（ツールチップに金額）。
        在籍年数は入社日からの年数（再入社のブランクがある人はブランクを除いた年数）。丸の色は実際の在留資格。
      </p>
      {exceptions.map(r => (
        <p key={r.id} className="text-[11px] text-amber-700 dark:text-amber-400 mt-1 leading-relaxed">
          ※ {r.name}：{r.context?.detail ?? `在留資格（${r.visa}）と在籍年数の段階（${STAGES[r.stage].key}）が一致しない。`}
        </p>
      ))}
    </div>
  )
}


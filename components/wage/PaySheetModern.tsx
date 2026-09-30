'use client'
/**
 * 給料表（新デザイン・2026-09-30 代表依頼「Excel の様式にとらわれず、かっこよくて見やすく」）
 *
 * A4横1枚。読む順番で上から並べる:
 *   ① 誰の・何年度の給料表か（名前・役職・号・年齢）
 *   ② いちばん大事な数字（新しい日給・年間の昇給・ベース年収・実質日給）
 *   ③ なぜ上がったか（評価＋年齢＋特別＋代表加算＝合計の号、号の動き）と代表・会社からのメッセージ
 *   ④ ベース年収の推移（今年度だけ濃い棒）と、数字の出し方
 * 色は紺（#1B2A4A）とアンバー（#F5A623）の2色。白黒印刷でも読める濃さにしている。
 * 数値は lib/jp-wage.ts の paySheetFigures（旧様式と同じ）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PaySheetFigures } from '@/lib/jp-wage'
import { ANNUAL_DAYS, PAID_LEAVE_DAYS, TOTAL_PAID_DAYS, MAX_STEP } from '@/lib/jp-wage'

const NAVY = '#1B2A4A'
const AMBER = '#F5A623'
const INK = '#1f2937'
const MUTED = '#6b7280'
const LINE = '#e5e7eb'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const num = (v: number) => Math.round(v).toLocaleString()
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v)

export interface PaySheetPerson {
  workerId: number
  name: string
  grade: string
  gradeLabel: string
  oldStep: number | null
  newStep: number | null
  hyogo: string
  age: number | null
  pitches: null | { hyogo: number; age: number; special: number; discretionary: number; total: number }
  comment: string | null
  discretionaryReason?: string | null
}

/**
 * ベース年収の推移（棒グラフ）。印刷で崩れないよう依存なしのSVG。
 * 2026-09-30（代表依頼）: 右肩上がりを強く見せる。
 *   - 縦軸は0からではなく、最小年の少し下から（年ごとの差が見える）。軸の下端に「途中省略」の波線を入れる
 *   - 棒の上をアンバーの線で結び、最後に矢印。棒の色は古い年ほど薄く、今年度は紺
 */
function TrendBars({ points, fy }: { points: { year: number; baseAnnual: number }[]; fy: number }) {
  // 置いた枠の大きさ（px）に合わせて描く。viewBox を枠と同じ比率にするので文字がゆがまない（2026-09-30）
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 520, h: 190 })
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  if (points.length === 0) return null
  const W = size.w, H = Math.max(140, size.h), ML = 14, MR = 14, MT = 26, MB = 22
  const vals = points.map(p => p.baseAnnual)
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const span = Math.max(max - min, max * 0.04)
  const lo = Math.max(0, min - span * 0.45)           // 最小年の棒も少し高さが残るように
  const hi = max + span * 0.12
  const n = points.length
  const slot = (W - ML - MR) / n
  const bw = Math.min(46, slot * 0.6)
  const y = (v: number) => MT + (1 - (v - lo) / (hi - lo)) * (H - MT - MB)
  const base = H - MB
  const shade = (i: number) => {
    // 古い年 #dbe3ee → 新しい年 #7b8ba3（今年度は紺）
    const t = n <= 1 ? 1 : i / (n - 1)
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
    return `rgb(${mix(219, 123)},${mix(227, 139)},${mix(238, 163)})`
  }
  const tops = points.map((p, i) => ({ x: ML + slot * i + slot / 2, y: y(p.baseAnnual) }))
  const last = tops[tops.length - 1]
  const prev = tops[tops.length - 2]
  const ang = prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : -Math.PI / 4
  const ah = 9
  const arrow = `${last.x + Math.cos(ang) * 4},${last.y + Math.sin(ang) * 4} ${last.x + Math.cos(ang) * 4 - Math.cos(ang - 0.5) * ah},${last.y + Math.sin(ang) * 4 - Math.sin(ang - 0.5) * ah} ${last.x + Math.cos(ang) * 4 - Math.cos(ang + 0.5) * ah},${last.y + Math.sin(ang) * 4 - Math.sin(ang + 0.5) * ah}`
  return (
    <div ref={boxRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} role="img" aria-label="ベース年収の推移">
      <line x1={ML} y1={base} x2={W - MR} y2={base} stroke="#cbd5e1" strokeWidth={1} />
      {/* 縦軸の途中省略（0から始めていない印） */}
      <path d={`M ${ML - 8} ${base - 9} l 4 -3 l 4 6 l 4 -6 l 4 3`} fill="none" stroke="#94a3b8" strokeWidth={1} />
      {points.map((p, i) => {
        const cx = tops[i].x
        const top = tops[i].y
        const cur = p.year === fy
        return (
          <g key={p.year}>
            <rect x={cx - bw / 2} y={top} width={bw} height={base - top} rx={3} fill={cur ? NAVY : shade(i)} />
            <text x={cx} y={H - 7} textAnchor="middle" fontSize={9} fill={cur ? NAVY : MUTED} fontWeight={cur ? 700 : 400}>{p.year}</text>
          </g>
        )
      })}
      {/* 右肩上がりの線（棒の上を結ぶ）と矢印 */}
      {tops.length >= 2 && (
        <>
          <polyline points={tops.map(t => `${t.x},${t.y - 3}`).join(' ')} fill="none" stroke={AMBER} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {tops.slice(0, -1).map((t, i) => <circle key={i} cx={t.x} cy={t.y - 3} r={2.6} fill="white" stroke={AMBER} strokeWidth={1.6} />)}
          <polygon points={arrow.split(' ').map(q => { const [a, b] = q.split(',').map(Number); return `${a},${b - 3}` }).join(' ')} fill={AMBER} />
        </>
      )}
      {/* 値ラベル（2026-09-30 改）: 途中の年は棒の中の上端に入れて、右肩上がりの線と重ならないようにする。
          今年度だけ棒の上に大きく（矢印の左）。棒が低すぎて入らないときは棒の上に出す */}
      {points.map((p, i) => {
        const cur = p.year === fy
        const t = tops[i]
        const barH = base - t.y
        const label = `${(p.baseAnnual / 10000).toFixed(0)}万`
        if (cur) {
          return (
            <text key={`v${p.year}`} x={t.x - 4} y={t.y - 15} textAnchor="end" fontSize={13} fontWeight={800} fill={NAVY}>{label}</text>
          )
        }
        const inside = barH >= 30
        const dark = i / Math.max(1, n - 1) > 0.55
        return (
          <text key={`v${p.year}`} x={t.x} y={inside ? t.y + 15 : t.y - 10} textAnchor="middle"
            fontSize={9} fontWeight={700} fill={inside ? (dark ? 'white' : INK) : MUTED}>{label}</text>
        )
      })}
    </svg>
    </div>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: ReactNode; accent?: boolean }) {
  return (
    <div style={{
      flex: 1, borderRadius: 10, padding: '9px 12px',
      background: accent ? NAVY : '#f8fafc', color: accent ? 'white' : INK,
      border: accent ? 'none' : `1px solid ${LINE}`,
    }}>
      <div style={{ fontSize: 9.5, letterSpacing: '0.04em', opacity: accent ? 0.8 : 1, color: accent ? 'white' : MUTED }}>{label}</div>
      <div style={{ fontSize: accent ? 26 : 21, fontWeight: 800, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, marginTop: 2, color: accent ? '#fde7b8' : MUTED, fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
    </div>
  )
}

function PitchChip({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{
      textAlign: 'center', minWidth: 58, borderRadius: 8, padding: '5px 8px',
      background: strong ? AMBER : '#f1f5f9', color: strong ? NAVY : INK,
    }}>
      <div style={{ fontSize: 8.5, color: strong ? NAVY : MUTED }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

export default function PaySheetModern({
  p, fig, points, fy, effectiveLabel, isDraft,
}: {
  p: PaySheetPerson
  fig: PaySheetFigures
  points: { year: number; baseAnnual: number }[]
  fy: number
  /** 「2026年10月1日」 */
  effectiveLabel: string
  isDraft: boolean
}) {
  const pt = p.pitches
  const op = (s: string) => <div style={{ fontSize: 14, color: MUTED, alignSelf: 'center' }}>{s}</div>
  const disc = pt?.discretionary ?? 0
  const hasMsg = (disc !== 0 && !!p.discretionaryReason?.trim()) || !!p.comment?.trim()

  return (
    <div className="sheet" style={{ padding: '8mm 10mm', color: INK, height: '190mm', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {isDraft && <div className="draft-mark">下書き（未確定）</div>}

      {/* ① ヘッダー（紺の帯・2026-09-30） */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: NAVY, color: 'white',
        borderRadius: 12, padding: '10px 18px', position: 'relative', overflow: 'hidden',
      }}>
        {/* 右端のアンバーの斜めの帯（飾り） */}
        <div style={{ position: 'absolute', right: -30, top: 0, bottom: 0, width: 90, background: AMBER, transform: 'skewX(-20deg)', opacity: 0.95 }} />
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 9.5, letterSpacing: '0.22em', opacity: 0.75 }}>HIBI CONSTRUCTION ｜ とび事業部</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 1 }}>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.08em' }}>給料表</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fde7b8' }}>{fy}年度</div>
            <div style={{ fontSize: 10, opacity: 0.75 }}>{effectiveLabel} 改定</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', position: 'relative', marginRight: 64 }}>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '0.1em' }}>{p.name}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.85 }}>様</span></div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 3 }}>
            {[
              `${p.gradeLabel}（${p.grade === 'doko' ? '土工' : p.grade}）`,
              `${p.newStep ?? '—'}号`,
              p.age === null ? null : `${p.age}歳`,
            ].filter(Boolean).map(t => (
              <span key={t as string} style={{ fontSize: 10, border: '1px solid rgba(255,255,255,0.6)', borderRadius: 999, padding: '1px 9px' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ② 大事な数字 */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <Kpi accent label="新しい日給" value={yen(fig.daily)}
          sub={<>改定前 {yen(fig.prevDaily)} から <b>{fig.daily >= fig.prevDaily ? '+' : '−'}{yen(Math.abs(fig.daily - fig.prevDaily))}</b></>} />
        <Kpi label="年間の昇給額" value={`+${yen(fig.raisePerYear)}`} sub={<>年収の伸び <b style={{ color: NAVY }}>+{(fig.upRate * 100).toFixed(1)}%</b></>} />
        <Kpi label="ベース年収（概算）" value={yen(fig.baseAnnual)} sub={<>前年度 {yen(fig.prevBaseAnnual)}</>} />
        <Kpi label="実質日給（有給買取込み）" value={yen(fig.effectiveDaily)} sub={<>前年度 {yen(fig.prevEffectiveDaily)}</>} />
      </div>

      {/* ③ なぜ上がったか ＋ メッセージ */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <div style={{ flex: hasMsg ? 1.25 : 1, border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: NAVY, marginBottom: 6 }}>昇給の内訳（号）</div>
          {pt ? (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <PitchChip label={`評価 ${p.hyogo}`} value={signed(pt.hyogo)} />
                {op('＋')}
                <PitchChip label="年齢調整" value={pt.age ? signed(pt.age) : '0'} />
                {op('＋')}
                <PitchChip label="特別調整" value={pt.special ? signed(pt.special) : '0'} />
                {op('＋')}
                <PitchChip label="代表加算" value={disc ? signed(disc) : '0'} />
                {op('＝')}
                <PitchChip strong label="合計" value={`${signed(pt.total)}号`} />
              </div>
              {/* 号の動き */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 10.5 }}>
                <span style={{ color: MUTED }}>号の動き</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{p.oldStep ?? '—'}号</b>
                {/* 号表（1〜60号）のどこにいるか。灰＝改定前まで、アンバー＝今回上がった分 */}
                <div style={{ flex: 1, height: 8, borderRadius: 999, background: '#eef2f7', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${((p.oldStep ?? 0) / MAX_STEP) * 100}%`, background: '#94a3b8' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${((p.oldStep ?? 0) / MAX_STEP) * 100}%`, width: `${(((p.newStep ?? 0) - (p.oldStep ?? 0)) / MAX_STEP) * 100}%`, background: AMBER }} />
                </div>
                <span style={{ color: MUTED, fontSize: 9 }}>/ {MAX_STEP}号</span>
                <b style={{ color: NAVY, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{p.newStep ?? '—'}号</b>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: MUTED }}>今年度は号の改定はありません（処遇固定）。</div>
          )}
        </div>

        {hasMsg && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {disc !== 0 && p.discretionaryReason?.trim() && (
              <div style={{ borderLeft: `4px solid ${AMBER}`, background: '#fffbeb', borderRadius: '0 10px 10px 0', padding: '7px 11px' }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: '#92400e' }}>代表加算 {signed(disc)}号 について</div>
                <div style={{ fontSize: 10, lineHeight: 1.65, whiteSpace: 'pre-wrap', marginTop: 2 }}>{p.discretionaryReason}</div>
              </div>
            )}
            {p.comment?.trim() && (
              <div style={{ borderLeft: `4px solid ${NAVY}`, background: '#f1f5f9', borderRadius: '0 10px 10px 0', padding: '7px 11px' }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: NAVY }}>会社から</div>
                <div style={{ fontSize: 10, lineHeight: 1.65, whiteSpace: 'pre-wrap', marginTop: 2 }}>{p.comment}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ④ 推移 ＋ 数字の出し方 */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1.45, border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: NAVY }}>ベース年収の推移</div>
            {points.length >= 2 && points[points.length - 1].baseAnnual > points[0].baseAnnual && (
              <div style={{ fontSize: 10, color: MUTED }}>
                {points[0].year}年から{' '}
                <b style={{ fontSize: 13, color: NAVY }}>
                  +{Math.round((points[points.length - 1].baseAnnual - points[0].baseAnnual) / 10000).toLocaleString()}万円
                </b>
                <span style={{ marginLeft: 4, color: '#b45309', fontWeight: 700 }}>
                  （+{((points[points.length - 1].baseAnnual / points[0].baseAnnual - 1) * 100).toFixed(1)}%）
                </span>
              </div>
            )}
          </div>
          <TrendBars points={points} fy={fy} />
          <div style={{ fontSize: 7.5, color: '#9ca3af', textAlign: 'right' }}>※ 縦軸は途中から表示しています</div>
        </div>
        <div style={{ flex: 1, border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px', fontSize: 10.5, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: NAVY, marginBottom: 6 }}>数字の出し方</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
            <tbody>
              {[
                ['日給', `${yen(fig.daily)} × ${ANNUAL_DAYS}日`, yen(fig.daily * ANNUAL_DAYS)],
                ['有給（買取込み）', `${yen(fig.daily)} × ${PAID_LEAVE_DAYS}日`, yen(fig.leaveBuyout)],
              ].map(([a, b, c]) => (
                <tr key={a} style={{ borderBottom: `1px solid ${LINE}` }}>
                  <td style={{ padding: '4px 0', color: MUTED }}>{a}</td>
                  <td style={{ padding: '4px 0', textAlign: 'right', color: MUTED }}>{b}</td>
                  <td style={{ padding: '4px 0', textAlign: 'right', width: 86 }}>{c}</td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: '5px 0', fontWeight: 700 }}>ベース年収</td>
                <td style={{ padding: '5px 0', textAlign: 'right', color: MUTED }}>{TOTAL_PAID_DAYS}日分</td>
                <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 800, color: NAVY }}>{yen(fig.baseAnnual)}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8, padding: '6px 8px', background: '#f8fafc', borderRadius: 6, color: MUTED, lineHeight: 1.6 }}>
            実質日給 ＝ ベース年収 ÷ {ANNUAL_DAYS}日 ＝ <b style={{ color: INK }}>{yen(fig.effectiveDaily)}</b>
            <br />
            （有給の買取分 {yen(fig.leavePerDay)} を1日あたりに上乗せした額）
          </div>
          <div style={{ marginTop: 6, color: MUTED, fontSize: 8.5, lineHeight: 1.5 }}>
            ※ ベース年収は稼働{ANNUAL_DAYS}日・有給{PAID_LEAVE_DAYS}日で計算した目安です。残業代・手当・賞与は含みません。
          </div>
        </div>
      </div>

      {/* フッター */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 5, borderTop: `2px solid ${NAVY}`, fontSize: 8.5, color: MUTED }}>
        <span style={{ letterSpacing: '0.18em', fontWeight: 700, color: NAVY }}>HIBI CONSTRUCTION</span>
        <span>この給料表は、{effectiveLabel}改定の内容をお知らせするものです。</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>No.{p.workerId} ／ {num(fig.daily)}</span>
      </div>
    </div>
  )
}

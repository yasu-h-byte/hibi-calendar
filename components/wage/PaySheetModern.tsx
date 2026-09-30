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
import type { ReactNode } from 'react'
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

/** ベース年収の推移（棒グラフ）。印刷で崩れないよう依存なしのSVG */
function TrendBars({ points, fy }: { points: { year: number; baseAnnual: number }[]; fy: number }) {
  if (points.length === 0) return null
  const W = 520, H = 190, ML = 8, MR = 8, MT = 22, MB = 22
  const max = Math.max(...points.map(p => p.baseAnnual))
  const n = points.length
  const slot = (W - ML - MR) / n
  const bw = Math.min(34, slot * 0.62)
  const y = (v: number) => MT + (1 - v / (max * 1.08)) * (H - MT - MB)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="ベース年収の推移">
      <line x1={ML} y1={H - MB} x2={W - MR} y2={H - MB} stroke={LINE} strokeWidth={1} />
      {points.map((p, i) => {
        const cx = ML + slot * i + slot / 2
        const top = y(p.baseAnnual)
        const cur = p.year === fy
        return (
          <g key={p.year}>
            <rect x={cx - bw / 2} y={top} width={bw} height={H - MB - top} rx={3}
              fill={cur ? NAVY : '#cbd5e1'} />
            <text x={cx} y={top - 5} textAnchor="middle" fontSize={cur ? 11 : 9} fontWeight={cur ? 700 : 400} fill={cur ? NAVY : MUTED}>
              {(p.baseAnnual / 10000).toFixed(0)}万
            </text>
            <text x={cx} y={H - 7} textAnchor="middle" fontSize={9} fill={cur ? NAVY : MUTED} fontWeight={cur ? 700 : 400}>
              {p.year}
            </text>
          </g>
        )
      })}
    </svg>
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
    <div className="sheet" style={{ padding: '9mm 11mm', color: INK }}>
      {isDraft && <div className="draft-mark">下書き（未確定）</div>}

      {/* ① ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', borderBottom: `3px solid ${NAVY}`, paddingBottom: 8 }}>
        <div>
          <div style={{ fontSize: 9.5, letterSpacing: '0.18em', color: MUTED }}>HIBI CONSTRUCTION ｜ とび事業部</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 2 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: NAVY, letterSpacing: '0.06em' }}>給料表</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{fy}年度</div>
            <div style={{ fontSize: 10, color: MUTED }}>{effectiveLabel} 改定</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.08em' }}>{p.name}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>様</span></div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 3 }}>
            {[
              `${p.gradeLabel}（${p.grade === 'doko' ? '土工' : p.grade}）`,
              `${p.newStep ?? '—'}号`,
              p.age === null ? null : `${p.age}歳`,
            ].filter(Boolean).map(t => (
              <span key={t as string} style={{ fontSize: 10, border: `1px solid ${NAVY}`, color: NAVY, borderRadius: 999, padding: '1px 9px' }}>{t}</span>
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
      <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'stretch' }}>
        <div style={{ flex: 1.45, border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: NAVY }}>ベース年収の推移</div>
          <TrendBars points={points} fy={fy} />
        </div>
        <div style={{ flex: 1, border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px', fontSize: 10 }}>
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

      <div style={{ position: 'absolute', right: '11mm', bottom: '5mm', fontSize: 8, color: '#9ca3af' }}>
        No.{p.workerId} ／ {num(fig.daily)} ／ {effectiveLabel}改定
      </div>
    </div>
  )
}

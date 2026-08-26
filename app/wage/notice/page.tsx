'use client'

/**
 * とび事業部給料表（本人へ渡す様式）A4印刷ページ
 *
 * 実物（2025年10月改定版）の様式に合わせて組んでいる。数式は
 * `lib/jp-wage.ts` の paySheetFigures に置き、実物の数値で回帰テストしている
 * （__tests__/jpWage.test.ts）。様式を触っても金額がズレないようにするため。
 *
 * - URL: /wage/notice?effective=2026-10-01
 * - `(app)` グループ外に置いてサイドバーを出さない
 * - 1名につきA4横1枚。ブラウザの印刷からPDF保存もできる
 *
 * 金額は**確定時に凍結した値**を使う。号俸表をあとから変えても、
 * 本人に渡した給料表の数字は動かない。
 */

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { paySheetFigures, PAID_LEAVE_DAYS, GRADE_LABELS, ageOn, type JpGrade } from '@/lib/jp-wage'

const n0 = (v: number) => Math.round(v).toLocaleString()

interface Frozen {
  workerId: number
  name: string
  status: string
  grade: string
  oldStep: number | null
  newStep: number | null
  hyogo: string
  comment: string | null
  birthDate: string | null
  pitches: null | { hyogo: number; age: number; special: number; total: number }
  oldDaily: number | null
  newDaily: number | null
  raisePerDay: number
  adjustment: number | null
}
interface Payload {
  effective: string
  status: 'draft' | 'applied'
  frozen: Frozen[] | null
  /** workerId → 過去のベース年収 [{year, baseAnnual}] */
  history?: Record<string, { year: number; baseAnnual: number }[]>
}

const jpDate = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

/** ベース年収推移の折れ線。印刷でも崩れないよう依存なしのSVGで描く */
function TrendChart({ points }: { points: { year: number; baseAnnual: number }[] }) {
  if (points.length < 2) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 11, border: '1px solid #ddd' }}>
        過去のベース年収が未登録のため、推移を表示できません
      </div>
    )
  }
  const W = 430, H = 200, ML = 54, MR = 8, MT = 14, MB = 26
  const vals = points.map(p => p.baseAnnual)
  const lo = Math.floor(Math.min(...vals) / 100000) * 100000
  const hi = Math.ceil(Math.max(...vals) / 100000) * 100000
  const px = (i: number) => ML + (i / (points.length - 1)) * (W - ML - MR)
  const py = (v: number) => MT + ((hi - v) / (hi - lo || 1)) * (H - MT - MB)
  const ticks = 5
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="ベース年収の推移">
      {Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) / ticks) * i).map(v => (
        <g key={v}>
          <line x1={ML} y1={py(v)} x2={W - MR} y2={py(v)} stroke="#e5e5e5" strokeWidth={1} />
          <text x={ML - 5} y={py(v) + 3} textAnchor="end" fontSize={8} fill="#888">{n0(v)}</text>
        </g>
      ))}
      <polyline
        points={points.map((p, i) => `${px(i)},${py(p.baseAnnual)}`).join(' ')}
        fill="none" stroke="#4472C4" strokeWidth={2} strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <text key={p.year} x={px(i)} y={H - 8} textAnchor="middle" fontSize={8} fill="#888">{p.year}年</text>
      ))}
    </svg>
  )
}

function SheetBody() {
  const params = useSearchParams()
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const pw = raw ? JSON.parse(raw)?.password : ''
      if (!pw) { setErr('ログインが必要です'); return }
      const eff = params.get('effective')
      fetch(`/api/jp-wage/revision${eff ? `?effective=${eff}` : ''}`, { headers: { 'x-admin-password': pw } })
        .then(async r => { if (!r.ok) throw new Error(`取得に失敗しました（${r.status}）`); return r.json() })
        .then((j: Payload) => setData(j))
        .catch(e => setErr(e instanceof Error ? e.message : '不明なエラー'))
    } catch { setErr('ログイン情報を読めませんでした') }
  }, [params])

  if (err) return <div style={{ padding: 24, color: '#b91c1c' }}>エラー: {err}</div>
  if (!data) return <div style={{ padding: 24, color: '#666' }}>読み込み中…</div>
  if (data.status !== 'applied' || !data.frozen) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>まだ確定していません</h1>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.9 }}>
          給料表は確定した改定の内容から作ります。<br />
          賃金制度 → 年次改定 で確定してから、もう一度開いてください。
        </p>
      </div>
    )
  }

  const fy = Number(data.effective.slice(0, 4)) + 1   // 2026-10-01改定 → 2027年度
  const targets = data.frozen.filter(f => f.newDaily != null && f.oldDaily != null)

  return (
    <>
      <style jsx global>{`
        @page { size: A4 landscape; margin: 10mm; }
        @media print {
          html, body { background: white !important; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; page-break-after: always; }
          .sheet:last-child { page-break-after: auto; }
        }
        body { background: #f5f5f5; margin: 0; font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif; color: #111; }
        .sheet { width: 277mm; min-height: 190mm; background: white; margin: 12px auto; padding: 8mm 10mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); }
        .g td, .g th { border: 1px solid #808080; padding: 3px 6px; font-size: 10px; text-align: center; }
        .g th { background: #f2f2f2; font-weight: 700; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>

      <div className="no-print" style={{ padding: '12px 16px', background: '#1B2A4A', color: 'white', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>とび事業部給料表</b>
        <span style={{ fontSize: 12, opacity: .85 }}>{jpDate(data.effective)} 改定 ／ {targets.length}名</span>
        <button onClick={() => window.print()} style={{ padding: '6px 14px', background: 'white', color: '#1B2A4A', borderRadius: 4, fontSize: 13, border: 'none', cursor: 'pointer', fontWeight: 700 }}>🖨 印刷 / PDF保存</button>
        <span style={{ fontSize: 11, opacity: .7 }}>1名につきA4横1枚</span>
      </div>

      {targets.map(f => {
        const fig = paySheetFigures(f.newDaily!, f.oldDaily!)
        const hist = data.history?.[String(f.workerId)] ?? []
        const points = [...hist, { year: fy - 1, baseAnnual: fig.baseAnnual }]
          .filter((p, i, a) => a.findIndex(x => x.year === p.year) === i)
          .sort((a, b) => a.year - b.year)
        const gradeLabel = GRADE_LABELS[f.grade as JpGrade] ?? f.grade
        const age = f.birthDate ? ageOn(f.birthDate, data.effective) : null

        return (
          <div key={f.workerId} className="sheet">
            {/* ヘッダ */}
            <div style={{ display: 'flex', alignItems: 'baseline' }}>
              <div style={{ flex: 1 }} />
              <h1 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>とび事業部給料表</h1>
              <div style={{ flex: 1, textAlign: 'right', fontSize: 10 }}>{jpDate(data.effective).replace(/1日$/, '')}改定版</div>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 10, fontSize: 11 }}>
              <div style={{ width: 120 }}>{fy}年度</div>
              <div style={{ flex: 1 }} />
              <div>氏名：<b style={{ fontSize: 13, marginLeft: 12 }}>{f.name}</b></div>
              <div style={{ width: 40 }} />
            </div>

            <div style={{ display: 'flex', gap: 20, marginTop: 8, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 11, lineHeight: 2 }}>
                <div>所属　　<span style={{ marginLeft: 14 }}>とび事業部</span></div>
                <div>役職　　<span style={{ marginLeft: 14 }}>{gradeLabel}（{f.grade === 'doko' ? '土工' : f.grade}）</span></div>
              </div>
              <div style={{ flex: 1 }} />
              {/* 調整の内訳 */}
              <table className="g" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th colSpan={2}>昇給評価</th><th>年齢調整</th><th>特別調整</th><th>合計</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ minWidth: 34 }}>{f.hyogo}</td>
                    <td style={{ minWidth: 34 }}>{f.pitches?.hyogo ?? '—'}</td>
                    <td style={{ minWidth: 56 }}>{f.pitches?.age || ''}</td>
                    <td style={{ minWidth: 56 }}>{f.pitches?.special || ''}</td>
                    <td style={{ minWidth: 44, fontWeight: 700 }}>{f.pitches?.total ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 本表 */}
            <table className="g" style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
              <thead>
                <tr>
                  <th colSpan={2}>基準日<br />{jpDate(data.effective)}</th>
                  <th>年齢</th><th>等級</th><th>号数</th>
                  <th style={{ background: '#d9e2f3' }}>確定日給</th><th>改訂前</th>
                  <th>有給<br />日数</th><th>有給<br />買取額</th><th>日給<br />換算</th>
                  <th>前期<br />実質日給</th><th style={{ background: '#e2efda' }}>実質<br />日給</th>
                  <th>昇給（日）</th><th>昇給（年）</th>
                  <th>ベース年収<br />概算</th><th>290日<br />UP率</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ width: 26 }}>{f.workerId}</td>
                  <td style={{ minWidth: 86, textAlign: 'left' }}>{f.name}</td>
                  <td>{age === null ? '—' : `${age}歳`}</td>
                  <td>{f.grade === 'doko' ? '土工' : f.grade}</td>
                  <td>{f.newStep}号</td>
                  <td className="num" style={{ background: '#d9e2f3', fontWeight: 700 }}>{n0(fig.daily)}</td>
                  <td className="num">{n0(fig.prevDaily)}</td>
                  <td>{PAID_LEAVE_DAYS}</td>
                  <td className="num">{n0(fig.leaveBuyout)}</td>
                  <td className="num">{n0(fig.leavePerDay)}</td>
                  <td className="num">{n0(fig.prevEffectiveDaily)}</td>
                  <td className="num" style={{ background: '#e2efda' }}>{n0(fig.effectiveDaily)}</td>
                  <td className="num">{n0(fig.raisePerDay)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{n0(fig.raisePerYear)}</td>
                  <td className="num">{n0(fig.baseAnnual)}</td>
                  <td className="num">{(fig.upRate * 100).toFixed(1)}%</td>
                </tr>
              </tbody>
            </table>

            {/* 推移とコメント */}
            <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ textAlign: 'center', fontSize: 11, color: '#666', marginBottom: 2 }}>ベース年収推移</div>
                <TrendChart points={points} />
              </div>
              <div style={{ width: 200 }}>
                <table className="g" style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <tbody>
                    {points.map((p, i) => {
                      const prev = points[i - 1]
                      const up = prev ? p.baseAnnual / prev.baseAnnual - 1 : null
                      return (
                        <tr key={p.year}>
                          <td style={{ width: 52 }}>{p.year}年</td>
                          <td className="num">{n0(p.baseAnnual)}</td>
                          <td className="num" style={{ width: 46 }}>{up === null ? '' : `${(up * 100).toFixed(1)}%`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {f.comment && (
                  <div style={{ border: '1px solid #375623', marginTop: 10, padding: '6px 8px', fontSize: 9.5, lineHeight: 1.85, whiteSpace: 'pre-wrap' }}>
                    {f.comment}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}

export default function WagePaySheetPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#666' }}>読み込み中…</div>}>
      <SheetBody />
    </Suspense>
  )
}

/**
 * 給料のしくみ（日本人社員の賃金制度を1枚で説明する・2026-09-30 代表依頼）
 *
 * 給料表（PaySheetModern）と同じデザインで、各人の給料表の後ろに1枚付ける。
 * その人の等級・年齢に印を付けて「自分はここ」が分かるようにする（未指定なら印なし＝全員共通の1枚）。
 * 中身はすべて lib/jp-wage.ts の値から作る（号俸表・評語・年齢調整・特別調整）。制度を変えればこの紙も変わる。
 * 仕様の正は docs/wage-system.md。
 */
import type { ReactNode, CSSProperties } from 'react'
import {
  GRADE_LABELS, HYOGO_PITCH, SPECIAL_REASONS, SPECIAL_CAP, MAX_STEP, ANNUAL_DAYS, PAID_LEAVE_DAYS, TOTAL_PAID_DAYS,
  dailyForStep, capDaily, pitchOf, ageTableForDisplay, ageAdjustment, type JpGrade, type Hyogo,
} from '@/lib/jp-wage'

const NAVY = '#1B2A4A'
const AMBER = '#F5A623'
const INK = '#1f2937'
const MUTED = '#6b7280'
const LINE = '#e5e7eb'
const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

const LADDER: Exclude<JpGrade, 'doko'>[] = ['6G', '5G', '4G', '3G', '2G', '1G']

/** 左の列の計算例（3G・20号・A評価・38歳）。値は号俸表・年齢調整から計算する */
const EX = (() => {
  const step = 20, age = 38
  const agePitch = ageAdjustment(age, '3G')
  const total = Math.max(0, HYOGO_PITCH.A + agePitch)
  const newStep = Math.min(MAX_STEP, step + total)
  return { step, age, agePitch, total, newStep, oldDaily: dailyForStep('3G', step), newDaily: dailyForStep('3G', newStep) }
})()
const REQUIRED: Partial<Record<JpGrade, string>> = {
  '3G': '鉄骨・足場の作業主任者（両方）',
  '5G': '職長・安全衛生責任者教育',
}

function Card({ title, n, children, style }: { title: string; n: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: '8px 11px', display: 'flex', flexDirection: 'column', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ width: 17, height: 17, borderRadius: 999, background: NAVY, color: 'white', fontSize: 13.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
        <span style={{ fontSize: 15.6, fontWeight: 800, color: NAVY }}>{title}</span>
      </div>
      {/* 中身は縦に均等に配置し、列の高さいっぱいを使う（余白を作らない） */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 4 }}>
        {children}
      </div>
    </div>
  )
}

export default function WageSystemGuide({
  grade, age, fy, effectiveLabel,
}: {
  /** その人の等級（印を付ける）。未指定なら印なし */
  grade?: string | null
  /** その人の基準日時点の年齢（年齢調整の表に印を付ける） */
  age?: number | null
  fy: number
  effectiveLabel: string
}) {
  const scaleMin = 10000
  const scaleMax = Math.max(...LADDER.map(g => capDaily(g))) * 1.02
  const pos = (v: number) => ((v - scaleMin) / (scaleMax - scaleMin)) * 100
  const ageRows = ageTableForDisplay()
  const ageBandIndex = age == null ? -1
    : age <= 25 ? 0 : age <= 30 ? 1 : age <= 35 ? 2 : age <= 40 ? 3 : age <= 45 ? 4 : age <= 50 ? 5 : age <= 55 ? 6 : age <= 59 ? 7 : 8
  // 土工は年齢調整を3G相当で扱う
  const ageCol = grade === 'doko' ? 2 : ['1G', '2G', '3G', '4G', '5G', '6G'].indexOf(grade || '')
  const hyogoOrder: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']

  return (
    <div className="sheet" style={{ padding: '8mm 10mm', color: INK, lineHeight: 1.55, height: '190mm', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', borderBottom: `3px solid ${NAVY}`, paddingBottom: 7 }}>
        <div>
          <div style={{ fontSize: 13.5, letterSpacing: '0.18em', color: MUTED }}>HIBI CONSTRUCTION ｜ とび事業部</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 2 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: NAVY, letterSpacing: '0.06em' }}>給料のしくみ</div>
            <div style={{ fontSize: 17.1, fontWeight: 700 }}>{fy}年度版</div>
            <div style={{ fontSize: 14.2, color: MUTED }}>{effectiveLabel} 改定</div>
          </div>
        </div>
        <div style={{ fontSize: 13.2, fontWeight: 700, color: NAVY, textAlign: 'right', lineHeight: 1.5, marginLeft: 16 }}>
          日給は「<span style={{ color: '#b45309' }}>等級</span> × <span style={{ color: '#b45309' }}>号</span>」で決まり、<br />
          毎年10月1日、評価に応じて号が上がります。<span style={{ background: '#fef3c7', padding: '0 4px' }}>日給が下がることはありません。</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 9, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        {/* ① 等級と日給 */}
        <Card n="1" title="等級と日給の範囲（1〜60号）" style={{ flex: 1.35 }}>
          <div style={{ fontSize: 12.8, color: MUTED, marginBottom: 4 }}>
            等級は<b style={{ color: INK }}>役割</b>で決まります。右の数字は1号あたりの昇給額（号が進むと小さくなる）。
          </div>
          {LADDER.map(g => {
            const lo = dailyForStep(g, 1)
            const hi = capDaily(g)
            const mine = grade === g
            const [p1, p2, p3] = pitchOf(g)
            return (
              <div key={g}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '2px 5px', borderRadius: 6,
                  background: mine ? '#fff7e6' : 'transparent', outline: mine ? `1.5px solid ${AMBER}` : 'none',
                }}>
                  <span style={{ width: 26, fontSize: 14.2, fontWeight: 800, color: NAVY }}>{g}</span>
                  <span style={{ width: 58, fontSize: 13.5, whiteSpace: 'nowrap' }}>{GRADE_LABELS[g]}</span>
                  <div style={{ flex: 1, minWidth: 40, position: 'relative', height: 12 }}>
                    <div style={{ position: 'absolute', top: 3, height: 6, left: 0, right: 0, background: '#f1f5f9', borderRadius: 999 }} />
                    <div style={{ position: 'absolute', top: 3, height: 6, left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%`, background: mine ? AMBER : g === '5G' || g === '6G' ? NAVY : '#94a3b8', borderRadius: 999 }} />
                  </div>
                  <span style={{ fontSize: 12.1, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: MUTED, whiteSpace: 'nowrap' }}>
                    {yen(lo)}〜<b style={{ color: INK }}>{yen(hi)}</b>
                  </span>
                  <span style={{ fontSize: 10.6, textAlign: 'right', color: MUTED, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{p1}→{p2}→{p3}円</span>
                  {mine && <span style={{ fontSize: 12.1, fontWeight: 800, color: '#b45309', whiteSpace: 'nowrap' }}>あなた</span>}
                </div>
                {g === '5G' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
                    <div style={{ flex: 1, borderTop: `1.5px dashed ${AMBER}` }} />
                    <span style={{ fontSize: 12.1, color: '#b45309', fontWeight: 700 }}>職長の壁：役割に就いて上がる（年数では超えない）</span>
                    <div style={{ width: 16, borderTop: `1.5px dashed ${AMBER}` }} />
                  </div>
                )}
              </div>
            )
          })}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '2px 5px', borderRadius: 6, marginTop: 2,
            background: grade === 'doko' ? '#fff7e6' : 'transparent', outline: grade === 'doko' ? `1.5px solid ${AMBER}` : 'none',
          }}>
            <span style={{ width: 26, fontSize: 14.2, fontWeight: 800, color: NAVY, whiteSpace: 'nowrap' }}>土工</span>
            <span style={{ fontSize: 12.8, color: MUTED, flex: 1 }}>3Gの90%　{yen(dailyForStep('doko', 1))}〜{yen(capDaily('doko'))}</span>
            {grade === 'doko' && <span style={{ fontSize: 12.1, fontWeight: 800, color: '#b45309' }}>あなた</span>}
          </div>
          {/* 逓減のしくみ（2026-09-30 代表依頼）: 同じ等級の中では、号が上がるほど1号あたりの昇給額が小さくなる */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 9px' }}>
            <svg viewBox="0 -8 96 54" style={{ width: 88, height: 48, flexShrink: 0 }} aria-label="逓減">
              {[[0, 100, '1〜25'], [1, 80, '26〜45'], [2, 60, '46〜60']].map(([i, pct, lb]) => {
                const x = 4 + (i as number) * 31
                const h = ((pct as number) / 100) * 30
                return (
                  <g key={i as number}>
                    <rect x={x} y={34 - h} width={26} height={h} rx={2} fill={(i as number) === 0 ? NAVY : (i as number) === 1 ? '#64748b' : '#cbd5e1'} />
                    <text x={x + 13} y={34 - h - 2} textAnchor="middle" fontSize={7} fontWeight={700} fill={INK}>{pct as number}%</text>
                    <text x={x + 13} y={43} textAnchor="middle" fontSize={6.2} fill={MUTED}>{lb as string}号</text>
                  </g>
                )
              })}
            </svg>
            <div style={{ fontSize: 10.9, lineHeight: 1.45 }}>
              <b style={{ color: '#92400e' }}>逓減のしくみ</b>　同じ等級の中では、号が上がるほど1号あたりの昇給額が小さくなります
（26号から8割、46号から6割）。<b>上の等級に上がると、また大きく伸びます。</b>
            </div>
          </div>
          <div style={{ marginTop: 2, fontSize: 11.4, color: MUTED, lineHeight: 1.5 }}>
            昇格に必要な資格　3G：{REQUIRED['3G']}／5G：{REQUIRED['5G']}
          </div>
          {/* 計算例（2026-09-30）: 左の列の下の余白を、いちばん伝わりやすい「具体例」で使う */}
          <div style={{ background: '#f8fafc', border: `1px dashed #cbd5e1`, borderRadius: 8, padding: '6px 9px' }}>
            <div style={{ fontSize: 12.1, fontWeight: 800, color: NAVY, marginBottom: 2 }}>計算例</div>
            <div style={{ fontSize: 12.1, lineHeight: 1.6 }}>
              3G（班長）・{EX.step}号・<b>A評価</b>・{EX.age}歳の人<br />
              評価 +{HYOGO_PITCH.A} ＋ 年齢調整 {EX.agePitch === 0 ? '0' : EX.agePitch} ＝ <b style={{ color: '#b45309' }}>+{EX.total}号</b>
              　→ {EX.step}号 から <b>{EX.newStep}号</b> へ<br />
              日給 {yen(EX.oldDaily)} → <b style={{ color: NAVY }}>{yen(EX.newDaily)}</b>（1日 +{yen(EX.newDaily - EX.oldDaily).slice(1)}円・年 +{yen((EX.newDaily - EX.oldDaily) * TOTAL_PAID_DAYS)}）
            </div>
          </div>
        </Card>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ② 毎年の改定 */}
          <Card n="2" title="毎年10月1日の改定" style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {[
                ['評価', '1〜6'], ['年齢調整', '−4〜+3'], ['特別調整', `±${SPECIAL_CAP}まで`], ['代表加算', '代表の判断'],
              ].map(([t, v], i) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {i > 0 && <span style={{ color: MUTED, fontSize: 17.1 }}>＋</span>}
                  <div style={{ background: '#f1f5f9', borderRadius: 7, padding: '3px 7px', textAlign: 'center' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 800 }}>{t}</div>
                    <div style={{ fontSize: 10.7, color: MUTED }}>{v}</div>
                  </div>
                </div>
              ))}
              <span style={{ color: MUTED, fontSize: 17.1 }}>＝</span>
              <div style={{ background: AMBER, borderRadius: 7, padding: '3px 9px', textAlign: 'center' }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: NAVY }}>上がる号</div>
                <div style={{ fontSize: 10.7, color: NAVY }}>0より下にならない</div>
              </div>
            </div>
            <div style={{ fontSize: 12.1, color: MUTED, marginTop: 5, lineHeight: 1.55 }}>
              新しい号 ＝ 今の号 ＋ 上がる号（{MAX_STEP}号まで）。日給は号俸表のその号の額になります。
              入社6か月未満の人は、翌年の10月から対象です。
            </div>
          </Card>

          {/* ③ 評価 */}
          <Card n="3" title="評価（5段階・基本はA）" style={{ flex: 1.25 }}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', marginTop: 2 }}>
              {hyogoOrder.map(h => {
                const v = HYOGO_PITCH[h]
                return (
                  <div key={h} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 12.8, fontWeight: 800, color: h === 'A' ? NAVY : MUTED }}>+{v}号</div>
                    <div style={{ height: v * 8, background: h === 'A' ? NAVY : '#cbd5e1', borderRadius: '4px 4px 0 0' }} />
                    <div style={{ fontSize: 14.2, fontWeight: 800, marginTop: 1 }}>{h}{h === 'A' && <span style={{ fontSize: 10.7, color: MUTED, fontWeight: 400 }}> 標準</span>}</div>
                  </div>
                )
              })}
            </div>
            <div style={{ fontSize: 12.1, color: MUTED, marginTop: 4, lineHeight: 1.55 }}>
              役割どおりの働きならA。Sを1人出すときはBを1人、SSのときはCを1人、と上下をペアで出して全体をA中心に保ちます。
              S以上・B以下は理由を記録します。Cでも1号は進みます。
            </div>
          </Card>
          {/* ⑥ 年収 */}
          <div style={{ borderRadius: 10, padding: '7px 11px', background: NAVY, color: 'white', fontSize: 12.8, lineHeight: 1.6 }}>
            <b>ベース年収</b> ＝ 日給 ×（稼働{ANNUAL_DAYS}日 ＋ 有給{PAID_LEAVE_DAYS}日）<br />＝ 日給 × {TOTAL_PAID_DAYS}日
            <span style={{ opacity: 0.75, display: 'block', fontSize: 11.3 }}>※ 残業代・手当・賞与は含みません</span>
          </div>
        </div>

        <div style={{ flex: 1.05, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ④ 年齢調整 */}
          <Card n="4" title="年齢調整（号）" style={{ flex: 1.3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.3, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', color: MUTED, fontWeight: 400, padding: '1px 2px' }}></th>
                  {['1G', '2G', '3G', '4G', '5G', '6G'].map((g, ci) => (
                    <th key={g} style={{ padding: '1px 2px', color: ci === ageCol ? '#b45309' : NAVY }}>{g}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ageRows.map((r, ri) => (
                  <tr key={r.band}>
                    <td style={{ padding: '1px 2px', color: ri === ageBandIndex ? '#b45309' : MUTED, fontWeight: ri === ageBandIndex ? 800 : 400, whiteSpace: 'nowrap' }}>{r.band}</td>
                    {r.pitches.map((v, ci) => {
                      const me = ri === ageBandIndex && ci === ageCol
                      return (
                        <td key={ci} style={{
                          textAlign: 'center', padding: '1px 0',
                          background: v > 0 ? '#dcfce7' : v < 0 ? `rgba(239,68,68,${0.08 + Math.abs(v) * 0.07})` : '#f8fafc',
                          outline: me ? `2px solid ${AMBER}` : 'none', fontWeight: me ? 800 : 400,
                        }}>
                          {v > 0 ? `+${v}` : v}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 12.1, color: MUTED, marginTop: 4, lineHeight: 1.55 }}>
              職人としての身体の力を映す調整です。若いうちは加点、年を重ねると減点。班長より上はまとめる力が中心なので影響が小さく、
              職長・上級職長は50歳まで減点しません。
            </div>
          </Card>

          {/* ⑤ 特別調整・代表加算 */}
          <Card n="5" title="特別調整と代表加算" style={{ flex: 1 }}>
            <div style={{ fontSize: 10.6, color: MUTED, marginBottom: 3 }}>特別調整は合計 ±{SPECIAL_CAP} まで</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 0, columnGap: 6, fontSize: 12.1, lineHeight: 1.4 }}>
              {SPECIAL_REASONS.map(r => (
                <FragmentRow key={r.key} label={r.label} pitch={r.pitch} />
              ))}
            </div>
            <div style={{ fontSize: 12.1, color: MUTED, marginTop: 4, lineHeight: 1.55 }}>
              <b style={{ color: INK }}>代表加算</b>は、上の事由に当てはまらない働きを代表の判断で加える枠です。理由は給料表に載せます。
            </div>
          </Card>

        </div>
      </div>
    </div>
  )
}

function FragmentRow({ label, pitch }: { label: string; pitch: number }) {
  return (
    <>
      <span>{label}</span>
      <b style={{ textAlign: 'right', color: pitch > 0 ? '#15803d' : '#b91c1c' }}>{pitch > 0 ? `+${pitch}` : pitch}</b>
    </>
  )
}

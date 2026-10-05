'use client'

/**
 * 賃金分析（代表専用）
 *
 * ベトナム人スタッフの「在籍年数に対して相対的に高い／低い」を複数基準で可視化する。
 * 今後の昇給評価（/evaluation）とは別軸の参考資料。
 *
 * ⚠️ 個人の賃金を一覧するため、代表（workerId=0）以外には表示しない。
 *    データ取得も /api/workers（管理者パスワード必須）経由のみ。
 *    改定の予定・個別事情は /api/wage-analysis/plan（代表だけ）から受け取る。
 *    このファイルの JS はログインなしでも取れるので、個人の時給・事情をここに書かないこと（2026-10-02）。
 *
 * 2026-10-03: 画面の型（PageHeader・カード・下線タブ）にそろえた
 * 2026-10-05: グラフの棒の色（高い＝紺・低い＝赤・ほか＝薄い灰）・文字の大きさ（12px→13px）・「低い／高い」のカード・画面の幅（max-w-7xl）もそろえた
 * 2026-10-05: 残りをそろえた（表の見出しの黒地・全枠線、反映の確認窓とお知らせ、札、補足の文字色）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader, Segment, Chip, RowButton } from '@/components/ui/PageParts'
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  buildWageAnalysis, modelWage, findInversions, stageIQROutliers,
  STAGES, TOKYO_MIN_WAGE, MODEL_RAISE_RATE,
  MARKET_REFERENCE, KENSETSU_TOKUTEI,
  type WageAnalysis, type WageRow, type WageBasis, type WagePlan,
} from '@/lib/wage-analysis'
import {
  curveWage, curveRaiseAt, CURVE_BASE_RAISE, CURVE_DECAY, CURVE_MIN_RAISE,
  MONTHLY_HOURS,
} from '@/lib/wage-curve'
import { hourlyRateOn } from '@/lib/workers'
import { WageMap } from './WageMap'

const OWNER_ID = 0 // 日比靖仁

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const signed = (v: number) => (v >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString()

export default function WageAnalysisPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [rows, setRows] = useState<WageAnalysis | null>(null)
  const [plan, setPlan] = useState<WagePlan | null>(null)
  const [err, setErr] = useState('')
  const [pw, setPw] = useState('')
  // 既定は「改定後」。10月以降どうなるかを見るのが今の主目的のため（2026-08-25 代表指示）
  const [basis, setBasis] = useState<WageBasis>('revised')

  const load = useCallback(async (password: string, b: WageBasis) => {
    {
      try {
        const headers = { 'x-admin-password': password }
        const [res, planRes] = await Promise.all([
          fetch('/api/workers', { headers }),
          fetch('/api/wage-analysis/plan', { headers }),
        ])
        if (!res.ok || !planRes.ok) throw new Error('取得に失敗しました')
        const { workers } = await res.json()
        const wagePlan = await planRes.json() as WagePlan
        const today = new Date()
        const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        const target = (workers as Record<string, unknown>[])
          // 2026-10-02 総合点検・要判断: 賃金カーブは「これから何年も在籍する前提」の分析なので、退職予定（先の日付）の人も外したままにする
          .filter(w => w.visaType && w.visaType !== 'none' && !w.retired && Number(w.hourlyRate) > 0) // retired-ok: 退職予定も分析の対象外
          .map(w => {
            // 2026-09-14: 人員マスタには適用開始日つきで先の改定が入っている。
            //   「現在」は今日時点で有効な額、「改定後」はマスタ登録済みの最新額＋予定表で見る
            const rateInfo = {
              hourlyRate: Number(w.hourlyRate),
              hourlyRateFrom: (w.hourlyRateFrom as string) || undefined,
              prevHourlyRate: w.prevHourlyRate != null ? Number(w.prevHourlyRate) : undefined,
            }
            const sched = Array.isArray(w.scheduledChanges) ? w.scheduledChanges as { field: string; value: string }[] : []
            return {
              id: Number(w.id), name: String(w.name), visaType: String(w.visaType),
              hireDate: String(w.hireDate || ''),
              hourlyRate: hourlyRateOn(rateInfo, todayIso) ?? Number(w.hourlyRate),
              latestHourly: Number(w.hourlyRate),
              nextVisaType: sched.find(c => c.field === 'visa')?.value,
            }
          })
        setPlan(wagePlan)
        setRows(buildWageAnalysis(target, todayIso, 20, b, wagePlan))
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

  if (allowed === null) return <div className="p-6 text-hibi-sub dark:text-gray-400">読み込み中…</div>
  if (!allowed) return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader group="賃金・評価" title="賃金分析" sub="代表だけが見られます" />
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-5">
        <p className="text-sm font-bold text-gray-900 dark:text-white">この画面は代表だけが見られます</p>
        <Link href="/compensation" className="text-sm text-hibi-navy dark:text-blue-300 font-bold mt-3 inline-block">賃金・評価へ戻る</Link>
      </section>
    </div>
  )
  if (err) return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader group="賃金・評価" title="賃金分析" />
      <section role="alert" className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-5">
        <p className="text-sm font-bold text-red-700 dark:text-red-400">読み込めませんでした</p>
        <p className="text-sm text-hibi-sub dark:text-gray-400 mt-1">{err}</p>
        <p className="text-sm text-hibi-sub dark:text-gray-400 mt-1">画面を読み込み直してください。続くときは時間をおいてもう一度お試しください。</p>
      </section>
    </div>
  )
  if (!rows || !plan) return <div className="p-6 text-hibi-sub dark:text-gray-400">集計中…</div>

  return (
    <Report
      a={rows}
      plan={plan}
      onApplied={() => load(pw, basis)}
      pw={pw}
      basis={basis}
      onBasis={setBasis}
    />
  )
}

function Report({ a, plan, onApplied, pw, basis, onBasis }: {
  a: WageAnalysis; plan: WagePlan; onApplied: () => void; pw: string
  basis: WageBasis; onBasis: (b: WageBasis) => void
}) {
  const rows = a.rows
  const lows = rows.filter(r => r.allLow)
  const highs = rows.filter(r => r.allHigh)
  const withCagr = rows.filter(r => r.cagr !== null)
  const avgCagr = withCagr.length ? withCagr.reduce((s, r) => s + r.cagr!, 0) / withCagr.length : 0
  const avgReal = withCagr.length ? withCagr.reduce((s, r) => s + (r.realGain ?? 0), 0) / withCagr.length : 0

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="賃金・評価"
        title={<span className="inline-flex items-center gap-2 flex-wrap">賃金分析<Chip tone="red">代表のみ</Chip></span>}
        sub={`代表だけが見られます。在籍${rows.length}名／東京都最低賃金 現在 ${yen(a.currentMinWage)}。在籍年数に対して相対的に高い・低いを3つの基準で判定しています。今後の昇給評価とは別軸の参考資料です`}
      />

      {/* 分析全体の基準を切り替える。①〜⑨とデータ表のすべてがこの基準で再計算される */}
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-gray-900 dark:text-white">集計の基準</span>
          <Segment value={basis} onChange={onBasis} items={[['revised', '改定後（2026年10月以降）'], ['current', '現在の時給']]} />
        </div>
        <p className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 mt-2 leading-relaxed">
          {basis === 'revised'
            ? <><b>契約済み・予定の改定をすべて反映した時給</b>（{plan.changes.map(c => `${Number(c.effective.slice(5, 7))}/${Number(c.effective.slice(8, 10))} ${c.label}`).join('、')}）で、
              ①〜⑨とデータ表のすべてを計算しています。人員マスタには適用開始日つきで登録済みで、給与計算は各開始日から自動で切り替わります。</>
            : <><b>人員マスタの現在の時給</b>で計算しています。いま給与計算に使われている額です。</>}
        </p>
      </section>

      <RevisionBanner a={a} plan={plan} onApplied={onApplied} pw={pw} />
      <MinWageWatch a={a} />

      <section className="grid sm:grid-cols-2 gap-3">
        <Flag tone="low" title="3基準すべてで低い" items={lows} />
        <Flag tone="high" title="3基準すべてで高い" items={highs} />
      </section>

      <Card title="① 賃金カーブ上の全員の位置（在籍年数 × 時給）" note="緑の線＝賃金カーブ（160円−8円×在籍年数。評価のA＝この線に沿う昇給）。白抜きの丸＝今日の時給、塗りの丸＝改定後（矢印が今回の動き）。丸の色＝在留資格。縦の細線＝カーブとの差（赤＝下回る、青＝上回る）。点にカーソルを合わせる（スマホはタップ）と内訳が出ます。">
        <WageMap a={a} />
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
        note={`事由の異なる改定を分けて表示している。一律の率で決めた改定は、率の決め方を各改定の説明に書いている。月額は所定 ${MONTHLY_HOURS} 時間換算。`}>
        <RevisionTable a={a} plan={plan} />
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

      <details className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
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
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-5">
      <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white mb-1">{title}</h2>
      {note && <p className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 mb-3 leading-relaxed">{note}</p>}
      {children}
    </section>
  )
}

function Flag({ tone, title, items }: { tone: 'low' | 'high'; title: string; items: WageRow[] }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4">
      <div className="flex items-center gap-2">
        <Chip tone={tone === 'low' ? 'red' : 'blue'}>{tone === 'low' ? '低い' : '高い'}</Chip>
        <span className="text-[0.8125rem] font-bold text-hibi-sub dark:text-gray-400">{title}</span>
      </div>
      <div className="text-sm font-bold mt-1 leading-relaxed">
        {items.length
          ? items.map(r => (
            <div key={r.id}>
              {r.name}（{r.years}年 {yen(r.hourly)}）
              {r.context && (
<span className="ml-1"><Chip tone="gray">{r.context.label}</Chip></span>
              )}
            </div>
          ))
          : <span className="text-hibi-sub dark:text-gray-400 font-normal">該当なし</span>}
      </div>
      {items.some(r => r.context) && (
        <div className="text-2xs text-hibi-sub dark:text-gray-400 mt-2 space-y-1 leading-relaxed">
          {items.filter(r => r.context).map(r => (
            <p key={r.id}><b>{r.context!.label}</b>：{r.context!.detail}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function CagrChart({ rows }: { rows: WageRow[] }) {
  const list = rows.filter(r => r.cagr !== null).sort((x, y) => y.cagr! - x.cagr!)
  if (!list.length) return <p className="text-sm text-gray-400">対象者がいません</p>
  const max = Math.max(...list.map(r => r.cagr!)) * 1.1
  return (
    <div className="space-y-1.5">
      {list.map(r => (
        <div key={r.id} className="flex items-center gap-2 text-[0.8125rem]">
          <span className="w-40 shrink-0 text-right text-hibi-sub dark:text-gray-400 truncate">{r.name}</span>
          <span className="w-11 shrink-0 text-right text-gray-400">{r.years}年</span>
          <div className="flex-1 relative h-6">
            <div className={`absolute inset-y-1 left-0 rounded ${r.allLow ? 'bg-red-600 dark:bg-red-500' : r.allHigh ? 'bg-hibi-navy dark:bg-blue-400' : 'bg-gray-300 dark:bg-gray-500'}`}
              style={{ width: `${(r.cagr! / max) * 100}%` }} />
            <div className="absolute inset-y-[9px] left-0 rounded-sm bg-gray-600/70 dark:bg-gray-300/50"
              style={{ width: `${((r.minWageCagr ?? 0) / max) * 100}%` }} />
          </div>
          <span className="w-44 shrink-0 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
            {r.cagr!.toFixed(2)}%
            <span className="text-hibi-sub dark:text-gray-400"> 実質+{(r.realGain ?? 0).toFixed(1)}pt</span>
          </span>
          <span className="w-32 shrink-0 whitespace-nowrap text-right tabular-nums text-hibi-sub dark:text-gray-400">
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
    if (v === null) return <div className="flex-1 text-center text-3xs text-gray-400">同期なし</div>
    const w = Math.min(Math.abs(v) / max, 1) * 50
    return (
      <div className="flex-1 relative h-5">
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-200 dark:bg-gray-700" />
        <div className={`absolute inset-y-1 rounded-sm ${v < -20 ? 'bg-red-600 dark:bg-red-500' : v > 20 ? 'bg-hibi-navy dark:bg-blue-400' : 'bg-gray-300 dark:bg-gray-500'}`}
          style={v < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
        <span className="absolute top-0 text-3xs tabular-nums text-hibi-sub dark:text-gray-400 whitespace-nowrap"
          style={v < 0
            ? { right: `calc(50% + ${w}%)`, paddingRight: 4 }
            : { left: `calc(50% + ${w}%)`, paddingLeft: 4 }}>{signed(v)}</span>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-2 text-2xs text-hibi-sub dark:text-gray-400 font-bold mb-1">
        <span className="w-40 shrink-0" />
        <span className="flex-1 text-center">A 段階内平均</span>
        <span className="flex-1 text-center">B 全体傾向線</span>
        <span className="flex-1 text-center">C 同期</span>
      </div>
      <div className="space-y-1">
        {list.map(r => (
          <div key={r.id} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-right text-[0.8125rem] text-hibi-sub dark:text-gray-400 truncate" title={`${r.years}年 ${yen(r.hourly)}`}>{r.name}</span>
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
      <table className="w-full text-[0.8125rem] border-collapse">
        <thead>
          <tr className="bg-hibi-thead dark:bg-gray-700 text-hibi-sub dark:text-gray-300">
            <th className="border-b border-hibi-line dark:border-gray-700 px-2 py-1.5 text-left">段階</th>
            <th className="border-b border-hibi-line dark:border-gray-700 px-2 py-1.5">在籍</th>
            <th className="border-b border-hibi-line dark:border-gray-700 px-2 py-1.5">人数</th>
            <th className="border-b border-hibi-line dark:border-gray-700 px-2 py-1.5">平均時給</th>
            <th className="border-b border-hibi-line dark:border-gray-700 px-2 py-1.5">前段階からの昇給</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((s, i) => {
            if (!counts[i]) return null
            const prev = [...Array(i).keys()].reverse().find(j => counts[j] > 0)
            const jump = prev !== undefined ? (a.stageAvg[i] / a.stageAvg[prev] - 1) * 100 : null
            return (
              <tr key={s.key}>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5">{s.key}</td>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-center text-hibi-sub dark:text-gray-400">{s.years}</td>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-center">{counts[i]}</td>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums">{yen(a.stageAvg[i])}</td>
                <td className={`border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums font-bold ${jump !== null && jump > 30 ? 'text-hibi-navy dark:text-blue-300' : ''}`}>
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
function RevisionBanner({ a, plan, onApplied, pw }: { a: WageAnalysis; plan: WagePlan; onApplied: () => void; pw: string }) {
  const schedule = plan.changes
  const { changes, pending, annualCost } = a.revision
  const [busy, setBusy] = useState('')
  const todayIso = a.todayIso

  /** その改定で実際に上がる人（すでに予定額以上なら対象外） */
  const pendingRows = (changeId: string) => {
    const c = schedule.find(x => x.id === changeId)
    if (!c) return []
    // 人員マスタに登録済み（適用開始日が先でも）なら対象外。masterHourly で判定する
    return a.rows
      .filter(r => c.targets[r.id] !== undefined && r.masterHourly < c.targets[r.id])
      .map(r => ({ row: r, to: c.targets[r.id] }))
  }

  const apply = async (changeId: string) => {
    const list = pendingRows(changeId)
    const c = schedule.find(x => x.id === changeId)
    if (!list.length || !c) return
    // ⚠️ このボタンは時給・日給だけを書く。固定月給（salary）の人は月給も変わるので、
    //   人員マスタで salary / salaryFrom / prevSalary を別途反映すること（2026-09-14 フォン・タンは直接反映済み）
    // 確認は共通の窓で（2026-10-05。旧: その場に手書きの囲みとボタン）
    const ok = await confirmDialog({
      title: `「${c.label}」を人員マスタへ反映しますか？（${list.length}名）`,
      description: [
        list.map(({ row, to }) => `${row.name}　${yen(row.currentHourly)} → ${yen(to)}（日額 ${yen(row.currentHourly * 7)} → ${yen(to * 7)}）`).join('\n'),
        `変更は記録に残り、取り消しはできません。適用開始日（${c.effective}）より前の月は改定前の時給で計算されます。`
          + (c.effective.slice(-2) !== '01' ? '月の途中が実施日なので、実施月は暦日で按分した時給になります。' : ''),
      ].join('\n'),
      confirmLabel: '反映する',
    })
    if (!ok) return
    setBusy(changeId)
    try {
      for (const { row, to } of list) {
        const res = await fetch('/api/workers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
          body: JSON.stringify({
            action: 'update', id: row.id,
            hourlyRate: to,
            rate: to * 7, // 所定7時間。日額表示を時給と揃える
            // 2026-09-10 追加: 適用開始日と改定前の時給。給与計算は月ごとに
            //   「その月に適用される時給」を使う（月途中は暦日按分）ので、
            //   実施日より前に反映しても前月分・当月の実施日前が新時給にならない
            hourlyRateFrom: c!.effective,
            prevHourlyRate: row.currentHourly,
            rateFrom: c!.effective,
            prevRate: row.currentHourly * 7,
          }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          // 途中まで反映された分は残る（もう一度押すと残りの人だけ反映する）
          notify.failed(`${row.name} さんの反映`, j.error || 'サーバが受け付けませんでした', 'もう一度「人員マスタへ反映」を押すと、残りの人だけ反映します')
          onApplied()
          return
        }
      }
      notify.success(`${list.length}名の時給を人員マスタへ反映しました`)
      onApplied()
    } catch (e) {
      notify.failed('反映', e)
      onApplied()
    } finally {
      setBusy('')
    }
  }

  if (!changes.length) return null
  const done = pending === 0
  const box = done
    ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20'
    : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'
  return (
    <section className={`rounded-xl border px-5 py-4 ${box}`}>
      <div className="text-[0.9375rem] font-bold mb-2">予定されている賃金改定</div>
      <div className="space-y-1.5">
        {changes.map(c => (
          <div key={c.id} className="text-sm leading-relaxed">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="tabular-nums text-hibi-sub dark:text-gray-400">{c.effective}</span>
              <span className="font-bold">{c.label}</span>
              <span className="text-hibi-sub dark:text-gray-400">
                {c.rate ? `一律 ${(c.rate * 100).toFixed(3)}％・` : ''}{c.count}名
              </span>
              <Chip tone={c.pending === 0 ? 'green' : 'amber'}>{c.pending === 0 ? '反映済み' : `未反映 ${c.pending}名`}</Chip>
              <span className="text-hibi-sub dark:text-gray-400 tabular-nums">年 +{yen(c.annualCost)}</span>
              {c.pending > 0 && (
                c.effective <= todayIso ? (
                  <RowButton tone="main" busy={busy === c.id} busyLabel="反映しています" disabled={busy !== ''} onClick={() => apply(c.id)}>人員マスタへ反映</RowButton>
                ) : (
                  <span className="text-2xs text-hibi-sub dark:text-gray-400">実施日になると反映ボタンが出ます</span>
                )
              )}
            </div>
            <div className="text-hibi-sub dark:text-gray-400 pl-1">{c.reason}</div>
          </div>
        ))}
      </div>
      <p className="text-[0.8125rem] text-gray-600 dark:text-gray-300 mt-2 pt-2 border-t border-gray-300/60 dark:border-gray-600/60 leading-relaxed">
        {done
          ? 'すべて人員マスタに反映済み（適用開始日つき。給与計算は各開始日から自動で切り替わります）。'
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
  // 2026-09-14: 次の改定額が公示済み（TOKYO_MIN_WAGE に先の行がある）ならその額で判定する
  const nextRow = hist.find(m => m.from > a.todayIso)
  const projected = nextRow ? nextRow.yen : Math.round(mw * (1 + lastRate))

  // 現時点で最賃を下回っている人（あってはならない）
  const under = a.rows.filter(r => r.currentHourly < mw)
  // 次の改定で下回りうる人
  const atRisk = a.rows.filter(r => r.currentHourly >= mw && r.revised < projected)
  // 特定技能1号の報酬下限（最賃×1.1）
  const tokuteiFloorNext = nextRow ? nextRow.yen * 1.1 : a.tokuteiFloor
  const tokuteiNg = a.rows.filter(r => r.visa.startsWith('特定') && r.revised < tokuteiFloorNext)

  if (!under.length && !atRisk.length && !tokuteiNg.length) return null

  const tone = under.length || tokuteiNg.length
    ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
    : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'

  return (
    <section className={`rounded-xl border px-5 py-4 ${tone}`}>
      <div className="text-sm font-bold">最低賃金の確認</div>
      <div className="text-[0.8125rem] text-gray-600 dark:text-gray-300 mt-1.5 space-y-1.5 leading-relaxed">
        {under.length > 0 && (
          <p className="text-red-700 dark:text-red-300">
            <b>現行の最低賃金 {yen(mw)} を下回っています（法令違反）</b>：
            {under.map(r => `${r.name} ${yen(r.currentHourly)}`).join('／')}
          </p>
        )}
        {tokuteiNg.length > 0 && (
          <p className="text-red-700 dark:text-red-300">
            <b>特定技能の報酬下限 {yen(tokuteiFloorNext)}（最賃×1.1）を下回っています</b>：
            {tokuteiNg.map(r => `${r.name} ${yen(r.revised)}`).join('／')}
          </p>
        )}
        {atRisk.length > 0 && (
          <p>
            {nextRow
              ? <><b>{nextRow.from} の最賃改定（{yen(nextRow.yen)}・公示済み）を下回ります。</b>
                改定後の時給で下回るのは {atRisk.map(r => `${r.name} ${yen(r.revised)}`).join('／')}。</>
              : <><b>次の最賃改定で下回る可能性があります。</b>
                直近の改定率 {(lastRate * 100).toFixed(1)}％（{yen(hist[hist.length - 2].yen)} → {yen(mw)}）が
                もう一度あると最賃は <b>{yen(projected)}</b> になります。これを下回るのは
                {atRisk.map(r => `${r.name} ${yen(r.revised)}`).join('／')}。</>}
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
            <text x={ML - 8} y={py(t) + 4} textAnchor="end" className="fill-gray-400 text-2xs">{yen(t)}</text>
          </g>
        ))}

        {/* 節目の縦線 */}
        {MILESTONES.map(m => (
          <g key={m.y}>
            <line x1={px(m.y)} y1={MT} x2={px(m.y)} y2={MT + PH} stroke="currentColor"
              className="text-gray-300 dark:text-gray-600" strokeWidth={1} strokeDasharray="3 4" />
            <text x={px(m.y)} y={MT - 4} textAnchor="middle" className="fill-gray-400 text-3xs">{m.label}</text>
          </g>
        ))}

        {/* 特定技能1号の報酬下限（最賃×1.1）。法令の余裕が見える */}
        <line x1={ML} y1={py(floor)} x2={ML + PW} y2={py(floor)} stroke="currentColor"
          className="text-amber-500" strokeWidth={1.5} strokeDasharray="8 4" />
        <text x={ML + PW + 6} y={py(floor) + 4} className="fill-amber-600 dark:fill-amber-400 text-3xs">
          特定技能下限
        </text>

        {/* 旧7%複利（比較） */}
        <path d={line(oldAt)} fill="none" stroke="currentColor" strokeWidth={1.8}
          className="text-gray-400" strokeDasharray="5 5" />
        <text x={ML + PW + 6} y={py(oldAt(YEARS)) + 4} className="fill-gray-400 text-3xs">旧7%複利</text>

        {/* 現行カーブ */}
        <path d={line(curveAt)} fill="none" stroke="currentColor" strokeWidth={3}
          className="text-emerald-600 dark:text-emerald-400" />
        <text x={ML + PW + 6} y={py(curveAt(YEARS)) + 4}
          className="fill-emerald-600 dark:fill-emerald-400 text-2xs font-bold">カーブ</text>

        {/* 整数年の点＋節目の金額 */}
        {Array.from({ length: YEARS + 1 }, (_, i) => i).map(i => (
          <g key={i}>
            <circle cx={px(i)} cy={py(curveAt(i))} r={3}
              className="fill-emerald-600 dark:fill-emerald-400" />
            {(i === 0 || i === 3 || i === 5 || i === 10 || i === 15) && (
              <text x={px(i)} y={py(curveAt(i)) - 10} textAnchor="middle"
                className="fill-emerald-700 dark:fill-emerald-300 text-3xs font-bold">{yen(curveAt(i))}</text>
            )}
          </g>
        ))}

        {/* 在籍者を重ねる。カーブのどちら側にいるかが一目で分かる */}
        {a.rows.filter(r => r.years <= YEARS).map(r => (
          <circle key={r.id} cx={px(r.years)} cy={py(r.hourly)} r={4.5}
            className={r.devCurve < -20 ? 'fill-red-600 dark:fill-red-400' : r.devCurve > 20 ? 'fill-hibi-navy dark:fill-blue-300' : 'fill-gray-400'}
            stroke="white" strokeWidth={1.2}>
            <title>{`${r.name}（${r.years}年 ${yen(r.hourly)}・カーブとの差 ${signed(r.devCurve)}）`}</title>
          </circle>
        ))}

        {/* X軸ラベル */}
        {Array.from({ length: YEARS + 1 }, (_, i) => i).filter(i => i % 5 === 0 || i === 3).map(i => (
          <text key={i} x={px(i)} y={MT + PH + 18} textAnchor="middle" className="fill-gray-400 text-2xs">{i}年</text>
        ))}

        {/* 下段: 昇給額の逓減 */}
        <text x={ML - 8} y={BT + 12} textAnchor="end" className="fill-gray-400 text-2xs">昇給額</text>
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
                <text x={px(i + 0.5)} y={BT + BH + 13} textAnchor="middle" className="fill-gray-500 text-3xs">+{v}</text>
              )}
            </g>
          )
        })}
      </svg>
      <p className="text-2xs text-gray-400 mt-1 leading-relaxed">
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
  const th = 'border-b border-hibi-line dark:border-gray-700 px-2 py-1.5'
  const td = 'border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const max = curveWage(a.curveStart, 15)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.8125rem] border-collapse">
        <thead>
          <tr className="bg-hibi-thead dark:bg-gray-700 text-hibi-sub dark:text-gray-300">
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
              <tr key={n} className={mark ? 'bg-hibi-active dark:bg-blue-900/20' : ''}>
                <td className={td}>{n}年</td>
                <td className={td}>{n ? '+' + yen(curveRaiseAt(n - 1)) : '—'}</td>
                <td className={`${td} font-bold`}>{yen(v)}</td>
                <td className={td}>{yen(v * MONTHLY_HOURS)}</td>
                <td className={td}>{(v / a.curveStart).toFixed(2)}倍</td>
                <td className={`${td} text-gray-400`}>{yen(old)}<span className="ml-1 text-3xs">{signed(v - old)}</span></td>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5">
                  <div className="h-3 rounded bg-hibi-navy dark:bg-blue-400" style={{ width: `${(v / max) * 100}%` }} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-2xs text-gray-400 pt-2 leading-relaxed">
        青帯は制度上の節目（入社／実習3号へ／特定技能へ／10年）。
        複利より若手が厚く、6年目以降は薄くなる。ベテランの処遇は賃金カーブではなく
        役割手当（職長・班長手当、特定技能2号の処遇、賞与）で対応する方針。
      </p>
      {a.entryWage !== null && a.entryWage !== a.curveStart && (
        <p className="text-2xs text-amber-700 dark:text-amber-400 pt-1.5 leading-relaxed">
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
          <div key={r.id} className="flex items-center gap-2 text-[0.8125rem]">
            <span className="w-40 shrink-0 text-right text-hibi-sub dark:text-gray-400 truncate">
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
              <div className={`absolute inset-y-1 rounded-sm ${over ? 'bg-hibi-navy dark:bg-blue-400' : under ? 'bg-red-600 dark:bg-red-500' : 'bg-gray-300 dark:bg-gray-500'}`}
                style={pos(r.devCurveRevised, wRev)} />
              <span className="absolute top-0 text-3xs tabular-nums text-hibi-sub dark:text-gray-400 whitespace-nowrap"
                style={r.devCurveRevised < 0
                  ? { right: `calc(50% + ${wRev}%)`, paddingRight: 4 }
                  : { left: `calc(50% + ${wRev}%)`, paddingLeft: 4 }}>
                {signed(r.devCurveRevised)}
              </span>
            </div>
          </div>
        )
      })}
      <p className="text-2xs text-gray-400 pt-2 leading-relaxed">
        左から 氏名／在籍／時給（★は改定後）／カーブ上の時給／差。
        薄い灰の帯は改定前の位置なので、帯が縮んだ分だけカーブに近づいたことになる。
      </p>
    </div>
  )
}

/** 賃金改定の明細。事由ごとに表を分け、前後比較と積み残しを示す。 */
function RevisionTable({ a, plan }: { a: WageAnalysis; plan: WagePlan }) {
  const schedule = plan.changes
  const th = 'border-b border-hibi-line dark:border-gray-700 px-2 py-1.5'
  const td = 'border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const tl = 'border-b border-gray-100 dark:border-gray-700 px-2 py-1.5'

  // 改定してもなおカーブに届かない人
  const stillUnder = a.rows.filter(r => r.revisionTarget && r.devCurveRevised < -20)
  // 対象外なのにカーブを下回る人（今回の見直しから漏れていないかの確認）
  const outsideUnder = a.rows.filter(r => !r.revisionTarget && r.devCurve < -20)

  return (
    <div className="space-y-5">
      {a.revision.changes.map(c => {
        const change = schedule.find(x => x.id === c.id)!
        // この改定の直前に確定している額（先行する改定があればその額）
        // 「改定前」は basis に左右されないよう、常にマスタの現在値から積む
        const priorOf = (id: number, current: number) => schedule
          .slice(0, schedule.indexOf(change))
          .reduce((v, p) => Math.max(v, p.targets[id] ?? 0), current)
        const list = a.rows
          .filter(r => change.targets[r.id] !== undefined)
          .sort((x, y) => (change.targets[y.id]) - (change.targets[x.id]))
        if (!list.length) return null
        const sum = (f: (r: WageRow) => number) => list.reduce((s, r) => s + f(r), 0)
        const gainOf = (r: WageRow) => change.targets[r.id] - priorOf(r.id, r.currentHourly)
        return (
          <div key={c.id}>
            <div className="text-[0.8125rem] font-bold mb-1">
              {c.effective}　{c.label}
              {c.rate ? `（一律 ${(c.rate * 100).toFixed(3)}％）` : ''}・{list.length}名
            </div>
            <p className="text-2xs text-hibi-sub dark:text-gray-400 mb-1.5 leading-relaxed">{c.reason}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[0.8125rem] border-collapse">
                <thead>
                  <tr className="bg-hibi-thead dark:bg-gray-700 text-hibi-sub dark:text-gray-300">
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
                        <td className={`${tl} text-hibi-sub dark:text-gray-400`}>{r.visa}</td>
                        <td className={td}>{r.years}年</td>
                        <td className={`${td} text-hibi-sub dark:text-gray-400`}>{yen(before)}</td>
                        <td className={`${td} font-bold`}>{yen(after)}</td>
                        <td className={td}>+{yen(after - before)}</td>
                        <td className={td}>+{yen((after - before) * MONTHLY_HOURS)}</td>
                        <td className={td}>{yen(after * MONTHLY_HOURS)}</td>
                        <td className={`${td} ${after - r.curve < -20 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
                          {signed(after - r.curve)}
                          <span className="ml-1 text-3xs text-gray-400">（改定前 {signed(before - r.curve)}）</span>
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-hibi-active dark:bg-blue-900/20 font-bold">
                    <td className={tl} colSpan={3}>合計 {list.length}名</td>
                    <td className={td}>—</td><td className={td}>—</td>
                    <td className={td}>+{yen(sum(gainOf))}</td>
                    <td className={td}>+{yen(sum(r => gainOf(r) * MONTHLY_HOURS))}</td>
                    <td className={td}>{yen(sum(r => change.targets[r.id] * MONTHLY_HOURS))}</td>
                    <td className={`${td} text-hibi-sub dark:text-gray-400`}>年 +{yen(c.annualCost)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="text-[0.8125rem] space-y-2 leading-relaxed">
        {stillUnder.length > 0 && (
          <div className="rounded-xl border border-hibi-line dark:border-gray-700 bg-hibi-bg dark:bg-gray-800/50 px-4 py-3">
            <div className="font-bold mb-1">改定後もカーブに届かない人</div>
            <p className="text-gray-600 dark:text-gray-300">
              {stillUnder.map(r => `${r.name} ${signed(r.devCurveRevised)}`).join('／')}。
              一律の率での引き上げも、契約どおりの改定も、カーブとの差は縮むが揃いはしない。
              揃えるには個別に額で合わせる必要があり、それは評価（/evaluation）の議論になる。
              ラン コン ラップの差は言語面・出勤状況による評価差の反映として意図的に残しているもの。
            </p>
          </div>
        )}
        {outsideUnder.length > 0 && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
            <div className="font-bold mb-1">今回の対象外だが、カーブを下回っている人</div>
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
  const th = 'border-b border-hibi-line dark:border-gray-700 px-2 py-1.5'
  const td = 'border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[0.8125rem] font-bold mb-1">市場水準（月額）</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[0.8125rem] border-collapse">
            <thead>
              <tr className="bg-hibi-thead dark:bg-gray-700 text-hibi-sub dark:text-gray-300">
                <th className={`${th} text-left`}>区分</th><th className={th}>月額</th>
                <th className={th}>時給換算(140h)</th><th className={`${th} text-left`}>出典</th>
              </tr>
            </thead>
            <tbody>
              {MARKET_REFERENCE.map(m => (
                <tr key={m.label}>
                  <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5">{m.label}</td>
                  <td className={td}>{yen(m.monthly)}</td>
                  <td className={td}>{yen(m.monthly / 140)}</td>
                  <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-hibi-sub dark:text-gray-400">{m.note}</td>
                </tr>
              ))}
              <tr className="bg-hibi-active dark:bg-blue-900/20 font-bold">
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5">自社 平均</td>
                <td className={td}>{yen(a.overallAvg * 140)}</td>
                <td className={td}>{yen(a.overallAvg)}</td>
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-hibi-sub dark:text-gray-400">在籍{a.rows.length}名</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-[0.8125rem] leading-relaxed">
        <div className="font-bold mb-1">建設分野 特定技能1号の法令要件</div>
        <p className="text-gray-600 dark:text-gray-300">出典: {KENSETSU_TOKUTEI.source}</p>
        <ul className="mt-2 space-y-1.5 text-gray-700 dark:text-gray-200">
          <li>
            <b>① 報酬の下限</b>：所定内賃金 ÷ 月所定労働時間 ≧ 地域別最低賃金 × {KENSETSU_TOKUTEI.minWageMultiplier}
            <span className="block text-hibi-sub dark:text-gray-400">
              東京都 {yen(a.currentMinWage)} × {KENSETSU_TOKUTEI.minWageMultiplier} = <b>{yen(a.tokuteiFloor)}／時</b>。
              {ng.length === 0
                ? <>特定技能{tokutei.length}名は<b className="text-green-700 dark:text-green-400">全員クリア</b>（最も近いのは {nearest?.name} {yen(nearest?.hourly ?? 0)}・下限比 {((nearest?.hourly ?? 0) / a.tokuteiFloor).toFixed(2)}倍）。</>
                : <b className="text-red-600"> {ng.map(r => r.name).join('・')} が下限割れ。要是正。</b>}
            </span>
          </li>
          <li>
            <b>② 定期昇給が必須</b>：年間の月額所定内賃金の上昇が {yen(KENSETSU_TOKUTEI.minAnnualRaiseMonthly)} 未満だと定期昇給と認められない
            <span className="block text-hibi-sub dark:text-gray-400">
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
      <div className="bg-hibi-bg dark:bg-gray-800/50 rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-3 text-[0.8125rem] leading-relaxed">
        在籍差0.3年超の全 {inv.concordant + inv.discordant} ペア中、逆転は
        <b> {inv.discordant} ペア</b>（順位一致率 {tauPct.toFixed(1)}%・Kendall τ = {inv.tau.toFixed(2)}）。
        {inv.tau >= 0.8
          ? ' τ が 0.8 以上なので、全体としては「長く働くほど高い」が保たれている。'
          : ' τ が 0.8 を下回っており、年功と時給の対応が崩れ始めている。'}
        {revChanged && (
          <div className="mt-1.5 text-hibi-sub dark:text-gray-400">
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
        <div className="text-[0.8125rem] font-bold mb-1">逆転ペア（在籍が長いのに時給が低い）</div>
        {inv.pairs.length === 0 ? (
          <p className="text-[0.8125rem] text-gray-400">なし</p>
        ) : (
          <div className="space-y-1">
            {inv.pairs.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-[0.8125rem]">
                <span className="w-56 shrink-0 text-right text-red-600 dark:text-red-400">
                  {p.senior.name}{p.senior.context && <span className="text-hibi-sub dark:text-gray-400" title={p.senior.context.detail}>（{p.senior.context.label}）</span>}
                  （{p.senior.years}年 {yen(p.senior.hourly)}）
                </span>
                <span className="text-gray-400">＜</span>
                <span className="w-56 shrink-0 text-hibi-navy dark:text-blue-300">
                  {p.junior.name}（{p.junior.years}年 {yen(p.junior.hourly)}）
                </span>
                <span className="tabular-nums text-hibi-sub dark:text-gray-400">差 {yen(p.gap)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-[0.8125rem] font-bold mb-1">段階内の外れ値（IQR法・3名以上の段階のみ）</div>
        {outliers.length === 0 ? (
          <p className="text-[0.8125rem] text-gray-400">なし</p>
        ) : (
          <div className="space-y-1 text-[0.8125rem]">
            {outliers.map(o => (
              <div key={o.stage}>
                <span className="text-hibi-sub dark:text-gray-400">{STAGES[o.stage].key}（Q1 {yen(o.q1)}〜Q3 {yen(o.q3)}）: </span>
                {o.high.map(r => (
                  <span key={r.id} className="text-hibi-navy dark:text-blue-300 font-bold mr-2">↑ {r.name} {yen(r.hourly)}</span>
                ))}
                {o.low.map(r => (
                  <span key={r.id} className="text-red-600 dark:text-red-400 font-bold mr-2">↓ {r.name} {yen(r.hourly)}</span>
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
  const th = 'border-b border-hibi-line dark:border-gray-700 px-2 py-1.5'
  const td = 'border-b border-gray-100 dark:border-gray-700 px-2 py-1.5 text-right tabular-nums'
  const cls = (v: number | null) => v === null ? '' : v < -a.threshold ? 'text-red-600 dark:text-red-400 font-bold' : v > a.threshold ? 'text-hibi-navy dark:text-blue-300 font-bold' : ''
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-5">
      <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white mb-3">データ</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-[0.8125rem] border-collapse">
          <thead>
            <tr className="bg-hibi-thead dark:bg-gray-700 text-hibi-sub dark:text-gray-300 font-bold">
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
                <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1.5">
                  {r.name}
                  {r.stageException && <span className="text-amber-600 ml-1" title={r.context?.detail ?? '在留資格と制度上の段階が一致しない'}>※</span>}
                  {r.context && <span className="text-hibi-sub dark:text-gray-400 ml-1" title={r.context.detail}>（{r.context.label}）</span>}
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
      <p className="text-2xs text-gray-400 mt-2">
        ※ 印＝在留資格と制度上の段階が一致しない人（試験不合格による早期移行など）。段階は在籍年数を優先。<br />
        {a.basis === 'revised'
          ? '「時給」は改定後の額。「現在（マスタ）」は人員マスタの現在値で、まだ書き換えていないため給与計算はこちらで動いている。'
          : '「時給」は人員マスタの現在値。「改定後」は予定を織り込んだ額（対象外は「—」）。'}
        「差」は「時給」とカーブ上の時給の差。
      </p>
    </section>
  )
}

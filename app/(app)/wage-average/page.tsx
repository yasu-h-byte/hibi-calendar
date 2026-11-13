'use client'
/**
 * 平均日給の推移（2026-11-14 代表「個々人の給与は毎年上がるけど、全体平均は新たな採用でキープする。その指標として把握したい」）。
 *
 * - 上: 今の平均（全体・日本人・外国人）と目標
 * - ① 推移: 毎月1日時点の基本単価の平均と目標線
 * - ② 内訳: 1年前からの差を「辞めた人・続けている人の昇給・新しく入った人」に分ける
 * - ③ 先読み: 来年度の昇給を入れたあと、平均を目標に保つのに必要な採用人数
 *
 * 決まりは lib/avg-wage.ts、データは /api/wage-average（給与を見られる3人＝pay.view だけ）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { notify } from '@/lib/notify'
import { PageHeader, Segment } from '@/components/ui/PageParts'
import { requiredHires, type AvgWageView, type WageGroup } from '@/lib/avg-wage'
import { TrendChart, TrendLegend, WaterfallChart, RaiseChart, RaiseLine, yenRound, signedYen, ymLabel } from './AvgWageCharts'

type Org = 'all' | 'hibi' | 'hfu'
type Group = 'all' | WageGroup
const GROUP_LABEL: Record<Group, string> = { all: '全体', jp: '日本人', foreign: '外国人' }
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 px-4 py-3">
      <div className="text-xs text-hibi-sub dark:text-gray-400">{label}</div>
      <div className="text-xl font-bold text-gray-900 dark:text-white tabular-nums mt-0.5">{value}</div>
      {sub && <div className={`text-xs tabular-nums mt-0.5 ${tone === 'up' ? 'text-red-600 dark:text-red-400' : tone === 'down' ? 'text-sky-700 dark:text-sky-400' : 'text-hibi-sub dark:text-gray-400'}`}>{sub}</div>}
    </div>
  )
}

function Section({ title, sub, actions, children }: { title: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 p-4 md:p-5">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
        <div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white">{title}</h2>
          {sub && <p className="text-xs text-hibi-sub dark:text-gray-400 mt-0.5">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

function NumberField({ label, value, onChange, step = 100, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-hibi-sub dark:text-gray-400">
      {label}
      <span className="flex items-center gap-1.5">
        <input type="number" inputMode="numeric" step={step} value={Number.isFinite(value) ? value : 0}
          onChange={e => onChange(Number(e.target.value))}
          className="w-32 h-9 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2.5 text-sm text-gray-900 dark:text-gray-100 tabular-nums text-right" />
        <span className="text-sm text-gray-700 dark:text-gray-300">{suffix}</span>
      </span>
    </label>
  )
}

export default function WageAveragePage() {
  const { password, ready } = useAuthPassword()
  const [view, setView] = useState<AvgWageView | null>(null)
  const [loading, setLoading] = useState(true)
  const [org, setOrg] = useState<Org>('all')
  const [monthly, setMonthly] = useState<'in' | 'out'>('in')
  const [group, setGroup] = useState<Group>('all')
  const [targetYm, setTargetYm] = useState<string>('')
  // ② の比べ方: 0〜 = 1年前との比較の一覧の何番目か ／ -1 = 2つの月を自分で選ぶ（pairFrom → pairTo）
  const [cmpIdx, setCmpIdx] = useState(0)
  const [pairFrom, setPairFrom] = useState('')
  const [pairTo, setPairTo] = useState('')
  // ④ の入力（空 = 記録から出した初期値を使う）
  const [targetIn, setTargetIn] = useState<number | null>(null)
  const [raiseIn, setRaiseIn] = useState<number | null>(null)
  const [entryIn, setEntryIn] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const q = new URLSearchParams({ org, monthly: monthly === 'in' ? '1' : '0' })
      if (cmpIdx === -1 && pairFrom && pairTo) { q.set('from', pairFrom); q.set('to', pairTo) }
      const r = await fetchWithAuth(`/api/wage-average?${q}`, { password })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('読み込み', j?.error || 'サーバが受け付けませんでした'); return }
      setView(j as AvgWageView)
    } catch (e) { notify.failed('読み込み', e) } finally { setLoading(false) }
    // 2つの月を自分で選んでいるときだけ、選び直しで読み直す
  }, [password, org, monthly, cmpIdx === -1 ? pairFrom : '', cmpIdx === -1 ? pairTo : ''])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready) load() }, [ready, load])

  const points = useMemo(() => view?.points ?? [], [view])
  const latest = points[points.length - 1]
  // 目標の初期値: 全体の平均が出る最初の10月の点（日本人の年次改定の時点）。無ければ全体の出る最初の点
  //   資料の点（日本人だけ）は全体が出ないので選ばない
  const defaultTargetYm = useMemo(() => {
    const withAll = points.filter(p => p.all.avg !== null)
    return withAll.find(p => p.ym.endsWith('10'))?.ym ?? withAll[0]?.ym ?? points[0]?.ym ?? ''
  }, [points])
  const sourceOf = useMemo(() => new Map(points.map(p => [p.ym, p.source])), [points])
  const cmpLabel = (ym: string) => `${ymLabel(ym)}${sourceOf.get(ym) === 'document' ? '【資料から】' : ''}`
  const tYm = targetYm && points.some(p => p.ym === targetYm) ? targetYm : defaultTargetYm
  const targetPoint = points.find(p => p.ym === tYm)
  const targetOf = (g: Group) => targetPoint?.[g].avg ?? null
  const yearAgo = latest ? points.find(p => p.ym === `${Number(latest.ym.slice(0, 4)) - 1}${latest.ym.slice(4)}`) : undefined
  const cmp = cmpIdx === -1 ? (view?.custom ?? null) : (view?.comparisons[cmpIdx] ?? view?.comparisons[0] ?? null)
  // 2つの月を選ぶ: 初めて選ぶときは、最新の点とその1つ前（例: 2026年9月 → 10月で10月の改定だけを見る）
  const startPair = () => {
    if (!pairFrom || !pairTo) {
      setPairFrom(points[points.length - 2]?.ym ?? '')
      setPairTo(points[points.length - 1]?.ym ?? '')
    }
    setCmpIdx(-1)
  }
  const dec = cmp ? cmp[group] : null

  // ④ 平均を保つのに必要な採用
  const nowStat = latest?.[group]
  const tDefault = Math.round(targetOf(group) ?? nowStat?.avg ?? 0)
  const raiseDefault = Math.round(dec?.raisePerStayer ?? 0)
  const entryDefault = Math.round(dec?.joinerAvg ?? (group === 'jp' ? (nowStat?.min ?? 0) : (latest?.foreign.min ?? 0)))
  const tVal = targetIn ?? tDefault
  const raiseVal = raiseIn ?? raiseDefault
  const entryVal = entryIn ?? entryDefault
  const need = nowStat && nowStat.avg !== null
    ? requiredHires({ n: nowStat.n, avgNow: nowStat.avg, raisePerPerson: raiseVal, target: tVal, entryDaily: entryVal })
    : null
  const resetInputs = () => { setTargetIn(null); setRaiseIn(null); setEntryIn(null) }

  const diffCard = (g: Group) => {
    const now = latest?.[g].avg
    const base = yearAgo?.[g].avg
    if (now == null) return { value: '—', sub: undefined }
    return {
      value: yenRound(now),
      sub: `${latest[g].n}人${base != null ? `・1年前から ${signedYen(now - base)}` : ''}`,
      tone: base != null ? (now - base > 0 ? 'up' as const : now - base < 0 ? 'down' as const : undefined) : undefined,
    }
  }
  const allTarget = targetOf('all')
  const overTarget = latest?.all.avg != null && allTarget != null ? latest.all.avg - allTarget : null

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHeader group="賃金・評価" title="平均日給の推移"
        sub="その月の1日時点の基本単価（日額・時給×7時間・月給）を1日あたりにそろえた平均です。手当・割増・出勤日数は入れません。役員・事務は数えません。" />

      <div className="flex flex-wrap items-center gap-3">
        <Segment value={org} onChange={setOrg} items={[['all', '全社'], ['hibi', '日比建設'], ['hfu', 'HFU']]} />
        <Segment value={monthly} onChange={setMonthly} items={[['in', '月給の人も入れる'], ['out', '月給の人を外す']]} />
        {loading && <span className="text-xs text-hibi-sub">読み込んでいます…</span>}
      </div>

      {latest && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['all', 'jp', 'foreign'] as const).map(g => {
            const c = diffCard(g)
            return <Card key={g} label={`${GROUP_LABEL[g]}（${ymLabel(latest.ym)}1日）`} value={c.value} sub={c.sub} tone={c.tone} />
          })}
          <Card label={`目標（${tYm ? ymLabel(tYm) : '—'}の全体の平均）`} value={allTarget != null ? yenRound(allTarget) : '—'}
            sub={overTarget != null ? `今は目標より ${signedYen(overTarget)}` : undefined}
            tone={overTarget != null ? (overTarget > 0 ? 'up' : overTarget < 0 ? 'down' : undefined) : undefined} />
        </div>
      )}

      <Section title="① 平均日給の推移" sub="毎月1日時点。白抜きの点は、記録を始める前の月を人員マスタの「1つ前の単価」からさかのぼって出した参考値です。四角の点は給料解説書（毎年10月1日の確定日給）から取り込んだ日本人の点です。外国人の資料が無い年は、全体の平均を出していません。"
        actions={points.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-hibi-sub dark:text-gray-400">目標にする月
            <select value={tYm} onChange={e => { setTargetYm(e.target.value); setTargetIn(null) }}
              className="h-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-gray-100">
              {points.filter(p => p.all.avg !== null).map(p => <option key={p.ym} value={p.ym}>{ymLabel(p.ym)}</option>)}
            </select>
          </label>
        )}>
        <TrendLegend showTarget={allTarget != null} />
        <div className="mt-2"><TrendChart points={points} target={allTarget} /></div>
        {latest && (
          <p className="text-xs text-hibi-sub dark:text-gray-400 mt-2 tabular-nums">
            全体のうち外国人の割合: {yearAgo ? `${pct(yearAgo.foreignShare)} → ` : ''}{pct(latest.foreignShare)}
            （外国人の割合が上がると、全体の平均は下がります）
          </p>
        )}
      </Section>

      <Section title="② 平均が動いた理由"
        sub="前の点から、辞めた人を抜き → 続けている人が昇給し → 新しく入った人を足すと、今の点になります。日本人と外国人の比率の変化は「辞めた人」「入った人」に含まれます。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segment value={group} onChange={g => { setGroup(g); resetInputs() }} items={[['all', '全体'], ['jp', '日本人'], ['foreign', '外国人']]} />
            {view && points.length > 1 && (
              <select value={cmpIdx} onChange={e => { const v = Number(e.target.value); if (v === -1) startPair(); else setCmpIdx(v); resetInputs() }}
                aria-label="比べる2つの点"
                className="h-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-gray-100">
                {view.comparisons.map((c, i) => <option key={c.from + c.to} value={i}>{cmpLabel(c.from)} → {cmpLabel(c.to)}</option>)}
                <option value={-1}>月を選んで比べる…</option>
              </select>
            )}
            {cmpIdx === -1 && (
              <span className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <select value={pairFrom} onChange={e => { setPairFrom(e.target.value); if (pairTo && e.target.value >= pairTo) setPairTo(''); resetInputs() }}
                  aria-label="比べる前の月"
                  className="h-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-gray-100">
                  {points.slice(0, -1).map(p => <option key={p.ym} value={p.ym}>{cmpLabel(p.ym)}</option>)}
                </select>
                →
                <select value={pairTo} onChange={e => { setPairTo(e.target.value); resetInputs() }}
                  aria-label="比べる後の月"
                  className="h-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-gray-100">
                  {!pairTo && <option value="">選んでください</option>}
                  {points.filter(p => p.ym > pairFrom).map(p => <option key={p.ym} value={p.ym}>{cmpLabel(p.ym)}</option>)}
                </select>
              </span>
            )}
          </div>
        }>
        {cmp && dec && group === 'all' && dec.avgFrom === null && sourceOf.get(cmp.from) === 'document' ? (
          <p className="text-sm text-hibi-sub dark:text-gray-400 py-6 text-center">
            {ymLabel(cmp.from)}は外国人の資料が無いので、全体では比べられません。「日本人」を選んでください。
          </p>
        ) : cmp && dec ? (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-hibi-sub dark:text-gray-400 mb-1">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gray-400" />平均</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-orange-500" />平均を上げた</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-sky-600" />平均を下げた</span>
            </div>
            <WaterfallChart d={dec} fromLabel={cmpLabel(cmp.from).replace('【資料から】', '（資料）')} toLabel={cmpLabel(cmp.to).replace('【資料から】', '（資料）')} />
            <ul className="mt-2 grid md:grid-cols-3 gap-2 text-xs text-gray-700 dark:text-gray-300 tabular-nums">
              <li className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2">続けている人 {dec.stayers}人<br />
                <span className="text-hibi-sub dark:text-gray-400">1人あたりの昇給 {dec.raisePerStayer != null ? signedYen(dec.raisePerStayer) : '—'}／日</span></li>
              <li className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2">辞めた人 {dec.leavers}人<br />
                <span className="text-hibi-sub dark:text-gray-400">辞めた人の平均 {dec.leaverAvg != null ? yenRound(dec.leaverAvg) : '—'}</span></li>
              <li className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2">新しく入った人 {dec.joiners}人<br />
                <span className="text-hibi-sub dark:text-gray-400">入った人の平均 {dec.joinerAvg != null ? yenRound(dec.joinerAvg) : '—'}</span></li>
            </ul>
          </>
        ) : (
          <p className="text-sm text-hibi-sub dark:text-gray-400 py-6 text-center">比べられる点が2つそろうと出ます</p>
        )}
      </Section>

      <Section title="③ 月ごとの昇給"
        sub="隣り合う点のあいだに、続けている人の日給がいくら上がったか（合計・円／日）。日本人は毎年10月にまとまって、外国人は契約更新や在留資格の移行の月に上がります。薄い色の棒は給料解説書の1年分です。2026年11月までは人員マスタの「1つ前の単価」から組み立てているので、その間に2回以上上がった人は古いほうが見えません。">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-hibi-sub dark:text-gray-400 mb-1">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-orange-500" />日本人</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-orange-300" />日本人（資料・1年分）</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-600" />外国人</span>
        </div>
        <RaiseChart raises={view?.raises ?? []} />
        {(() => {
          const list = [...(view?.raises ?? [])].reverse().filter(r => (r.jp?.raised ?? 0) + (r.foreign?.raised ?? 0) > 0)
          return list.length > 0 && (
            <ul className="mt-3 divide-y divide-hibi-line dark:divide-gray-700 text-xs text-gray-700 dark:text-gray-300 tabular-nums">
              {list.map(r => (
                <li key={r.from + r.to} className="py-2 grid md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  <span className="font-bold text-gray-900 dark:text-gray-100">{ymLabel(r.to)}{r.months > 1 && <span className="font-normal text-hibi-sub">（{ymLabel(r.from)}から1年分）</span>}</span>
                  <RaiseLine label="日本人" s={r.jp} />
                  <RaiseLine label="外国人" s={r.foreign} />
                </li>
              ))}
            </ul>
          )
        })()}
      </Section>

      <Section title={`④ 平均を保つのに必要な採用（${GROUP_LABEL[group]}）`}
        sub="今の人全員に「1人あたりの昇給」が乗ったあと、目標の平均に戻すには、入社時の日給で何人採ればよいか。辞める人は入れていません。初期値は②の昇給と入った人の平均です。">
        {nowStat && nowStat.avg !== null ? (
          <div className="space-y-4">
            <div className="text-xs text-hibi-sub dark:text-gray-400 tabular-nums">
              今: {nowStat.n}人・平均 {yenRound(nowStat.avg)}（{ymLabel(latest.ym)}1日）
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <NumberField label="目標の平均" value={tVal} onChange={setTargetIn} suffix="円" />
              <NumberField label="1人あたりの昇給（日給）" value={raiseVal} onChange={setRaiseIn} step={10} suffix="円" />
              <NumberField label="入社時の日給" value={entryVal} onChange={setEntryIn} suffix="円" />
              {(targetIn !== null || raiseIn !== null || entryIn !== null) && (
                <button onClick={resetInputs} className="h-9 px-3 rounded-lg text-sm text-hibi-navy dark:text-sky-300 hover:bg-gray-100 dark:hover:bg-gray-700">初期値に戻す</button>
              )}
            </div>
            {need && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 px-4 py-3 tabular-nums">
                <div className="text-xs text-hibi-sub dark:text-gray-400">昇給後の平均 {yenRound(need.avgAfterRaise)}</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                  {need.needed === null ? '保てません' : need.needed === 0 ? '採用なしで目標内' : `${need.needed}人`}
                </div>
                <div className="text-xs text-hibi-sub dark:text-gray-400 mt-1">
                  {need.needed === null
                    ? '入社時の日給が目標の平均以上だと、何人採っても平均は目標まで下がりません'
                    : need.needed === 0
                      ? '昇給を入れても目標の平均を超えません'
                      : `採用後 ${nowStat.n + need.needed}人・平均 ${yenRound(need.avgAfterHire ?? 0)}`}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-hibi-sub dark:text-gray-400 py-6 text-center">まだ記録がありません</p>
        )}
      </Section>
    </div>
  )
}

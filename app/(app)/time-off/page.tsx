'use client'
/**
 * 休みの予定（2026-10-14 代表「帰国情報や有給申請だけの情報用ページを作って職長たちも見られるように」）。
 * 決まりは lib/time-off.ts、データは /api/time-off。見るだけのページ（承認・入力は休暇管理・出面入力）。
 *
 * - 上: 今日いない人（帰国中・有給・欠勤届）
 * - 下: これからの予定（60日先まで・始まる日の順）
 * - 職長は最初「自分の現場」だけ。切り替えで全現場・現場ごと
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { notify } from '@/lib/notify'
import { PageHeader, Segment, Chip, SearchBox } from '@/components/ui/PageParts'
import {
  TIME_OFF_KIND_LABEL, TIME_OFF_STAGE_LABEL, TIME_OFF_DAYS_AHEAD, coversDate,
  type TimeOffItem, type TimeOffKind, type TimeOffStage,
} from '@/lib/time-off'

const KIND_TONE: Record<TimeOffKind, 'cyan' | 'blue' | 'amber'> = { home: 'cyan', leave: 'blue', absence: 'amber' }
const STAGE_TONE: Record<TimeOffStage, 'green' | 'amber' | 'gray'> = { approved: 'green', pending: 'amber', reported: 'gray' }
const WEEK = ['日', '月', '火', '水', '木', '金', '土']

function fmtDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`
}
function fmtRange(t: TimeOffItem) {
  if (t.returnUndecided) return `${fmtDay(t.start)} 〜 戻り未定`
  return t.start === t.end ? fmtDay(t.start) : `${fmtDay(t.start)} 〜 ${fmtDay(t.end)}`
}

type Scope = 'mine' | 'all' | string  // string = 現場ID

export default function TimeOffPage() {
  const { password, ready } = useAuthPassword()
  const [items, setItems] = useState<TimeOffItem[]>([])
  const [sites, setSites] = useState<{ id: string; name: string }[]>([])
  const [mySiteIds, setMySiteIds] = useState<string[]>([])
  const [today, setToday] = useState('')
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<Scope>('all')
  const [kind, setKind] = useState<'all' | TimeOffKind>('all')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    if (!password) return
    try {
      const r = await fetch('/api/time-off', { headers: { 'x-admin-password': password } })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('読み込み', j?.error || 'サーバが受け付けませんでした'); return }
      setItems(j.items || [])
      setSites(j.sites || [])
      setMySiteIds(j.mySiteIds || [])
      setToday(j.today || '')
      // 職長（自分の現場がある人）は最初「自分の現場」だけ
      if ((j.mySiteIds || []).length > 0) setScope('mine')
    } catch (e) { notify.failed('読み込み', e) } finally { setLoading(false) }
  }, [password])
  useEffect(() => { if (ready) load() }, [ready, load])

  const siteName = useMemo(() => new Map(sites.map(s => [s.id, s.name])), [sites])
  // 一覧に出てくる現場だけを選択肢にする
  const usedSites = useMemo(() => {
    const ids = new Set(items.flatMap(t => t.siteIds))
    return sites.filter(s => ids.has(s.id))
  }, [items, sites])

  const q = query.trim().replace(/[\s　]/g, '').toLowerCase()
  const shown = items
    .filter(t => scope === 'all' || (scope === 'mine' ? t.siteIds.some(id => mySiteIds.includes(id)) : t.siteIds.includes(scope)))
    .filter(t => kind === 'all' || t.kind === kind)
    .filter(t => !q || t.workerName.replace(/[\s　]/g, '').toLowerCase().includes(q))
  const todayList = today ? shown.filter(t => coversDate(t, today)) : []
  const upcoming = today ? shown.filter(t => t.start > today) : shown

  const Row = ({ t }: { t: TimeOffItem }) => (
    <div className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[170px_minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center">
      <span className="text-sm font-bold text-gray-900 dark:text-gray-100 tabular-nums">{fmtRange(t)}</span>
      <span className="flex items-center gap-1.5 md:order-none order-first col-span-2 md:col-span-1">
        <Chip tone={KIND_TONE[t.kind]}>{TIME_OFF_KIND_LABEL[t.kind]}</Chip>
        <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{t.workerName}</span>
      </span>
      <span className="text-xs text-hibi-sub dark:text-gray-400 truncate">
        {t.siteIds.map(id => siteName.get(id)).filter(Boolean).join('・') || '配置なし'}
      </span>
      <span className="justify-self-end"><Chip tone={STAGE_TONE[t.stage]}>{TIME_OFF_STAGE_LABEL[t.stage]}</Chip></span>
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader
        group="出面・勤怠"
        title="休みの予定"
        sub={`帰国・有給・欠勤届の予定です（帰国は先の予定もすべて、有給・欠勤届は今日から${TIME_OFF_DAYS_AHEAD}日先まで）。見るだけの画面です。承認は休暇管理、入力は出面入力で行います`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <select value={scope} onChange={e => setScope(e.target.value)}
          className="h-9 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 text-sm" aria-label="現場">
          {mySiteIds.length > 0 && <option value="mine">自分の現場</option>}
          <option value="all">全部の現場</option>
          {usedSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Segment value={kind} onChange={setKind} items={[
          ['all', 'すべて'], ['home', '帰国'], ['leave', '有給'], ['absence', '欠勤届'],
        ]} />
        <SearchBox value={query} onChange={setQuery} placeholder="名前で探す" />
      </div>

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <h2 className="px-5 py-3 border-b border-hibi-line dark:border-gray-700 text-[1.0625rem] font-bold text-gray-900 dark:text-white">
          今日いない人{today && <span className="ml-2 text-sm font-normal text-hibi-sub">{fmtDay(today)}</span>}
          {!loading && <span className="ml-2 text-sm text-hibi-sub">{todayList.length}名</span>}
        </h2>
        {loading ? <div className="px-5 py-6 text-center text-sm text-hibi-sub">読み込み中...</div>
          : todayList.length === 0 ? <div className="px-5 py-6 text-center text-sm text-hibi-sub dark:text-gray-400">今日休みの人はいません</div>
          : todayList.map((t, i) => <Row key={`t${i}`} t={t} />)}
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <h2 className="px-5 py-3 border-b border-hibi-line dark:border-gray-700 text-[1.0625rem] font-bold text-gray-900 dark:text-white">
          これからの予定{!loading && <span className="ml-2 text-sm text-hibi-sub">{upcoming.length}件</span>}
        </h2>
        {loading ? <div className="px-5 py-6 text-center text-sm text-hibi-sub">読み込み中...</div>
          : upcoming.length === 0 ? <div className="px-5 py-6 text-center text-sm text-hibi-sub dark:text-gray-400">予定はありません</div>
          : upcoming.map((t, i) => <Row key={`u${i}`} t={t} />)}
      </section>

      <p className="text-xs text-hibi-sub dark:text-gray-400">
        承認済み = 決まった休み／承認待ち = 申請中（職長承認・最終承認の前）／届出 = 欠勤届。申請の理由は、この画面には出しません。
      </p>
    </div>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { PLWorker, PendingGrant } from '../types'
import WorkerAvatar from '@/components/WorkerAvatar'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { Icon, type IconName } from '@/components/ui/Icon'
import { addMonthsSafe, addDaysIso, todayJstIso } from '@/lib/date-utils'

// 一覧タブ（2026-10-01 改善「ひと目で分かる有給」・代表依頼）
//
//   旧: KPI4枚＋全社消化率＋8列の表。「当期／繰越」の札と時効日が小さく並ぶだけで、
//       今期の分と繰越の分の区別、誰に何をすればいいか（年5日・消える前）を数字から読み取る必要があった。
//   新: ① 上に「今やること」4枚（年5日・もうすぐ消える・申請の承認待ち・付与の設定）
//       ② 1人1行。大きい「使える日」と、その内訳を「前の期からの繰越 → 今期」の順（先に使われる順）に
//          別々の行で出す。日本人は「前の期の残り（賞与で買取）」を点線の行で添える（使える日には入れない）
//       ③ 日本人／外国人・日比／HFU の切り替え・並べ替え・名前検索
//   年5日の取得義務は「達成／n/5日」を控えめに出し、注意色はサーバの警告条件（fiveDayShortfall）のときだけ。
//   （2026-07-02 靖仁さん指示「年5日未達の警告は運用上うるさい」を守る）

type Group = 'all' | 'jp' | 'hibiForeign' | 'hfu'
type SortKey = 'attention' | 'name' | 'remaining'

interface Props {
  visible: boolean
  /** 全員（所属で絞る前）。絞り込みはこのタブの中で行う */
  workers: PLWorker[]
  loading: boolean
  onEdit: (worker: PLWorker) => void
  asOfDate?: string  // 残数の基準日（空=今日）。指定時はその日時点の残数を表示
  pendingGrants: PendingGrant[]
  pendingRequestCount: number
  onOpenPendingGrants: () => void
  onOpenRequests: () => void
}

const isJp = (w: PLWorker) => !w.visa || w.visa === 'none'

const VISA_LABEL: Record<string, string> = {
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号', tokutei3: '特定3号',
}

/** 2026-10-01 → 2026/10/1 */
const slash = (iso?: string) => iso ? `${Number(iso.slice(0, 4))}/${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ''
/** 2026-10-01 → 10/1 */
const md = (iso?: string) => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ''
/** 付与日から1年の期間の最終日（2026-10-01 → 2027-09-30） */
const periodEnd = (grantDate: string) => addDaysIso(addMonthsSafe(grantDate, 12), -1)

/** 「今やること」に出すかの判定（行の並び順にも使う） */
function attentionOf(w: PLWorker): { five: boolean; expiring: boolean; expired: boolean; noGrant: boolean } {
  return {
    five: (w.fiveDayShortfall ?? 0) > 0,
    expiring: ((w.carryOverRemaining ?? 0) > 0 && w.carryOverExpiryStatus === 'warning') || w.expiryStatus === 'warning',
    expired: w.expiryStatus === 'expired' || w.carryOverExpiryStatus === 'expired',
    // 付与日が無いのが問題なのは、入社から6か月を過ぎたのにまだ付与が無い人だけ（新人は正常・2026-10-01）
    noGrant: !w.grantDate && !!w.hireDate && addMonthsSafe(w.hireDate, 6) <= todayJstIso(),
  }
}

export default function ListTab({
  visible, workers, loading, onEdit, asOfDate,
  pendingGrants, pendingRequestCount, onOpenPendingGrants, onOpenRequests,
}: Props) {
  // 顔写真（2026-08-03 追加）。フックは早期 return より前に呼ぶ必要がある
  const { photos } = useWorkerPhotos()
  const [group, setGroup] = useState<Group>('all')
  const [sort, setSort] = useState<SortKey>('attention')
  const [query, setQuery] = useState('')
  const [onlyFive, setOnlyFive] = useState(false)
  const [onlyExpiring, setOnlyExpiring] = useState(false)

  const useAsOf = !!asOfDate
  const remOf = (w: PLWorker) => useAsOf ? (w.asOfRemaining ?? w.remaining) : w.remaining

  const groups = useMemo(() => ({
    all: workers,
    jp: workers.filter(isJp),
    hibiForeign: workers.filter(w => !isJp(w) && w.org !== 'hfu'),
    hfu: workers.filter(w => w.org === 'hfu'),
  }), [workers])

  const rows = useMemo(() => {
    const q = query.trim().replace(/\s/g, '')
    let list = groups[group]
    if (q) list = list.filter(w => w.name.replace(/\s/g, '').includes(q))
    if (onlyFive) list = list.filter(w => attentionOf(w).five)
    if (onlyExpiring) list = list.filter(w => attentionOf(w).expiring || attentionOf(w).expired)
    const score = (w: PLWorker) => {
      const a = attentionOf(w)
      return (a.expired ? 8 : 0) + (a.five ? 4 : 0) + (a.expiring ? 2 : 0) + (a.noGrant ? 1 : 0)
    }
    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    else if (sort === 'remaining') sorted.sort((a, b) => remOf(a) - remOf(b))
    else sorted.sort((a, b) => score(b) - score(a))  // 同点は元の並び（API順）を保つ
    return sorted
    // remOf は asOfDate だけに依存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, group, query, sort, onlyFive, onlyExpiring, asOfDate])

  if (!visible) return null

  // ── 今やること ──
  const fiveList = workers.filter(w => attentionOf(w).five)
  const expiringList = workers.filter(w => attentionOf(w).expiring || attentionOf(w).expired)
  const expiringDays = expiringList.reduce((s, w) => s + (w.carryOverExpiryStatus !== 'ok' && (w.carryOverRemaining ?? 0) > 0 ? (w.carryOverRemaining ?? 0) : (w.grantRemaining ?? 0)), 0)
  const asOfLabel = asOfDate ? slash(asOfDate) : ''

  const totalRemaining = rows.reduce((s, w) => s + remOf(w), 0)

  return (<>
    <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      <TodoCard
        icon="alert" tone={fiveList.length > 0 ? 'urgent' : 'ok'}
        title="年5日の取得義務"
        big={fiveList.length > 0 ? `${fiveList.length}名が未達` : 'いまは問題なし'}
        sub={fiveList.length > 0
          ? `${fiveList.slice(0, 3).map(w => `${w.name}（あと${w.fiveDayShortfall}日）`).join('、')}${fiveList.length > 3 ? ` ほか${fiveList.length - 3}名` : ''}`
          : '期限が近づいて未達の人が出たらここに出ます'}
        action={fiveList.length > 0 ? (onlyFive ? 'すべて表示に戻す' : 'この人たちだけ表示') : undefined}
        onClick={fiveList.length > 0 ? () => { setOnlyFive(v => !v); setOnlyExpiring(false) } : undefined}
        active={onlyFive}
      />
      <TodoCard
        icon="clock" tone={expiringList.length > 0 ? 'warn' : 'ok'}
        title="もうすぐ消える有給"
        big={expiringList.length > 0 ? `${expiringList.length}名・${expiringDays}日` : 'いまは問題なし'}
        sub={expiringList.length > 0 ? '3か月以内に消える分（繰越など）。消える前に取ってもらう' : '時効が3か月以内に来る人が出たらここに出ます'}
        action={expiringList.length > 0 ? (onlyExpiring ? 'すべて表示に戻す' : 'この人たちだけ表示') : undefined}
        onClick={expiringList.length > 0 ? () => { setOnlyExpiring(v => !v); setOnlyFive(false) } : undefined}
        active={onlyExpiring}
      />
      <TodoCard
        icon="check" tone={pendingRequestCount > 0 ? 'info' : 'ok'}
        title="申請の承認待ち"
        big={pendingRequestCount > 0 ? `${pendingRequestCount}件` : 'ありません'}
        sub={pendingRequestCount > 0 ? '職長承認・最終承認を待っている有給の申請' : 'スマホ・マイページから申請が来るとここに出ます'}
        action={pendingRequestCount > 0 ? '申請を開く' : undefined}
        onClick={pendingRequestCount > 0 ? onOpenRequests : undefined}
      />
      <TodoCard
        icon="user" tone={pendingGrants.length > 0 ? 'warn' : 'ok'}
        title="付与の設定が必要"
        big={pendingGrants.length > 0 ? `${pendingGrants.length}名` : 'ありません'}
        sub={pendingGrants.length > 0
          ? `${pendingGrants.slice(0, 3).map(p => p.name).join('、')}${pendingGrants.length > 3 ? ` ほか${pendingGrants.length - 3}名` : ''}（付与の時期が来ています）`
          : '入社6か月・毎年の付与日が来たらここに出ます'}
        action={pendingGrants.length > 0 ? '内容を確認して付与する' : undefined}
        onClick={pendingGrants.length > 0 ? onOpenPendingGrants : undefined}
      />
    </section>

    {/* 基準日バナー: この日「時点」の残数を表示中であることを一目で示す */}
    {useAsOf && (
      <div className="bg-hibi-active dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 text-sm text-hibi-navy dark:text-blue-200 flex items-center gap-2 flex-wrap">
        <Icon name="calendar" size={16} />
        <span className="font-bold">{asOfLabel} 時点の「使える日」を表示中</span>
        <span className="text-xs text-hibi-sub dark:text-blue-300">（この日までに取った有給だけを引いた日数。内訳は今日時点）</span>
      </div>
    )}

    {/* 絞り込み・並べ替え */}
    <div className="flex flex-wrap items-center gap-3">
      <Segment
        value={group} onChange={v => setGroup(v as Group)}
        items={[
          ['all', `全員 ${groups.all.length}`],
          ['jp', `日本人 ${groups.jp.length}`],
          ['hibiForeign', `外国人・日比 ${groups.hibiForeign.length}`],
          ['hfu', `HFU ${groups.hfu.length}`],
        ]}
      />
      <Segment
        value={sort} onChange={v => setSort(v as SortKey)}
        items={[['attention', '要対応を上に'], ['name', '名前順'], ['remaining', '残りが少ない順']]}
      />
      <label className="ml-auto flex items-center gap-2 h-9 px-3 rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-500 w-full sm:w-52">
        <Icon name="search" size={15} />
        <input
          type="search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="名前で探す" aria-label="名前で探す"
          className="flex-1 min-w-0 bg-transparent text-sm text-gray-900 dark:text-white outline-none"
        />
      </label>
    </div>

    {/* 一覧 */}
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className="hidden lg:grid grid-cols-[230px_96px_minmax(0,1fr)_200px_84px] gap-4 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
        <span>名前・今の期間</span>
        <span>使える日</span>
        <span>内訳（上から先に使われる）</span>
        <span>年5日・注意</span>
        <span />
      </div>
      {loading ? (
        <div className="px-5 py-10 text-center text-gray-400">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-gray-400">該当する人がいません</div>
      ) : rows.map(w => (
        <Row key={w.id} w={w} rem={remOf(w)} photo={photos[String(w.id)]} onOpen={() => onEdit(w)} />
      ))}
      {!loading && rows.length > 0 && (
        <div className="px-5 py-2.5 border-t border-hibi-line dark:border-gray-700 text-xs text-hibi-sub dark:text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
          <span>{rows.length}名・使える日の合計 {totalRemaining}日</span>
          <span className="ml-auto">行を押すと、くわしい内容と編集を開きます</span>
        </div>
      )}
    </div>
  </>)
}

// ─── 部品 ───────────────────────────────────────

const TONE = {
  urgent: { chip: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', title: 'text-red-700 dark:text-red-300' },
  warn: { chip: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', title: 'text-amber-800 dark:text-amber-300' },
  info: { chip: 'bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300', title: 'text-hibi-navy dark:text-blue-300' },
  ok: { chip: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300', title: 'text-gray-600 dark:text-gray-300' },
} as const

function TodoCard({ icon, tone, title, big, sub, action, onClick, active }: {
  icon: IconName
  tone: keyof typeof TONE
  title: string
  big: string
  sub: string
  action?: string
  onClick?: () => void
  active?: boolean
}) {
  const t = TONE[tone]
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center ${t.chip}`}>
          <Icon name={tone === 'ok' ? 'check' : icon} size={17} />
        </span>
        <span className={`text-[13px] font-bold ${t.title}`}>{title}</span>
      </div>
      <div className={`text-xl font-bold ${tone === 'ok' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-white'}`}>{big}</div>
      <div className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed line-clamp-2">{sub}</div>
      {action && (
        <div className="mt-auto pt-1 text-[13px] font-bold text-hibi-navy dark:text-blue-300 flex items-center gap-1">
          {action}<Icon name="chevronRight" size={14} />
        </div>
      )}
    </>
  )
  const cls = `text-left bg-white dark:bg-gray-800 border rounded-xl p-4 flex flex-col gap-2 ${
    active ? 'border-hibi-navy ring-1 ring-hibi-navy dark:border-blue-400 dark:ring-blue-400' : 'border-hibi-line dark:border-gray-700'
  }`
  return onClick
    ? <button onClick={onClick} className={`${cls} hover:border-hibi-navy dark:hover:border-blue-400 transition`}>{body}</button>
    : <div className={cls}>{body}</div>
}

function Segment({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return (
    <div className="flex gap-1 p-1 rounded-[10px] bg-gray-200/70 dark:bg-gray-800 w-fit">
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k}
          className={`h-8 px-3.5 rounded-lg text-[13px] transition ${
            value === k
              ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white font-bold shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Row({ w, rem, photo, onOpen }: { w: PLWorker; rem: number; photo?: string; onOpen: () => void }) {
  const jp = isJp(w)
  const a = attentionOf(w)
  const remCls = rem <= 0 ? 'text-red-600 dark:text-red-400' : rem <= 3 ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-white'
  const badge = jp ? '日本人' : (VISA_LABEL[w.visa] || w.visa)
  const orgBadge = w.org === 'hfu' ? 'HFU' : '日比'
  const fiveUsed = Math.min(5, w.periodUsed ?? 0)

  return (
    <button onClick={onOpen}
      className="w-full text-left grid grid-cols-1 lg:grid-cols-[230px_96px_minmax(0,1fr)_200px_84px] gap-3 lg:gap-4 items-center px-5 py-3.5 border-t border-hibi-line dark:border-gray-700 first:border-t-0 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
      {/* 名前・今の期間 */}
      <div className="flex items-center gap-3 min-w-0">
        <WorkerAvatar name={w.name} src={photo} size={40} />
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-gray-900 dark:text-gray-100 truncate">{w.name}</div>
          <div className="text-xs text-hibi-sub dark:text-gray-400 truncate">{badge}・{orgBadge}</div>
          <div className="text-xs text-hibi-sub dark:text-gray-400 truncate tabular-nums">
            {w.grantDate ? `${slash(w.grantDate)}〜${slash(periodEnd(w.grantDate))}` : '付与日が未設定'}
            {w.inferredFromDefault && <span className="ml-1 text-blue-600">（推定）</span>}
          </div>
        </div>
      </div>

      {/* 使える日 */}
      <div className="flex items-baseline gap-1">
        <span className={`text-[28px] leading-none font-bold tabular-nums ${remCls}`}>{rem}</span>
        <span className="text-[13px] text-hibi-sub dark:text-gray-400">日</span>
      </div>

      {/* 内訳: 繰越 → 今期（先に使われる順）。日本人は前の期の残り（賞与で買取）を点線で */}
      <div className="flex flex-col gap-1.5 min-w-0">
        {/* 繰越は残っているときだけ（使い切った繰越の「0日」行は出さない・2026-10-01） */}
        {(w.carryOverRemaining ?? 0) > 0 && (
          <Bucket
            label="前の期からの繰越"
            rem={w.carryOverRemaining ?? 0}
            of={w.carryOver}
            note={w.carryOverExpiryDate ? `${slash(w.carryOverExpiryDate)} に消える` : ''}
            warn={w.carryOverExpiryStatus === 'warning' || w.carryOverExpiryStatus === 'expired'}
            muted
          />
        )}
        {w.grantDays > 0 ? (
          <Bucket
            label={`今期（${md(w.grantDate)}にもらった）`}
            rem={w.grantRemaining ?? Math.max(0, w.grantDays - Math.max(0, w.used - (w.carryOver ?? 0)))}
            of={w.grantDays}
            note={jp ? `${md(periodEnd(w.grantDate))}まで（残りは賞与で買取）` : (w.expiryDate ? `${slash(w.expiryDate)} まで使える` : '')}
            warn={w.expiryStatus === 'warning' || w.expiryStatus === 'expired'}
          />
        ) : (
          <div className="text-xs text-hibi-sub dark:text-gray-400 px-2.5 py-1.5">まだ付与がありません</div>
        )}
        {w.adjustment > 0 && <div className="text-[11px] text-hibi-sub dark:text-gray-400 px-2.5">調整 {w.adjustment}日（移行・手作業の取得分）</div>}
        {jp && w.prevPeriod && (w.prevPeriod.remaining > 0 || w.prevPeriod.buyoutDays > 0) && (
          <div className={`grid grid-cols-[minmax(0,140px)_52px_minmax(0,1fr)] items-center gap-2 px-2.5 py-1 rounded-lg border border-dashed ${
            w.prevPeriod.remaining > 0
              ? 'bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-300'
              : 'bg-gray-50 border-gray-300 text-gray-500 dark:bg-gray-700/40 dark:border-gray-600 dark:text-gray-400'
          }`} title={`前の期 ${slash(w.prevPeriod.grantDate)}〜${slash(w.prevPeriod.endDate)}: もらった ${w.prevPeriod.grantDays}日・取った ${w.prevPeriod.taken}日。休みには使えません`}>
            <span className="text-xs font-bold truncate">前の期の残り</span>
            <span className="text-[15px] font-bold tabular-nums text-right">{w.prevPeriod.remaining > 0 ? w.prevPeriod.remaining : w.prevPeriod.buyoutDays}<span className="text-[11px] font-normal"> 日</span></span>
            <span className="text-xs font-bold truncate">{w.prevPeriod.remaining > 0 ? '賞与で買取予定' : '賞与で買取済み'}</span>
          </div>
        )}
      </div>

      {/* 年5日・注意 */}
      <div className="flex flex-wrap lg:flex-col items-start gap-1.5">
        {w.grantDays >= 10 && (
          (w.periodUsed ?? 0) >= 5
            ? <Chip cls="bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"><Icon name="check" size={12} strokeWidth={2.6} />年5日 達成</Chip>
            : a.five
              ? <Chip cls="bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">年5日 あと{w.fiveDayShortfall}日</Chip>
              : <Chip cls="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">年5日 {fiveUsed}/5日</Chip>
        )}
        {a.expired && <Chip cls="bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">期限切れあり</Chip>}
        {!a.expired && w.carryOverExpiryStatus === 'warning' && (w.carryOverRemaining ?? 0) > 0 && (
          <Chip cls="bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"><Icon name="clock" size={12} />繰越{w.carryOverRemaining}日 {md(w.carryOverExpiryDate)}に消える</Chip>
        )}
        {!w.grantDate && (a.noGrant
          ? <Chip cls="bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">付与日が未設定</Chip>
          : <Chip cls="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">入社6か月で付与</Chip>)}
      </div>

      <span className="hidden lg:flex justify-self-end items-center gap-1 text-[13px] font-bold text-hibi-navy dark:text-blue-300">
        くわしく<Icon name="chevronRight" size={14} />
      </span>
    </button>
  )
}

function Bucket({ label, rem, of, note, warn, muted }: {
  label: string; rem: number; of: number; note: string; warn?: boolean; muted?: boolean
}) {
  return (
    <div className={`grid grid-cols-[minmax(0,140px)_52px_minmax(0,1fr)] items-center gap-2 px-2.5 py-1 rounded-lg border ${
      warn ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800'
        : muted ? 'bg-hibi-bg border-hibi-line dark:bg-gray-700/40 dark:border-gray-600'
          : 'bg-white border-hibi-line dark:bg-gray-800 dark:border-gray-600'
    }`}>
      <span className={`text-xs font-bold truncate ${warn ? 'text-amber-800 dark:text-amber-300' : 'text-gray-700 dark:text-gray-200'}`}>{label}</span>
      <span className="text-[15px] font-bold tabular-nums text-right text-gray-900 dark:text-white">{rem}<span className="text-[11px] font-normal text-hibi-sub dark:text-gray-400"> 日</span></span>
      <span className={`text-xs truncate ${warn ? 'text-amber-800 dark:text-amber-300 font-bold' : 'text-hibi-sub dark:text-gray-400'}`}>{of}日中　{note}</span>
    </div>
  )
}

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold whitespace-nowrap ${cls}`}>{children}</span>
}

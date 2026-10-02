'use client'

/**
 * 賃金・評価ハブ（2026-08-28 新設・2026-10-01 改修）
 *
 * 日本人（号俸制）とベトナム人（時給制）で賃金・評価の制度が別々にあり、
 * 「評価管理」「賃金制度」「昇給履歴」という名前ではどれが誰の話か
 * 分からなかった。サイドバーはこのハブ1本にし、ここから国籍別に分岐する。
 *
 * 2026-10-01: 上に「今やること」（評価の入力が残っている・承認待ち・等級が決まっていない）を出す。
 * 既存ページ（/wage・/evaluation 等）はそのまま。ここは入口だけを整理する。
 */
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Icon, type IconName } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Chip } from '@/components/ui/PageParts'
import type { Evaluation } from '@/types'
import { can } from '@/lib/permissions'
import { isAlreadyRetired } from '@/lib/workers'

// 賃金分析は個人の賃金を一覧するため代表のみ（/wage-analysis 側のガードと同一基準）
const ANALYSIS_OWNER_ID = 0
// 賃金制度（/wage）を開ける人（/wage の ALLOWED_VIEWERS と同一基準）
const WAGE_VIEWERS = [0, 1]

interface HubLink {
  href: string
  title: string
  desc: string
  icon: IconName
  badge?: ReactNode
}

function HubCard({ title, subtitle, links }: { title: string; subtitle: string; links: HubLink[] }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-3.5">
        <h2 className="text-17 font-bold text-gray-900 dark:text-white">{title}</h2>
        <p className="text-xs text-hibi-sub dark:text-gray-400 mt-0.5">{subtitle}</p>
      </div>
      {links.map(l => (
        <Link key={l.href} href={l.href}
          className="flex items-center gap-3.5 px-5 py-3.5 border-t border-hibi-line dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
          <span className="w-9 h-9 rounded-[10px] bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 flex items-center justify-center shrink-0">
            <Icon name={l.icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-15 font-bold text-gray-900 dark:text-white">{l.title}</span>
            <span className="block text-xs text-hibi-sub dark:text-gray-400 mt-0.5">{l.desc}</span>
          </span>
          {l.badge}
          <Icon name="chevronRight" size={16} className="text-gray-400 shrink-0" />
        </Link>
      ))}
    </section>
  )
}

interface EvalData {
  evaluations: Evaluation[]
  evaluators: { id: number; name: string }[]
  /** 評価の対象（在籍中の外国人。API の workers ＝ /evaluation の一覧と同じ人たち） */
  workerIds: number[]
}

export default function CompensationHubPage() {
  const [workerId, setWorkerId] = useState<number | null>(null)
  const [evalData, setEvalData] = useState<EvalData | null>(null)
  const [unset, setUnset] = useState<{ id: number; name: string }[] | null>(null)
  // 評価の承認（/evaluation の「承認」タブ）を開ける人だけに「承認へ」を出す
  const [canDecide, setCanDecide] = useState(false)

  useEffect(() => {
    let pw = ''
    let wid: number | null = null
    try {
      const raw = localStorage.getItem('hibi_auth')
      const parsed = raw ? JSON.parse(raw) : null
      // workerId 0（代表）は falsy — 真偽判定せず型で見る
      if (typeof parsed?.user?.workerId === 'number') wid = parsed.user.workerId
      pw = parsed?.password || ''
      setCanDecide(can(parsed?.user, 'wage.decide'))
    } catch { /* 未ログイン扱い */ }
    setWorkerId(wid)
    if (!pw) return
    const h = { headers: { 'x-admin-password': pw } }
    fetch('/api/evaluation', h).then(r => r.ok ? r.json() : null).then(j => {
      if (j) setEvalData({
        evaluations: j.evaluations || [], evaluators: j.evaluators || [],
        workerIds: ((j.workers || []) as { id: number }[]).map(w => Number(w.id)),
      })
    }).catch(() => {})
    // 等級・号数が未設定の日本人社員（/wage のお知らせと同じ判定）。賃金制度を開ける人にだけ出す
    if (wid !== null && WAGE_VIEWERS.includes(wid)) {
      fetch('/api/workers', h).then(r => r.ok ? r.json() : null).then(j => {
        if (!j?.workers) return
        const ws = j.workers as Record<string, unknown>[]
        setUnset(ws
          // 退職の判定は「今日の時点で退職日を過ぎたか」（lib/workers.ts isAlreadyRetired・2026-10-02 総合点検）。旧: `!w.retired` で退職「予定」の在籍者まで外れていた
          .filter(w => !isAlreadyRetired(w.retired as string | undefined) && (!w.visaType || w.visaType === 'none'))
          .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
          .filter(w => !w.jpGrade || !w.jpStep)
          .map(w => ({ id: Number(w.id), name: String(w.name) })))
      }).catch(() => {})
    }
  }, [])

  const canWage = workerId !== null && WAGE_VIEWERS.includes(workerId)
  const evals = evalData?.evaluations || []
  const nameOf = (id: number) => evalData?.evaluators.find(e => e.id === id)?.name || `ID ${id}`
  // /evaluation の一覧と同じ数え方: 在籍中の対象者1人につき、進行中（承認前）の最新の評価1件
  const activeEvals = (evalData?.workerIds || []).map(id => evals
    .filter(e => e.workerId === id && e.status !== 'approved')
    .sort((a, b) => b.evaluationDate.localeCompare(a.evaluationDate))[0])
    .filter((e): e is Evaluation => !!e)
  const collecting = activeEvals.filter(e => e.status !== 'reviewing')
  const reviewing = activeEvals.filter(e => e.status === 'reviewing')
  const missingOf = (e: Evaluation) => {
    const done = new Set((e.reviews || []).map(r => r.evaluatorId))
    return (e.evaluatorIds || []).filter(id => !done.has(id)).map(nameOf)
  }

  const jpLinks: HubLink[] = [
    {
      href: '/wage', icon: 'yen', title: '賃金制度（号俸表・年次改定・昇格・賞与）',
      desc: '評語の入力から改定の確定、賞与の配分、本人へ渡す給料表まで',
      badge: unset && unset.length > 0 ? <Chip tone="amber">等級まだ {unset.length}名</Chip> : undefined,
    },
  ]

  const vnLinks: HubLink[] = [
    {
      href: '/evaluation', icon: 'star', title: '評価管理',
      desc: '評価の入力・進み具合・承認・履歴（入社記念日ごとの年次評価）',
      badge: collecting.length > 0 ? <Chip tone="red">評価中 {collecting.length}名</Chip>
        : reviewing.length > 0 ? <Chip tone="blue">承認待ち {reviewing.length}名</Chip> : undefined,
    },
    {
      href: '/workers?tab=raise-history', icon: 'trend', title: '昇給の記録',
      desc: '時給の改定の一覧（人員マスタの「昇給の記録」）',
    },
    ...(workerId === ANALYSIS_OWNER_ID ? [{
      href: '/wage-analysis', icon: 'chart' as IconName, title: '賃金分析（代表のみ）',
      desc: '賃金カーブ・最低賃金との比較・長期の昇給シミュレーション',
    }] : []),
  ]

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader group="賃金・評価" title="賃金・評価" sub="賃金と評価の制度は、日本人とベトナム人で別々です" />

      {/* 今やること */}
      <section className={`grid grid-cols-1 ${canWage ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3`}>
        <TodoCard icon="pen" tone={collecting.length > 0 ? 'urgent' : 'ok'} title="評価の入力が残っている"
          big={!evalData ? '…' : collecting.length > 0 ? `${collecting.length}名` : 'ありません'}
          sub={collecting.length > 0
            ? collecting.slice(0, 2).map(e => `${e.workerName}（まだ: ${missingOf(e).join('・')}）`).join('／') + (collecting.length > 2 ? ` ほか${collecting.length - 2}名` : '')
            : '入力を待っている評価はありません'}
          action={collecting.length > 0 ? '評価管理へ' : undefined}
          onClick={collecting.length > 0 ? () => { window.location.href = '/evaluation' } : undefined} />
        <TodoCard icon="check" tone={reviewing.length > 0 ? 'info' : 'ok'} title="承認待ち"
          big={!evalData ? '…' : reviewing.length > 0 ? `${reviewing.length}名` : 'ありません'}
          sub={reviewing.length > 0 ? `${reviewing.slice(0, 3).map(e => e.workerName).join('・')}。入力がそろいました。承認すると時給が決まります` : '承認を待っている評価はありません'}
          action={reviewing.length > 0 ? (canDecide ? '承認へ' : '評価管理へ') : undefined}
          onClick={reviewing.length > 0 ? () => { window.location.href = canDecide ? '/evaluation?tab=approve' : '/evaluation' } : undefined} />
        {canWage && (
          <TodoCard icon="alert" tone={unset && unset.length > 0 ? 'warn' : 'ok'} title="等級・号数が決まっていない"
            big={!unset ? '…' : unset.length > 0 ? `${unset.length}名` : 'ありません'}
            sub={unset && unset.length > 0 ? `${unset.slice(0, 3).map(w => w.name).join('・')}。年次改定の前に人員マスタで等級を選んでください` : '日本人社員は全員、等級・号数が決まっています'}
            action={unset && unset.length > 0 ? '人員マスタへ' : undefined}
            onClick={unset && unset.length > 0 ? () => { window.location.href = `/workers?edit=${unset[0].id}` } : undefined} />
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <HubCard title="日本人スタッフ" subtitle="号俸制（等級×号の日額表）。毎年10月1日に改定" links={jpLinks} />
        <HubCard title="ベトナム人スタッフ" subtitle="時給制。入社記念日ごとの年次評価で時給を改定" links={vnLinks} />
      </div>

      <p className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed">
        制度の違い: 日本人は「等級×号」の給料表で毎年10月に一斉改定（評語 SS/S/A/B/C）。
        ベトナム人は時給制で、本人の入社記念日ごとに年次評価をして時給を改定します。
        道具代はどちらも対象で、メニューの「道具代管理」から。
      </p>
    </div>
  )
}

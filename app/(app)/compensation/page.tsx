'use client'

/**
 * 賃金・評価ハブ（2026-08-28 新設）
 *
 * 日本人（号俸制）とベトナム人（時給制）で賃金・評価の制度が別々にあり、
 * 「評価管理」「賃金制度」「昇給履歴」という名前ではどれが誰の話か
 * 分からなかった。サイドバーはこのハブ1本にし、ここから国籍別に分岐する。
 *
 * 既存ページ（/wage・/evaluation 等）はそのまま。ここは入口だけを整理する。
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'

// 賃金分析は個人の賃金を一覧するため代表のみ（/wage-analysis 側のガードと同一基準）
const ANALYSIS_OWNER_ID = 0

interface HubLink {
  href: string
  title: string
  desc: string
  emoji: string
}

function HubCard({ flag, title, subtitle, accent, links }: {
  flag: string
  title: string
  subtitle: string
  accent: string
  links: HubLink[]
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
      <div className={`px-5 py-4 ${accent}`}>
        <div className="text-lg font-bold flex items-center gap-2">
          <span className="text-2xl">{flag}</span>{title}
        </div>
        <div className="text-xs opacity-80 mt-0.5">{subtitle}</div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {links.map(l => (
          <Link key={l.href} href={l.href}
            className="flex items-center gap-3 px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
            <span className="text-xl shrink-0">{l.emoji}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-hibi-navy dark:text-white">{l.title}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{l.desc}</span>
            </span>
            <span className="text-gray-300 dark:text-gray-500 shrink-0">›</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default function CompensationHubPage() {
  const [workerId, setWorkerId] = useState<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const parsed = raw ? JSON.parse(raw) : null
      // workerId 0（代表）は falsy — 真偽判定せず型で見る
      if (typeof parsed?.user?.workerId === 'number') setWorkerId(parsed.user.workerId)
    } catch { /* 未ログイン扱い */ }
  }, [])

  const jpLinks: HubLink[] = [
    {
      href: '/wage', emoji: '💴', title: '賃金制度（号俸制）',
      desc: '号俸表・年次改定（評語の入力もここ）・賞与の配分・本人へ渡す給料表',
    },
  ]

  const vnLinks: HubLink[] = [
    {
      href: '/evaluation', emoji: '📋', title: '評価管理',
      desc: '年次評価の入力と時給改定（入社記念日サイクル）',
    },
    {
      href: '/workers?tab=raise-history', emoji: '📈', title: '昇給履歴',
      desc: '時給の改定履歴の一覧（人員マスタの履歴タブ）',
    },
    ...(workerId === ANALYSIS_OWNER_ID ? [{
      href: '/wage-analysis', emoji: '🔎', title: '賃金分析（代表専用)',
      desc: '賃金カーブ・最低賃金との比較・長期の昇給シミュレーション',
    }] : []),
  ]

  return (
    <div className="space-y-5 max-w-4xl">
      <header>
        <h1 className="text-lg font-bold text-hibi-navy dark:text-white flex items-center gap-2">
          💴 賃金・評価
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          賃金と評価の制度は日本人とベトナム人で別々です。対象を選んでください。
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <HubCard
          flag="🇯🇵" title="日本人スタッフ"
          subtitle="号俸制（等級×号の給料表）・毎年10月1日改定"
          accent="bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100"
          links={jpLinks}
        />
        <HubCard
          flag="🇻🇳" title="ベトナム人スタッフ"
          subtitle="時給制・入社記念日ごとの年次評価で改定"
          accent="bg-orange-50 text-orange-900 dark:bg-orange-900/30 dark:text-orange-100"
          links={vnLinks}
        />
      </div>

      <div className="text-xs text-gray-400 leading-relaxed">
        制度の違い: 日本人は「等級×号」の給料表で毎年10月に一斉改定（評語 SS/S/A/B/C）。
        ベトナム人は時給制で、本人の入社記念日ごとに年次評価をして時給を改定します。
        道具代はどちらも対象で、サイドバーの「道具代管理」から。
      </div>
    </div>
  )
}

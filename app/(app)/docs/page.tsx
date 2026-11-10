'use client'
// 2026-10-03: 画面の型（PageHeader・カード・下線タブ）にそろえた

import { useEffect, useState } from 'react'
import { readAuth } from '@/lib/hooks/useAuthPassword'
import { PageHeader, Chip } from '@/components/ui/PageParts'
import { Icon } from '@/components/ui/Icon'
import { DOCS, isForRole, type DocItem, type DocRole as Role } from '@/lib/docs-catalog'


const ROLE_LABEL: Record<Role, string> = {
  admin: '管理者',
  approver: '事業責任者',
  foreman: '職長',
  jimu: '事務',
}


const CATEGORY_LABEL: Record<string, string> = {
  guide: 'まずはここから',
  manual: '業務マニュアル',
  staff: 'スタッフ向け',
  archive: '過去資料',
}


/** 札の色: NEW＝青、改訂＝琥珀、それ以外（日次参照・日本語+ベトナム語）＝灰 */
function badgeTone(badge: string): 'blue' | 'amber' | 'gray' {
  if (badge === 'NEW') return 'blue'
  if (badge.includes('改訂')) return 'amber'
  return 'gray'
}

/** 1件1行。左に題名と説明、右に更新日 */
function DocRow({ item }: { item: DocItem }) {
  return (
    <a
      href={item.url}
      target={item.internal ? undefined : '_blank'}
      rel={item.internal ? undefined : 'noopener noreferrer'}
      className="flex items-start gap-4 px-5 py-3.5 border-t border-hibi-line dark:border-gray-700 first:border-t-0 hover:bg-hibi-bg dark:hover:bg-gray-700/40 transition group"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-gray-900 dark:text-white group-hover:text-hibi-navy dark:group-hover:text-blue-300">{item.title}</span>
          {item.badge && <Chip tone={badgeTone(item.badge)}>{item.badge}</Chip>}
          {!item.internal && <Icon name="external" size={13} className="text-gray-400" />}
        </div>
        <p className="text-xs text-hibi-sub dark:text-gray-400 mt-1 leading-relaxed">{item.desc}</p>
      </div>
      <span className="shrink-0 text-2xs text-hibi-sub dark:text-gray-500 tabular-nums pt-0.5">更新 {item.updated}</span>
    </a>
  )
}

/** 分類ごとの白いカード（見出し行＋1件1行） */
function DocGroup({ title, count, items }: { title: string; count?: number; items: DocItem[] }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-3 border-b border-hibi-line dark:border-gray-700 bg-hibi-thead dark:bg-gray-700/60">
        <h2 className="text-[0.8125rem] font-bold text-hibi-sub dark:text-gray-300">{title}{count !== undefined ? `（${count}件）` : ''}</h2>
      </div>
      {items.map(item => <DocRow key={item.url} item={item} />)}
    </section>
  )
}

export default function DocsPage() {
  const [role, setRole] = useState<Role | null>(null)
  // 賃金分析は個人の給与を一覧するため、代表（workerId=0）にだけリンクを出す。
  // ページ側でも同じ判定でガードしている（二重防御）。
  const [isOwner, setIsOwner] = useState(false)
  // 賃金改定は代表（0）と事業責任者（1）。評価を決めるのはこの2名（第4節）
  const [isManagement, setIsManagement] = useState(false)

  useEffect(() => {
    try {
      const auth = readAuth()
      if (auth) {
        const parsed = auth
        const r = parsed?.user?.role
        if (r === 'admin' || r === 'approver' || r === 'foreman' || r === 'jimu') {
          setRole(r)
        }
        const wid = parsed?.user?.workerId
        if (wid === 0) setIsOwner(true)
        // workerId 0 は falsy なので、必ず値で比較する
        if (wid === 0 || wid === 1) setIsManagement(true)
      }
    } catch {
      // ロール取得に失敗しても全資料を表示するだけなので無視
    }
  }, [])

  // 過去資料（役目を終えたもの）は一覧に出さない。代表だけ一番下の折りたたみから開ける（2026-09-26）。
  //   ファイル自体は残すので、仕様書などからのリンクは切れない（各ページの先頭に「過去資料」の帯あり）
  const current = DOCS.filter(d => d.category !== 'archive')
  const archived = DOCS.filter(d => d.category === 'archive')
  const mine = current.filter(d => isForRole(d, role))
  const others = current.filter(d => !isForRole(d, role))

  // 「あなた向け」をカテゴリ順に並べる
  const categoryOrder = ['guide', 'manual', 'staff']
  const mineByCategory = categoryOrder
    .map(cat => ({ cat, items: mine.filter(d => d.category === cat) }))
    .filter(g => g.items.length > 0)

  // 給与を扱う画面への入口（代表・事業責任者だけに出す）
  const restricted = [
    ...(isOwner ? [{
      href: '/wage-analysis', title: '賃金分析', who: '代表のみ',
      desc: 'ベトナム人スタッフの在籍年数と時給の分布。入社時の東京都最低賃金を起点にした昇給率、段階ごとの段差、相対的に高い・低い人の判定',
    }] : []),
    ...(isManagement ? [{
      href: '/wage?tab=revision', title: '賃金制度（日本人社員）', who: '代表・事業責任者',
      desc: '号俸表・調整の基準・年次改定を1つにまとめた画面。改定の数字がどの表から出ているかをその場で辿れる',
    }] : []),
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <PageHeader
        group="マスタ・管理"
        title="資料一覧"
        sub="マニュアル・チェックリスト・運用ガイド。資料はブラウザの別タブで開きます"
      />

      {/* 使い分けの説明 */}
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4">
        <h2 className="text-sm font-bold text-gray-900 dark:text-white mb-2">資料の使い分け</h2>
        <dl className="grid gap-x-4 gap-y-1 text-xs text-gray-700 dark:text-gray-300 sm:grid-cols-[auto_1fr]">
          <dt className="font-bold">チェックリスト</dt><dd>日次・月次でやることを確認したいとき</dd>
          <dt className="font-bold">マニュアル</dt><dd>操作方法を調べたいとき（毎日参照）</dd>
          <dt className="font-bold">制度説明</dt><dd>変形労働時間制などの仕組みを理解したいとき（初回・変更時のみ）</dd>
        </dl>
      </section>

      {/* 代表・事業責任者だけが見られる画面（個人の給与を扱う） */}
      {restricted.length > 0 && (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3 border-b border-hibi-line dark:border-gray-700 bg-hibi-thead dark:bg-gray-700/60">
            <h2 className="text-[0.8125rem] font-bold text-hibi-sub dark:text-gray-300">給与を扱う画面（見られる人を限定）</h2>
          </div>
          {restricted.map(r => (
            <a key={r.href} href={r.href}
              className="flex items-start gap-4 px-5 py-3.5 border-t border-hibi-line dark:border-gray-700 first:border-t-0 hover:bg-hibi-bg dark:hover:bg-gray-700/40 transition">
              <span className="w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                <Icon name="lock" size={16} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-gray-900 dark:text-white">{r.title}</span>
                  <Chip tone="red">{r.who}</Chip>
                </div>
                <p className="text-xs text-hibi-sub dark:text-gray-400 mt-1 leading-relaxed">{r.desc}</p>
              </div>
              <Icon name="chevronRight" size={16} className="text-hibi-navy dark:text-blue-300 shrink-0 mt-1" />
            </a>
          ))}
        </section>
      )}

      {/* あなた向け */}
      {role && role !== 'admin' && (
        <div className="text-sm font-bold text-gray-900 dark:text-white">
          {ROLE_LABEL[role]}のあなたに関係する資料
        </div>
      )}

      {mineByCategory.map(group => (
        <DocGroup key={group.cat} title={CATEGORY_LABEL[group.cat]} items={group.items} />
      ))}

      {/* その他の資料（ロールに直接関係しないもの）は折りたたみ */}
      {others.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-bold text-hibi-sub dark:text-gray-400 hover:text-hibi-navy dark:hover:text-white select-none">
            その他の資料（{others.length}件）を表示
          </summary>
          <div className="mt-3">
            <DocGroup title="その他の資料" count={others.length} items={others} />
          </div>
        </details>
      )}

      {isOwner && archived.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-bold text-gray-400 dark:text-gray-500 hover:text-hibi-navy dark:hover:text-white select-none">
            過去資料（代表のみ・{archived.length}件）
          </summary>
          <div className="mt-3">
            <DocGroup title={CATEGORY_LABEL.archive} count={archived.length} items={archived} />
          </div>
        </details>
      )}
    </div>
  )
}

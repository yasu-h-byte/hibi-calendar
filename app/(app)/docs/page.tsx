'use client'
// 2026-10-03: 画面の型（PageHeader・カード・下線タブ）にそろえた

import { useEffect, useState } from 'react'
import { PageHeader, Chip } from '@/components/ui/PageParts'
import { Icon } from '@/components/ui/Icon'

type Role = 'admin' | 'approver' | 'foreman' | 'jimu'

interface DocItem {
  title: string
  desc: string
  url: string
  badge?: string
  internal?: boolean
  updated: string
  // このロールに関係する資料。未指定 = 全員向け。admin は常に全資料が対象。
  roles?: Role[]
}

const ROLE_LABEL: Record<Role, string> = {
  admin: '管理者',
  approver: '事業責任者',
  foreman: '職長',
  jimu: '事務',
}

// 全資料（フラットに保持。category は表示グループ用）
const DOCS: (DocItem & { category: string })[] = [
  // ── 全員向けの入口 ──
  { category: 'guide', title: 'ロール別やることチェックリスト', desc: '事務・役員・職長・スタッフが日次／月次／年次で何をすべきかを1ページに集約', url: '/manual-checklist.html', badge: '日次参照', updated: '2026-10-03' },

  // ── 事務（森田さん・2026-10からキャシュモ委託体制） ──
  { category: 'manual', roles: ['jimu'], title: '事務業務マニュアル（森田さん向け）', desc: '奥寺さん・佐藤さんの業務を統合した引き継ぎ版。出面補助・申請承認・道具代・月次締め・キャシュモへの資料提出まで（給与計算・振込はキャシュモ委託）', url: '/manual-morita.html', badge: 'NEW', updated: '2026-10-09' },
  { category: 'manual', roles: ['jimu'], title: '社労士提出用資料マニュアル', desc: 'キャシュモに毎月渡す2資料（月次集計Excel・計算根拠PDF）と根拠書類3点（勤務予定シフト・実労働時間明細・出面一覧）の説明。変形労働時間制・3段階残業判定・有給日給・日本人の計算方法・端数処理', url: '/manual-syaroshi.html', updated: '2026-10-02' },

  // ── お知らせ（計算ルールの変更） ──

  // ── 事業責任者（政仁さん） ──
  { category: 'manual', roles: ['approver'], title: '政仁さん向けマニュアル', desc: '出面の最終承認・有給/帰国申請の承認・就業カレンダー承認（事業責任者の承認業務に特化）。10月改訂で スマホのマイページからの最終承認・代行 を追加', url: '/manual-masahito.html', updated: '2026-10-03' },

  // ── 職長 ──
  { category: 'manual', roles: ['foreman'], title: '職長向けマニュアル', desc: '毎日の出面確認・就業カレンダー・夜勤の入力。10月改訂で マイページからの承認（出面のまとめ承認・有給・帰国申請）を追加', url: '/manual-foreman.html', badge: '10月改訂', updated: '2026-10-03' },

  // ── 有給担当（事務・事業責任者） ──
  { category: 'manual', roles: ['jimu', 'approver'], title: '休暇管理マニュアル', desc: '有給・帰国休暇の唯一の参照元。帰国期間中でも有給を使えるようになった点（2026-09）と、年5日の日本人特則・買取上限（残−5日）・買取の自動記録・HFU移籍の勤続通算', url: '/manual-yukyu.html', badge: '10月改訂', updated: '2026-10-08' },

  // ── 評価（運用前・管理者のみ） ──
  { category: 'manual', roles: ['admin'], title: '評価管理マニュアル（ベトナム人）', desc: '年次評価と時給改定（入社記念日サイクル）。5タブ構成・評価者ウェイト・スコア計算・昇給テーブル', url: '/manual-evaluation.html', updated: '2026-10-03' },
  { category: 'manual', roles: ['admin', 'approver'], title: '賃金・評価 操作マニュアル（日本人）', desc: '号俸制の年次改定の回し方（評語・代表加算・平均昇給率）と賞与4区分（利益分配・精勤・禁煙・子ども手当）の作成〜確定〜有給買取の自動記録まで', url: '/manual-wage-jp.html', badge: 'NEW', updated: '2026-10-08' },

  // ── スタッフ向け（全員が内容を把握しておく／スタッフ本人はスマホから） ──
  { category: 'staff', title: 'マイページの使い方（日本人スタッフ向け）', desc: '有給の残数確認と申請・年5日ルール・道具代の残額確認（申請はマネーフォワード）。専用URLの配布時に一緒に渡す1枚もの', url: '/manual-mypage-jp.html', badge: 'NEW', updated: '2026-10-08' },
  { category: 'staff', title: '有給休暇のルール（日本人スタッフ向け）', desc: '年5日は現場が動いている日に必ず休む・有給の申請・有給精算（日給月給の人が残りを給料に回す・月24日まで）・期末の買取。マイページの「有給のルールを読む」から開く。トークノートでの周知用の文もこの内容', url: '/notice-yukyu-rule-jp.html', badge: 'NEW', updated: '2026-10-08' },
  { category: 'staff', title: '【お知らせ】給料の計算のしかた（2026年9月分から）', desc: 'ベトナム人スタッフ向け（日本語＋ベトナム語）。「自分の都合で休んでも給料があまり減らない」ゆがみを直す理由（2人の比較つき）と5つのルール・計算例。自分の都合の欠勤は1日ごとに保証が1日減る（働いた日の分は必ず払う）。8月分までの支払いはそのまま', url: '/notice-salary-rule-2026-09.html', badge: '日本語+ベトナム語', updated: '2026-09-30' },
  { category: 'staff', title: 'スタッフ向けマニュアル（ベトナム人）', desc: '使う場面ごと（毎日・休むとき・毎月・ときどき）の7章。出勤登録／休みの出し方（会社の都合・自分の都合・有給・帰国）／月末の出面の確認／カレンダーの署名／忘れた・まちがえたとき／有給・道具代の残り／困ったとき（日本語＋ベトナム語）', url: '/staff-manual-vi.html', badge: '日本語+ベトナム語', updated: '2026-10-03' },
  { category: 'staff', title: '変形労働時間制と残業のルール', desc: '変形労働時間制のしくみ・残業の3段階判定・給料の4層構造・計算例・FAQ（スタッフへの制度説明用）', url: '/manual-henkei-vi.html', badge: '日本語+ベトナム語', updated: '2026-09-26' },
  // ── 過去資料（役目を終えたが記録として残す）──
  // 2026-09-02: 奥寺さん・佐藤さんの退職（9月末）とキャシュモ委託に伴い、個人名義の
  //   3冊は「事務業務マニュアル（森田さん向け）」へ統合。原本は記録として残す。
  { category: 'archive', title: '請求書の発行マニュアル（2026年9月26日版）', desc: '森田さん向け事務マニュアル（請求）と政仁さん向けマニュアル（承認）へ統合済み。個人パスワードの発行手順は森田さんマニュアルの付録へ', url: '/manual-invoice.html', updated: '2026-09-26' },
  { category: 'archive', title: '【お知らせ】最低20日保証と現場都合休の計算変更（8月分から）', desc: '8月分からの計算変更のお知らせ（周知済み）。ルールは休暇管理マニュアル・社労士提出用資料マニュアルに反映済み', url: '/notice-20day-guarantee.html', updated: '2026-10-02' },
  { category: 'archive', title: '奥寺さん向けマニュアル（〜2026年9月）', desc: '森田さん向けマニュアルへ統合済み。出面補助・月次集計・月締め・帳票出力の旧版', url: '/manual-okudera.html', updated: '2026-10-02' },
  { category: 'archive', title: '給与計算マニュアル（奥寺さん用・〜2026年9月）', desc: '給与計算はキャシュモへ委託済み。システムの計算ロジック詳細の記録として保存（検算・保守時の参照用）', url: '/manual-payroll-okudera.html', updated: '2026-10-02' },
  { category: 'archive', title: '道具代管理マニュアル（佐藤さん向け・〜2026年9月）', desc: '森田さん向けマニュアルへ統合済み。購入登録・残額管理の旧版', url: '/manual-sato.html', updated: '2026-09-02' },
  { category: 'archive', title: '新しい給与制度の説明（スライド・2026年5月移行時）', desc: '旧制度→変形労働時間制への移行を対面説明したときのスライド。移行完了につき過去資料', url: '/manual-kyuyo-hikaku-vi.html', updated: '2026-08-01' },
]

const CATEGORY_LABEL: Record<string, string> = {
  guide: 'まずはここから',
  manual: '業務マニュアル',
  staff: 'スタッフ向け',
  archive: '過去資料',
}

function isForRole(item: DocItem, role: Role | null): boolean {
  if (!item.roles) return true // 全員向け
  if (role === 'admin') return true // 管理者は全資料が対象
  if (!role) return true // ロール不明時は全部見せる（安全側）
  return item.roles.includes(role)
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
      const auth = localStorage.getItem('hibi_auth')
      if (auth) {
        const parsed = JSON.parse(auth)
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

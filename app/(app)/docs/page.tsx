'use client'

import { useEffect, useState } from 'react'

type Role = 'admin' | 'approver' | 'foreman' | 'jimu'

interface DocItem {
  title: string
  desc: string
  url: string
  icon: string
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
  { category: 'guide', title: 'ロール別やることチェックリスト', desc: '事務・役員・職長・スタッフが日次／月次／年次で何をすべきかを1ページに集約', url: '/manual-checklist.html', icon: '✅', badge: '日次参照', updated: '2026-07-03' },

  // ── 事務（奥寺さん） ──
  { category: 'manual', roles: ['jimu'], title: '奥寺さん向けマニュアル', desc: '出面補助・月次集計・月締めロック・帳票出力（事務の日常運用。給与計算と有給は各専用マニュアルへ）', url: '/manual-okudera.html', icon: '📘', updated: '2026-08-04' },
  { category: 'manual', roles: ['jimu'], title: '給与計算マニュアル（奥寺さん用）', desc: '月次給与計算のすべて。雇用形態4区分・端数処理・自動検算に加え、8月改訂で 法定休日1.35倍・夜勤・濱上さんの欠勤控除・フンさんの休憩短縮・運転手当 を追加', url: '/manual-payroll-okudera.html', icon: '💰', badge: '8月改訂', updated: '2026-08-31' },
  { category: 'manual', roles: ['jimu'], title: '社労士提出用資料マニュアル', desc: 'HFU分を社労士に渡す資料の説明。変形労働時間制・3段階残業判定・有給日給・提出3資料の読み方・端数処理', url: '/manual-syaroshi.html', icon: '🏛', badge: 'NEW', updated: '2026-06-12' },

  // ── 事業責任者（政仁さん） ──
  { category: 'manual', roles: ['approver'], title: '政仁さん向けマニュアル', desc: '出面の最終承認・有給/帰国申請の承認・就業カレンダー承認（事業責任者の承認業務に特化）', url: '/manual-masahito.html', icon: '📗', updated: '2026-07-03' },

  // ── 職長 ──
  { category: 'manual', roles: ['foreman'], title: '職長向けマニュアル', desc: '毎日の出面確認・就業カレンダー・夜勤の入力。8月改訂で スマホ操作の改善（今日へボタン等）・「欠」入力・同日多現場ガード を追加', url: '/manual-foreman.html', icon: '📕', badge: '8月改訂', updated: '2026-08-31' },

  // ── 有給担当（事務・事業責任者） ──
  { category: 'manual', roles: ['jimu', 'approver'], title: '休暇管理マニュアル', desc: '有給・帰国休暇の唯一の参照元。8月改訂で 年5日の日本人特則・買取上限（残−5日）・買取の自動記録・HFU移籍の勤続通算 を追加', url: '/manual-yukyu.html', icon: '🌴', badge: '8月改訂', updated: '2026-08-31' },

  // ── 経理（佐藤さん） ──
  { category: 'manual', roles: ['jimu'], title: '道具代管理マニュアル（佐藤さん向け）', desc: '購入登録・残額管理。8月改訂で 日本人も対象（年10万円・入社6ヶ月から）・区分別予算・マネーフォワードとの役割分担 を追加', url: '/manual-sato.html', icon: '🔧', badge: '8月改訂', updated: '2026-08-31' },

  // ── 評価（運用前・管理者のみ） ──
  { category: 'manual', roles: ['admin'], title: '評価管理マニュアル（ベトナム人）', desc: '年次評価と時給改定（入社記念日サイクル）。5タブ構成・評価者ウェイト・スコア計算・昇給テーブル', url: '/manual-evaluation.html', icon: '📋', updated: '2026-05-09' },
  { category: 'manual', roles: ['admin', 'approver'], title: '賃金・評価 操作マニュアル（日本人）', desc: '号俸制の年次改定の回し方（評語・代表加算・平均昇給率）と賞与4区分（利益分配・精勤・禁煙・子ども手当）の作成〜確定〜有給買取の自動記録まで', url: '/manual-wage-jp.html', icon: '💴', badge: 'NEW', updated: '2026-08-31' },

  // ── スタッフ向け（全員が内容を把握しておく／スタッフ本人はスマホから） ──
  { category: 'staff', title: 'マイページの使い方（日本人スタッフ向け）', desc: '有給の残数確認と申請・年5日ルール・道具代の残額確認（申請はマネーフォワード）。専用URLの配布時に一緒に渡す1枚もの', url: '/manual-mypage-jp.html', icon: '📱', badge: 'NEW', updated: '2026-08-31' },
  { category: 'staff', title: 'スタッフ向けマニュアル（ベトナム人）', desc: '出勤登録・欠勤届・有給申請・帰国申請・残数確認・未入力の督促バナー（日本語＋ベトナム語）', url: '/staff-manual-vi.html', icon: '👷', badge: '日本語+ベトナム語', updated: '2026-07-30' },
  { category: 'staff', title: '変形労働時間制と残業のルール', desc: '変形労働時間制のしくみ・残業の3段階判定・給料の4層構造・計算例・FAQ（スタッフへの制度説明用）', url: '/manual-henkei-vi.html', icon: '⏰', badge: '日本語+ベトナム語', updated: '2026-08-01' },
  // ── 過去資料（役目を終えたが記録として残す）──
  { category: 'archive', title: '新しい給与制度の説明（スライド・2026年5月移行時）', desc: '旧制度→変形労働時間制への移行を対面説明したときのスライド。移行完了につき過去資料', url: '/manual-kyuyo-hikaku-vi.html', icon: '📦', updated: '2026-08-01' },
]

const CATEGORY_LABEL: Record<string, string> = {
  guide: '🎯 まずはここから',
  manual: '📚 業務マニュアル',
  staff: '👷 スタッフ向け',
  archive: '📦 過去資料',
}

function isForRole(item: DocItem, role: Role | null): boolean {
  if (!item.roles) return true // 全員向け
  if (role === 'admin') return true // 管理者は全資料が対象
  if (!role) return true // ロール不明時は全部見せる（安全側）
  return item.roles.includes(role)
}

function DocCard({ item }: { item: DocItem }) {
  return (
    <a
      href={item.url}
      target={item.internal ? undefined : '_blank'}
      rel={item.internal ? undefined : 'noopener noreferrer'}
      className="block bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 group"
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl">{item.icon}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-hibi-navy dark:text-white group-hover:text-blue-600 transition-colors">{item.title}</span>
            {item.badge && (
              <span className="text-[10px] px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{item.badge}</span>
            )}
            {!item.internal && (
              <span className="text-gray-300 text-xs">↗</span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{item.desc}</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">最終更新: {item.updated}</p>
        </div>
      </div>
    </a>
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

  const mine = DOCS.filter(d => isForRole(d, role))
  const others = DOCS.filter(d => !isForRole(d, role))

  // 「あなた向け」をカテゴリ順に並べる
  const categoryOrder = ['guide', 'manual', 'staff', 'archive']
  const mineByCategory = categoryOrder
    .map(cat => ({ cat, items: mine.filter(d => d.category === cat) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">📁 資料一覧</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">マニュアル・チェックリスト・運用ガイドの一覧</p>
      </div>

      {/* 使い分けの説明 */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700/50 rounded-xl p-4">
        <div className="text-sm font-bold text-blue-900 dark:text-blue-200 mb-2">📌 資料の使い分け</div>
        <div className="space-y-1 text-xs text-blue-800 dark:text-blue-300">
          <div><strong>✅ チェックリスト</strong>：日次・月次でやることを確認したいとき</div>
          <div><strong>📚 マニュアル</strong>：操作方法を調べたいとき（毎日参照）</div>
          <div><strong>⏰ 制度説明</strong>：変形労働時間制などの仕組みを理解したいとき（初回・変更時のみ）</div>
        </div>
      </div>

      {/* 代表専用（賃金分析）。個人の給与を一覧するため workerId=0 にのみ表示 */}
      {isOwner && (
        <a href="/wage-analysis"
          className="block bg-white dark:bg-gray-800 rounded-xl border-2 border-red-200 dark:border-red-800/60 shadow-sm hover:shadow-md transition-shadow p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🔐</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-hibi-navy dark:text-white">賃金分析</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800">代表のみ</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                ベトナム人スタッフの在籍年数と時給の分布。入社時の東京都最低賃金を起点にした昇給率、段階ごとの段差、相対的に高い・低い人の判定
              </p>
            </div>
          </div>
        </a>
      )}

      {/* 賃金改定（日本人）。評価を決めるのは代表と事業責任者（docs/wage-system.md 第4節） */}
      {isManagement && (
        <a href="/wage?tab=revision"
          className="block bg-white dark:bg-gray-800 rounded-xl border-2 border-red-200 dark:border-red-800/60 shadow-sm hover:shadow-md transition-shadow p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">📈</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-hibi-navy dark:text-white">賃金制度（日本人社員）</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800">代表・事業責任者</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                号俸表・調整の基準・年次改定を1つにまとめた画面。改定の数字がどの表から出ているかをその場で辿れる
              </p>
            </div>
          </div>
        </a>
      )}

      {/* あなた向け */}
      {role && role !== 'admin' && (
        <div className="text-sm font-bold text-hibi-navy dark:text-white">
          👤 {ROLE_LABEL[role]}のあなたに関係する資料
        </div>
      )}

      {mineByCategory.map(group => (
        <div key={group.cat}>
          <div className="mb-3">
            <h2 className="text-sm font-bold text-gray-700 dark:text-gray-300 tracking-wide">{CATEGORY_LABEL[group.cat]}</h2>
          </div>
          <div className="space-y-3">
            {group.items.map(item => <DocCard key={item.url} item={item} />)}
          </div>
        </div>
      ))}

      {/* その他の資料（ロールに直接関係しないもの）は折りたたみ */}
      {others.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-bold text-gray-500 dark:text-gray-400 hover:text-hibi-navy dark:hover:text-white select-none">
            📂 その他の資料（{others.length}件）を表示
          </summary>
          <div className="space-y-3 mt-3">
            {others.map(item => <DocCard key={item.url} item={item} />)}
          </div>
        </details>
      )}
    </div>
  )
}

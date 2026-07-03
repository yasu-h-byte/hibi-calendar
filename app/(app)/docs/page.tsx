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
  { category: 'guide', title: 'ロール別やることチェックリスト', desc: '事務・役員・職長・スタッフが日次／月次／年次で何をすべきかを1ページに集約', url: '/manual-checklist.html', icon: '✅', badge: '日次参照', updated: '2026-04-30' },
  { category: 'guide', title: '運用ガイド', desc: '変形労働時間制・3段階残業判定・3層構造給与・通知ベルなどの仕組みの解説', url: '/guide', icon: '📖', internal: true, badge: '初回読了推奨', updated: '2026-04-18' },

  // ── 事務（奥寺さん） ──
  { category: 'manual', roles: ['jimu'], title: '奥寺さん向けマニュアル', desc: '出面入力・月次集計・給与計算・帳票出力（事務担当 総合版）', url: '/manual-okudera.html', icon: '📘', updated: '2026-04-26' },
  { category: 'manual', roles: ['jimu'], title: '給与計算マニュアル（奥寺さん用）', desc: '日比建設の月次給与計算。雇用形態4区分・日本人日給月給の有給手当・フンさんの固定月給・ベトナム人の有給日給・週所定での残業判定・端数処理・月締めの前提条件・自動検算・社労士提出用資料など', url: '/manual-payroll-okudera.html', icon: '💰', badge: 'NEW', updated: '2026-06-23' },
  { category: 'manual', roles: ['jimu'], title: '社労士提出用資料マニュアル', desc: 'HFU分を社労士に渡す資料の説明。変形労働時間制・3段階残業判定・有給日給・提出3資料の読み方・端数処理', url: '/manual-syaroshi.html', icon: '🏛', badge: 'NEW', updated: '2026-06-12' },

  // ── 事業責任者（政仁さん） ──
  { category: 'manual', roles: ['approver'], title: '政仁さん向けマニュアル', desc: '出面承認・就業カレンダー・原価収益（役員担当）', url: '/manual-masahito.html', icon: '📗', updated: '2026-04-30' },

  // ── 職長 ──
  { category: 'manual', roles: ['foreman'], title: '職長向けマニュアル', desc: '毎日の出面確認・ロック／就業カレンダー作成／出面グリッドの読み方（1冊に統合）', url: '/manual-foreman.html', icon: '📕', updated: '2026-07-03' },

  // ── 有給担当（事務・事業責任者） ──
  { category: 'manual', roles: ['jimu', 'approver'], title: '休暇管理マニュアル', desc: '有給・帰国・時季指定・期末買取・時効処理など休暇関連の全機能', url: '/manual-yukyu.html', icon: '🌴', updated: '2026-04-30' },

  // ── 経理（佐藤さん） ──
  { category: 'manual', roles: ['jimu'], title: '道具代管理マニュアル（佐藤さん向け）', desc: '道具代補助の購入登録・残額管理・年度切り替え', url: '/manual-sato.html', icon: '🔧', updated: '2026-04-20' },

  // ── 評価（運用前・管理者のみ） ──
  { category: 'manual', roles: ['admin'], title: '評価管理マニュアル', desc: '5タブ画面構成・評価者ウェイト・提出状況の可視化・進捗監視・履歴閲覧・スコア計算・昇給テーブル', url: '/manual-evaluation.html', icon: '📋', badge: 'NEW', updated: '2026-05-09' },

  // ── スタッフ向け（全員が内容を把握しておく／スタッフ本人はスマホから） ──
  { category: 'staff', title: 'スタッフ向けマニュアル', desc: '出勤登録・欠勤届・有給申請・帰国申請・残数確認の使い方（日本語＋ベトナム語）', url: '/staff-manual-vi.html', icon: '👷', badge: '日本語+ベトナム語', updated: '2026-07-03' },
  { category: 'staff', roles: ['foreman', 'jimu'], title: 'QRコードカード（印刷用）', desc: '全スタッフの出勤入力用QRコード', url: '/qr-cards.html', icon: '📱', updated: '2026-04-08' },
]

const CATEGORY_LABEL: Record<string, string> = {
  guide: '🎯 まずはここから',
  manual: '📚 業務マニュアル',
  staff: '👷 スタッフ向け（ベトナム人）',
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

  useEffect(() => {
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (auth) {
        const parsed = JSON.parse(auth)
        const r = parsed?.user?.role
        if (r === 'admin' || r === 'approver' || r === 'foreman' || r === 'jimu') {
          setRole(r)
        }
      }
    } catch {
      // ロール取得に失敗しても全資料を表示するだけなので無視
    }
  }, [])

  const mine = DOCS.filter(d => isForRole(d, role))
  const others = DOCS.filter(d => !isForRole(d, role))

  // 「あなた向け」をカテゴリ順に並べる
  const categoryOrder = ['guide', 'manual', 'staff']
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
          <div><strong>📖 運用ガイド</strong>：制度や仕組みを理解したいとき（初回・変更時のみ）</div>
        </div>
      </div>

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

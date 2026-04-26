'use client'

export default function DocsPage() {
  interface DocItem { title: string; desc: string; url: string; icon: string; badge?: string; internal?: boolean; updated: string }
  const docs: { category: string; description?: string; items: DocItem[] }[] = [
    {
      category: '🎯 ロール別チェックリスト',
      description: 'まずはここから。日次・月次でやることをロール別に整理',
      items: [
        { title: 'ロール別やることチェックリスト', desc: '事務・役員・職長・スタッフが日次／月次／年次で何をすべきかを1ページに集約', url: '/manual-checklist.html', icon: '✅', badge: '日次参照', updated: '2026-04-26' },
      ],
    },
    {
      category: '📚 業務マニュアル',
      description: '各ロールごとの操作マニュアル。日々の作業はここを参照',
      items: [
        { title: '奥寺さん向けマニュアル', desc: '出面入力・月次集計・給与計算・帳票出力（事務担当）', url: '/manual-okudera.html', icon: '📘', updated: '2026-04-26' },
        { title: '政仁さん向けマニュアル', desc: '出面承認・就業カレンダー・原価収益（役員担当）', url: '/manual-masahito.html', icon: '📗', updated: '2026-04-26' },
        { title: '職長向けマニュアル', desc: '出面入力・承認・カレンダー作成（職長担当）', url: '/manual-foreman.html', icon: '📕', updated: '2026-04-26' },
        { title: '休暇管理マニュアル', desc: '有給・帰国・時季指定・期末買取・時効処理など休暇関連の全機能', url: '/manual-yukyu.html', icon: '🌴', updated: '2026-04-26' },
        { title: '評価管理マニュアル', desc: '複数評価者による評価入力・承認・昇給テーブル', url: '/manual-evaluation.html', icon: '📋', updated: '2026-04-19' },
        { title: '道具代管理マニュアル（佐藤さん向け）', desc: '道具代補助の購入登録・残額管理・年度切り替え', url: '/manual-sato.html', icon: '🔧', updated: '2026-04-20' },
      ],
    },
    {
      category: '👷 スタッフ向け（ベトナム人）',
      description: 'スタッフ自身が読むマニュアル。日越二言語',
      items: [
        { title: 'スタッフ向けマニュアル', desc: '出勤登録・欠勤届・有給申請・帰国申請・残数確認の使い方', url: '/staff-manual-vi.html', icon: '👷', badge: '日本語+ベトナム語', updated: '2026-04-21' },
        { title: 'QRコードカード（印刷用）', desc: '全スタッフの出勤入力用QRコード', url: '/qr-cards.html', icon: '📱', updated: '2026-04-08' },
      ],
    },
    {
      category: '📖 システムガイド（制度・概念）',
      description: 'システムの仕組みや業務制度の解説。一度読めばOK',
      items: [
        { title: '運用ガイド', desc: '変形労働時間制・3段階残業判定・3層構造給与・通知ベルなどの仕組みの解説', url: '/guide', icon: '📖', internal: true, badge: '初回読了推奨', updated: '2026-04-18' },
      ],
    },
  ]

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

      {docs.map(cat => (
        <div key={cat.category}>
          <div className="mb-3">
            <h2 className="text-sm font-bold text-gray-700 dark:text-gray-300 tracking-wide">{cat.category}</h2>
            {cat.description && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{cat.description}</p>
            )}
          </div>
          <div className="space-y-3">
            {cat.items.map(item => (
              <a
                key={item.url}
                href={item.url}
                target={item.internal ? undefined : '_blank'}
                rel={item.internal ? undefined : 'noopener noreferrer'}
                className="block bg-white dark:bg-gray-800 rounded-xl shadow hover:shadow-md transition-shadow p-4 group"
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
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

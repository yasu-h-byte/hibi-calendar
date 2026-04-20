'use client'

export default function DocsPage() {
  interface DocItem { title: string; desc: string; url: string; icon: string; badge?: string; internal?: boolean; updated: string }
  const docs: { category: string; items: DocItem[] }[] = [
    {
      category: '説明会資料',
      items: [
        { title: '給与制度説明会（2026/4/19）', desc: '3層構造・残業3段階判定・スマホ入力・カレンダー署名の説明・日越二言語', url: '/briefing-20260419.html', icon: '🎤', badge: '日本語+ベトナム語', updated: '2026-04-18' },
      ],
    },
    {
      category: '業務マニュアル',
      items: [
        { title: '奥寺さん向けマニュアル', desc: '出面入力・月次集計・給与計算・有給管理（2段階承認）・有給データ移行・帳票出力', url: '/manual-okudera.html', icon: '📘', updated: '2026-04-18' },
        { title: '政仁さん向けマニュアル', desc: '出面入力・承認・就業カレンダー・有給2段階承認・原価収益・出向・外注先単価', url: '/manual-masahito.html', icon: '📗', updated: '2026-04-18' },
        { title: '職長向けマニュアル', desc: '出面入力・承認・カレンダー作成・有給の職長承認・外注先単価・通知ベル', url: '/manual-foreman.html', icon: '📕', updated: '2026-04-18' },
        { title: '評価管理マニュアル', desc: '複数評価者による評価の入力・承認・昇給テーブル', url: '/manual-evaluation.html', icon: '📋', updated: '2026-04-19' },
        { title: '佐藤さん向けマニュアル（道具代管理）', desc: '道具代補助の購入登録・残額管理・年度切り替え', url: '/manual-sato.html', icon: '🔧', updated: '2026-04-20' },
        { title: '有給データ移行手順', desc: '旧スプレッドシートからの有給データ移行（出面に「有」を入力）', url: '/manual-yukyu.html', icon: '📙', updated: '2026-04-18' },
        { title: 'QRコードカード（印刷用）', desc: '全スタッフの出勤入力用QRコード。印刷して配布', url: '/qr-cards.html', icon: '📱', updated: '2026-04-08' },
      ],
    },
    {
      category: 'システムガイド',
      items: [
        { title: '運用ガイド', desc: '変形労働時間制・3段階残業判定・3層構造給与・時間ベース入力・Excel出力・通知ベル', url: '/guide', icon: '📖', internal: true, updated: '2026-04-18' },
      ],
    },
  ]

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy dark:text-white">資料一覧</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">マニュアル・説明会資料・ガイド</p>
      </div>

      {docs.map(cat => (
        <div key={cat.category}>
          <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">{cat.category}</h2>
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
                    <div className="flex items-center gap-2">
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

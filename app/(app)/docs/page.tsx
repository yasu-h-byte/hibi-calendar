'use client'

export default function DocsPage() {
  interface DocItem { title: string; desc: string; url: string; icon: string; badge?: string; internal?: boolean }
  const docs: { category: string; items: DocItem[] }[] = [
    {
      category: '説明会資料',
      items: [
        { title: '給与制度説明会（2026/4/19）', desc: 'ベトナム人スタッフ向け・日越二言語', url: '/briefing-20260419.html', icon: '🎤', badge: '日本語+ベトナム語' },
      ],
    },
    {
      category: '業務マニュアル',
      items: [
        { title: '奥寺さん向けマニュアル', desc: '有給管理・月次集計・給与計算・帳票出力', url: '/manual-okudera.html', icon: '📘' },
        { title: '政仁さん向けマニュアル', desc: '出面入力・承認・就業カレンダー', url: '/manual-masahito.html', icon: '📗' },
        { title: '有給データ移行手順', desc: '旧スプレッドシートからの有給データ移行', url: '/manual-yukyu.html', icon: '📙' },
      ],
    },
    {
      category: 'システムガイド',
      items: [
        { title: '運用ガイド', desc: '変形労働時間制の制度設計とシステム運用の手引き', url: '/guide', icon: '📖', internal: true },
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

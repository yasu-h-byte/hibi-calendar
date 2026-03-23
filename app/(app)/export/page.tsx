'use client'

const EXPORT_CARDS = [
  {
    icon: '📊',
    title: '日比建設向け 出面一覧',
    description: '日比建設所属の全社員・現場別の出面データをExcel形式で出力します。月次の勤怠集計に利用できます。',
    format: 'Excel出力',
  },
  {
    icon: '📊',
    title: 'HFU向け 出面一覧',
    description: 'HFU所属の実習生・特定技能生の出面データをExcel形式で出力します。管理団体への報告に利用できます。',
    format: 'Excel出力',
  },
  {
    icon: '📄',
    title: '外注先向け 出面確認書',
    description: '外注先ごとの出面確認書をExcel形式で出力します。外注先への送付・確認用です。',
    format: 'Excel出力',
  },
  {
    icon: '📐',
    title: '歩掛管理表',
    description: '現場別の歩掛（人工数・鳶換算）をExcel形式で出力します。原価管理・見積もりに活用できます。',
    format: 'Excel出力',
  },
  {
    icon: '📈',
    title: '月次レポート',
    description: '月次の売上・原価・粗利をグラフ付きPDFで出力します。経営会議や報告書に利用できます。',
    format: 'PDF出力',
  },
  {
    icon: '🌴',
    title: '有給管理台帳',
    description: '全社員の有給付与・消化・残日数をExcel形式で出力します。労務管理・監査対応に利用できます。',
    format: 'Excel出力',
  },
]

export default function ExportPage() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-hibi-navy">帳票出力</h1>
        <p className="text-sm text-gray-500 mt-1">各種帳票をExcel/PDF形式でダウンロードできます</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {EXPORT_CARDS.map((card, i) => (
          <div key={i} className="bg-white rounded-xl shadow p-5 flex flex-col">
            <div className="text-3xl mb-3">{card.icon}</div>
            <h3 className="font-bold text-hibi-navy text-sm mb-1">{card.title}</h3>
            <p className="text-xs text-gray-500 mb-4 flex-1">{card.description}</p>
            <button
              onClick={() => alert('準備中です')}
              className="w-full bg-hibi-navy text-white rounded-lg py-2 text-sm font-medium hover:bg-hibi-light transition flex items-center justify-center gap-2"
            >
              <span>{card.format === 'PDF出力' ? '📥' : '📥'}</span>
              <span>{card.format}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export const metadata = { title: '運用ガイド（移転しました）' }

/**
 * 旧・運用ガイド（2026-08-31 廃止）
 *
 * 2026年4月に作った初期の制度解説。内容が古くなり（変形労働時間制の解説は
 * 「変形労働時間制と残業のルール」、日々の操作は「ロール別やることチェックリスト」が
 * 最新）、二重管理を避けるため資料一覧から外した。ブックマーク対策でリダイレクト案内だけ残す。
 */
import Link from 'next/link'

export default function GuidePage() {
  return (
    <div className="max-w-2xl mx-auto py-16 px-4 text-center space-y-6">
      <div className="text-4xl">📦</div>
      <h1 className="text-xl font-bold text-hibi-navy dark:text-white">運用ガイドは統合されました</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
        このページの内容は以下の2つの資料に引き継がれています。<br />
        お手数ですがブックマークの変更をお願いします。
      </p>
      <div className="space-y-3 max-w-md mx-auto text-left">
        <a href="/manual-checklist.html" className="block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:border-hibi-navy transition">
          <div className="font-bold text-sm">✅ ロール別やることチェックリスト</div>
          <div className="text-xs text-gray-500 mt-1">日次・月次・年次の操作の入口</div>
        </a>
        <a href="/manual-henkei-vi.html" className="block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:border-hibi-navy transition">
          <div className="font-bold text-sm">⏰ 変形労働時間制と残業のルール</div>
          <div className="text-xs text-gray-500 mt-1">制度のしくみ・残業判定・給与構造の解説</div>
        </a>
      </div>
      <Link href="/docs" className="inline-block text-sm text-hibi-navy dark:text-blue-300 underline">資料一覧へ戻る</Link>
    </div>
  )
}

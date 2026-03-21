import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-6">
        <h1 className="text-2xl font-bold text-hibi-navy">HIBI CONSTRUCTION</h1>
        <p className="text-gray-500">就業カレンダー署名システム</p>
        <Link
          href="/admin/calendar"
          className="inline-block bg-hibi-navy text-white px-6 py-3 rounded-lg hover:bg-hibi-light transition"
        >
          管理者画面
        </Link>
      </div>
    </div>
  )
}

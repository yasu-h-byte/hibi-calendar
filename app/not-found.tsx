/**
 * 存在しないページ（2026-11-10 全体点検）。旧: Next.js 標準の英語の 404 だった。
 * スタッフの古いリンクでも来るので、日本語とベトナム語を並べる。
 */
import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-hibi-bg p-6">
      <div className="w-full max-w-md bg-white rounded-[10px] border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-bold text-gray-900">ページが見つかりません</h1>
        <p className="text-sm text-hibi-sub mt-1" lang="vi">Không tìm thấy trang</p>
        <p className="text-sm text-gray-700 mt-4">
          リンクが古いか、入力したアドレスが違っています。
        </p>
        <p className="text-sm text-hibi-sub mt-1" lang="vi">Đường dẫn cũ hoặc địa chỉ không đúng.</p>
        <Link
          href="/"
          className="flex items-center justify-center w-full mt-5 h-12 bg-hibi-navy text-white rounded-[10px] font-bold text-base hover:bg-hibi-light transition"
        >
          最初の画面へ
        </Link>
        <p className="text-xs text-hibi-sub mt-4">
          スマホ用のリンクが開けないときは、事務所に知らせてください。
          <span className="block mt-1" lang="vi">Nếu không mở được, hãy báo cho văn phòng.</span>
        </p>
      </div>
    </main>
  )
}

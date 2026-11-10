'use client'
/**
 * 画面でエラーが起きたときの表示（2026-11-10 全体点検）。
 * 旧: error.tsx が1つも無く、Next.js 標準の英語の画面（Application error）になっていた。
 * 管理画面もスタッフのスマホ画面もここに来るので、日本語とベトナム語を並べる。
 * エラーの中身（内部の文）は画面に出さない。問い合わせ用に digest（番号）だけ出す。
 */
import { useEffect } from 'react'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[画面のエラー]', error) }, [error])
  return (
    <main className="min-h-screen flex items-center justify-center bg-hibi-bg p-6">
      <div className="w-full max-w-md bg-white rounded-[10px] border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-bold text-gray-900">画面を表示できませんでした</h1>
        <p className="text-sm text-hibi-sub mt-1" lang="vi">Không hiển thị được màn hình</p>
        <p className="text-sm text-gray-700 mt-4">
          入力した内容は、保存の表示が出ていれば残っています。「もう一度」を押してください。
        </p>
        <p className="text-sm text-hibi-sub mt-1" lang="vi">Hãy bấm「Thử lại」.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="w-full mt-5 h-12 bg-hibi-navy text-white rounded-[10px] font-bold text-base hover:bg-hibi-light transition"
        >
          もう一度 / Thử lại
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full mt-2 h-10 text-sm text-hibi-sub hover:text-gray-900 rounded-[10px] hover:bg-hibi-bg"
        >
          ページを読み込み直す / Tải lại trang
        </button>
        <p className="text-xs text-hibi-sub mt-4">
          何度も出るときは、事務所に知らせてください。
          {error.digest ? <span className="block mt-1">番号: {error.digest}</span> : null}
        </p>
      </div>
    </main>
  )
}

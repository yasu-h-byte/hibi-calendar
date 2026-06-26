'use client'

/**
 * /calendar/public — 【廃止】2026-06
 *
 * 旧「名前を一覧から選んで承認」する公開ページ。誰でも他人の名前で押せる
 * なりすましリスクがあったため廃止。承認は各スタッフ本人のトークン付き個人リンク
 * （出面入力で使う /attendance/[token]）に一本化した。
 *
 * このページは案内のみを表示する（旧UIは git 履歴を参照）。
 */
export default function PublicCalendarRetiredPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center p-4">
      <div className="bg-white rounded-2xl shadow max-w-md w-full mt-10 p-6 text-center space-y-4">
        <div className="text-4xl">🔒</div>
        <h1 className="text-lg font-bold text-hibi-navy leading-snug">
          この承認ページは使えなくなりました
          <br />
          <span className="text-sm text-gray-500 font-normal">Trang ký này đã ngừng sử dụng</span>
        </h1>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-left text-sm text-gray-800 leading-relaxed space-y-2">
          <p>
            カレンダーの承認は、<b>ご自身専用のリンク</b>（出面入力で使っている QR / リンク）から
            行ってください。そこではご本人だけが承認できます。
          </p>
          <p className="text-xs text-gray-500">
            Vui lòng ký xác nhận lịch từ <b>link cá nhân của bạn</b> (QR / link dùng để chấm công).
            Chỉ chính bạn mới ký được ở đó.
          </p>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-xs text-gray-500 leading-relaxed">
          管理者の方へ：各スタッフの個人リンク・QR は「スタッフ管理」画面から配布できます。
        </div>
      </div>
    </div>
  )
}

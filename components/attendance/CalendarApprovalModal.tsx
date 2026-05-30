/**
 * 翌月カレンダー承認モーダル（attendance/[token]/page.tsx から抽出）
 *
 * 本人のトークンで認証された外国人スタッフが、翌月の全現場カレンダーを
 * 確認してサインするモーダル。日本語＋ベトナム語の二言語表記。
 */
'use client'

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

export interface PendingCalendarSite {
  siteId: string
  siteName: string
  status: 'approved' | 'draft' | 'submitted' | null
  days: Record<string, string> | null
  signed: boolean
  signedAt: string | null
}

export interface PendingCalendarData {
  workerId: number
  workerName: string
  ym: string  // "YYYY-MM"
  allApproved: boolean
  fullMonthHomeLeave: boolean
  sites: PendingCalendarSite[]
}

interface Props {
  pendingCalendar: PendingCalendarData
  reviewed: boolean
  onReviewedChange: (next: boolean) => void
  signing: boolean
  onSubmit: () => void
  onClose: () => void
  errorMsg: string | null
}

export default function CalendarApprovalModal({
  pendingCalendar,
  reviewed,
  onReviewedChange,
  signing,
  onSubmit,
  onClose,
  errorMsg,
}: Props) {
  const [y, m] = pendingCalendar.ym.split('-')
  const yearNum = parseInt(y)
  const monthNum = parseInt(m)
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate()
  const firstDow = new Date(yearNum, monthNum - 1, 1).getDay()  // 0=日

  // 表示対象: 承認済み × 未署名（または既署名）の現場
  const targetSites = pendingCalendar.sites.filter(s => s.status === 'approved')
  const unsignedSites = targetSites.filter(s => !s.signed)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-2 flex items-start sm:items-center justify-center overflow-y-auto"
      onClick={() => !signing && onClose()}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg my-4 flex flex-col max-h-[95vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="bg-hibi-navy text-white px-4 py-3 rounded-t-xl flex items-center justify-between">
          <div>
            <div className="font-bold text-lg leading-tight">
              {yearNum}年{monthNum}月 カレンダー承認
            </div>
            <div className="text-xs opacity-80">
              Xác nhận lịch tháng {monthNum}/{yearNum}
            </div>
          </div>
          <button
            onClick={() => !signing && onClose()}
            className="text-white/80 hover:text-white text-2xl leading-none"
            disabled={signing}
          >
            &times;
          </button>
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
            下のカレンダーを見て、出勤日 / 休日 を確認してください。問題なければ承認してください。
            <br />
            Hãy xem lịch dưới đây để xác nhận ngày làm việc / ngày nghỉ. Nếu không có vấn đề, hãy ký xác nhận.
          </div>

          {targetSites.map(site => (
            <div key={site.siteId} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className={`px-3 py-2 flex items-center justify-between ${site.signed ? 'bg-green-50' : 'bg-gray-50'}`}>
                <div className="font-bold text-sm text-hibi-navy">{site.siteName}</div>
                {site.signed && (
                  <span className="text-[10px] bg-green-200 text-green-800 px-2 py-0.5 rounded-full font-bold">
                    ✓ 署名済み
                  </span>
                )}
              </div>
              {/* カレンダーグリッド */}
              <div className="p-2">
                <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]">
                  {DOW_LABELS.map((d, i) => (
                    <div key={d} className={`py-1 font-bold ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-600'}`}>{d}</div>
                  ))}
                  {Array.from({ length: firstDow }).map((_, i) => (
                    <div key={`pad-${i}`} className="py-2" />
                  ))}
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const day = i + 1
                    const dow = (firstDow + i) % 7
                    const dayType = site.days?.[String(day)] || 'work'
                    const isOff = dayType === 'off' || dayType === 'holiday'
                    return (
                      <div
                        key={day}
                        className={`py-1.5 rounded text-[11px] font-medium ${
                          isOff
                            ? 'bg-gray-200 text-gray-500'
                            : dow === 0 ? 'bg-red-50 text-red-600' : dow === 6 ? 'bg-blue-50 text-blue-600' : 'bg-blue-100 text-blue-800'
                        }`}
                        title={isOff ? '休み / Nghỉ' : '出勤 / Đi làm'}
                      >
                        {day}
                      </div>
                    )
                  })}
                </div>
                <div className="flex gap-3 mt-2 text-[10px] text-gray-500 justify-center">
                  <span><span className="inline-block w-2.5 h-2.5 bg-blue-100 rounded-sm mr-1 align-middle" />出勤</span>
                  <span><span className="inline-block w-2.5 h-2.5 bg-gray-200 rounded-sm mr-1 align-middle" />休み</span>
                </div>
              </div>
            </div>
          ))}

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-red-700 text-sm text-center">
              {errorMsg}
            </div>
          )}
        </div>

        {/* フッター: 確認チェック + 承認ボタン */}
        <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 rounded-b-xl space-y-3">
          {unsignedSites.length === 0 ? (
            <div className="text-center text-sm text-green-700 font-bold">
              すべて署名済みです / Đã ký tất cả
            </div>
          ) : (
            <>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={e => onReviewedChange(e.target.checked)}
                  className="mt-1 w-5 h-5 rounded"
                />
                <span className="text-sm text-gray-800 leading-tight">
                  カレンダーを確認しました
                  <br />
                  <span className="text-xs text-gray-500">Tôi đã xem lịch</span>
                </span>
              </label>
              <button
                onClick={onSubmit}
                disabled={!reviewed || signing}
                className={`w-full py-3 rounded-xl font-bold text-base transition ${
                  reviewed && !signing
                    ? 'bg-orange-500 text-white hover:bg-orange-600 active:scale-95'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                {signing
                  ? '送信中... / Đang gửi...'
                  : `${unsignedSites.length}件のカレンダーを承認する / Ký ${unsignedSites.length} lịch`
                }
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

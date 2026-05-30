/**
 * 有給申請モーダル（attendance/[token]/page.tsx から抽出）
 *
 * スタッフが自分のスマホから有給を申請するモーダル。
 * 日本語＋ベトナム語の二言語表記。日付範囲指定 + 任意理由。
 */
'use client'

export interface LeaveRequestData {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled'
  reason: string
  rejectedReason?: string
  requestedAt: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  // フォーム状態
  dateFrom: string
  setDateFrom: (s: string) => void
  dateTo: string
  setDateTo: (s: string) => void
  reason: string
  setReason: (s: string) => void
  // フィードバック
  successMsg: string | null
  errorMsg: string | null
  submitting: boolean
  // 申請履歴
  requests: LeaveRequestData[]
  // アクション
  onSubmit: () => void
  onCancelRequest: (requestId: string) => void
}

// 最短申請日 = 今日 + 5日
function getMinDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 5)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatLeaveDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
}

export default function LeaveRequestModal({
  isOpen,
  onClose,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  reason,
  setReason,
  successMsg,
  errorMsg,
  submitting,
  requests,
  onSubmit,
  onCancelRequest,
}: Props) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy mb-4 text-center">
          有給申請 / Xin nghỉ phép
        </h3>

        {successMsg && (
          <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold mb-3 animate-pulse">
            しんせい しました / Da gui don
          </div>
        )}
        {errorMsg && (
          <div className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm mb-3">
            {errorMsg}
          </div>
        )}

        {/* Date picker (range) */}
        <div className="mb-4">
          <label className="text-sm text-gray-600 font-bold block mb-2">
            日付を選んでください / Chọn ngày nghỉ
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">開始日 / Từ ngày</label>
              <input
                type="date"
                value={dateFrom}
                min={getMinDate()}
                onChange={e => {
                  setDateFrom(e.target.value)
                  if (!dateTo || e.target.value > dateTo) setDateTo(e.target.value)
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">終了日 / Đến ngày</label>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || getMinDate()}
                onChange={e => setDateTo(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
              />
            </div>
          </div>
          {dateFrom && dateTo && dateFrom !== dateTo && (
            <p className="text-xs text-blue-600 mt-2 font-bold">
              {(() => {
                const from = new Date(dateFrom + 'T00:00:00')
                const to = new Date(dateTo + 'T00:00:00')
                let count = 0
                const c = new Date(from)
                while (c <= to) { if (c.getDay() !== 0) count++; c.setDate(c.getDate() + 1) }
                return `${count}日分の申請になります / Sẽ gửi ${count} ngày`
              })()}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            ※ 5日前から選べます / Chọn được từ 5 ngày trước
          </p>
        </div>

        {/* Reason */}
        <div className="mb-4">
          <label className="text-sm text-gray-600 block mb-1">
            理由（任意）/ Lý do (tùy chọn)
          </label>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="通院、予定など"
            className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
          />
        </div>

        {/* Submit */}
        <button
          onClick={onSubmit}
          disabled={submitting || !dateFrom}
          className="w-full bg-green-500 hover:bg-green-600 active:bg-green-700 text-white rounded-xl py-3 font-bold text-base transition disabled:opacity-50 active:scale-95"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              そうしんちゅう / Đang gửi...
            </span>
          ) : '有給を申請する / Gửi đơn nghỉ phép'}
        </button>

        {/* Request history */}
        {requests.length > 0 && (
          <div className="mt-6">
            <div className="text-sm text-gray-500 font-bold mb-2">
              申請の状況 / Trạng thái đơn
            </div>
            <div className="space-y-2">
              {requests.map(req => (
                <div key={req.id} className={`flex items-center justify-between py-2 px-3 rounded-lg ${req.status === 'cancelled' ? 'bg-gray-100 opacity-60' : 'bg-gray-50'}`}>
                  <span className="text-sm text-gray-700 font-medium">
                    {formatLeaveDate(req.date)}
                  </span>
                  <div className="flex items-center gap-2">
                    {req.status === 'approved' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-bold">
                        ✅ 承認済 / Đã duyệt
                      </span>
                    )}
                    {req.status === 'foreman_approved' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                        🔵 職長済 / Đốc công đã duyệt
                      </span>
                    )}
                    {req.status === 'pending' && (
                      <>
                        <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                          ⏳ 承認待ち / Đang chờ
                        </span>
                        <button
                          onClick={() => onCancelRequest(req.id)}
                          className="text-xs px-2 py-1 rounded-full bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 active:scale-95"
                        >
                          取り消し / Hủy
                        </button>
                      </>
                    )}
                    {req.status === 'rejected' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold" title={req.rejectedReason || ''}>
                        ❌ 却下 / Từ chối
                      </span>
                    )}
                    {req.status === 'cancelled' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-200 text-gray-500 font-medium">
                        🚫 取り消し済 / Đã hủy
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full mt-4 bg-gray-200 text-gray-600 rounded-xl py-3 text-sm"
        >
          閉じる / Đóng
        </button>
      </div>
    </div>
  )
}

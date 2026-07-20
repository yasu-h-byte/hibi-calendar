/**
 * 帰国（一時帰国・ビザ更新等）申請モーダル（attendance/[token]/page.tsx から抽出）
 *
 * スタッフが自分のスマホから帰国を申請するモーダル。
 * 原則3ヶ月前まで（緊急時は会社相談）の制約あり。
 */
'use client'

export interface HomeLongLeaveRequest {
  id: string
  startDate: string
  endDate: string
  reason: string
  status: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  startDate: string
  setStartDate: (s: string) => void
  endDate: string
  setEndDate: (s: string) => void
  reason: string
  setReason: (s: string) => void
  note: string
  setNote: (s: string) => void
  successMsg: string | null
  errorMsg: string | null
  setErrorMsg: (s: string | null) => void
  submitting: boolean
  requests: HomeLongLeaveRequest[]
  onSubmit: () => void
  onCancelRequest: (requestId: string) => void
}

// 最短申請日 = 今日 + 90日（原則3ヶ月前まで）
function getHlMinDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 90)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']

// 日付選択肢生成（minから180日間）
function getHlDateOptions(minDateStr?: string): { value: string; label: string }[] {
  const min = minDateStr || getHlMinDate()
  const start = new Date(min + 'T00:00:00')
  const options: { value: string; label: string }[] = []
  for (let i = 0; i < 180; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${DOW_LABELS[d.getDay()]}）`
    options.push({ value: val, label })
  }
  return options
}

function formatMD(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
}

export default function HomeLongLeaveModal({
  isOpen,
  onClose,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  reason,
  setReason,
  note,
  setNote,
  successMsg,
  errorMsg,
  setErrorMsg,
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
          帰国申請 / Xin về nước
        </h3>

        {successMsg && (
          <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold mb-3 animate-pulse">
            {successMsg}
          </div>
        )}
        {errorMsg && (
          <div className="bg-red-100 text-red-600 rounded-xl p-3 text-center text-sm mb-3">
            {errorMsg}
          </div>
        )}

        {/* Date range picker */}
        <div className="mb-4">
          <label className="text-sm text-gray-600 font-bold block mb-2">
            期間を選んでください / Chọn thời gian
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">出発日 / Ngày đi</label>
              <select
                value={startDate}
                onChange={e => {
                  const val = e.target.value
                  setErrorMsg(null)
                  setStartDate(val)
                  // 出発日を変えたら帰国日も連動して +7日 に再計算
                  const d = new Date(val + 'T00:00:00')
                  d.setDate(d.getDate() + 7)
                  setEndDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base bg-white"
              >
                {getHlDateOptions().map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">帰国日 / Ngày về</label>
              <select
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base bg-white"
              >
                {startDate && getHlDateOptions(startDate).slice(1).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            ※ 原則3ヶ月前までに申請してください / Nguyên tắc nộp đơn trước 3 tháng<br/>
            <span style={{ fontSize: 11, color: '#999' }}>（緊急の場合は会社に相談してください / Trường hợp khẩn cấp hãy liên hệ công ty）</span>
          </p>
        </div>

        {/* Reason radio buttons */}
        <div className="mb-4">
          <label className="text-sm text-gray-600 font-bold block mb-2">
            理由 / Lý do
          </label>
          <div className="space-y-2">
            {[
              { value: '一時帰国', label: '一時帰国', vi: 'Về nước tạm thời' },
              { value: 'ビザ更新帰国', label: 'ビザ更新帰国', vi: 'Về nước gia hạn visa' },
              { value: 'その他', label: 'その他', vi: 'Khác' },
            ].map(opt => (
              <label key={opt.value} className="flex items-center gap-3 cursor-pointer py-1.5 px-3 rounded-lg hover:bg-gray-50">
                <input
                  type="radio"
                  name="hlReason"
                  value={opt.value}
                  checked={reason === opt.value}
                  onChange={e => setReason(e.target.value)}
                  className="w-5 h-5 text-purple-600"
                />
                <span className="text-sm text-gray-700">{opt.label} / {opt.vi}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Note */}
        <div className="mb-4">
          <label className="text-sm text-gray-600 block mb-1">
            備考（任意）/ Ghi chú (tùy chọn)
          </label>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="飛行機の予定など"
            className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
          />
        </div>

        {/* Submit */}
        <button
          onClick={onSubmit}
          disabled={submitting || !startDate || !endDate || startDate < getHlMinDate()}
          className="w-full bg-purple-500 hover:bg-purple-600 active:bg-purple-700 text-white rounded-xl py-3 font-bold text-base transition disabled:opacity-50 active:scale-95"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              そうしんちゅう / Đang gửi...
            </span>
          ) : '帰国を申請する / Gửi đơn xin về nước'}
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
                  <div className="min-w-0">
                    <span className="text-sm text-gray-700 font-medium">
                      {/* 復帰未定は番兵終了日(9999-12-31)。仮日付ではなく「未定」と表示 */}
                      {formatMD(req.startDate)} 〜 {req.endDate >= '9999-12-31' ? '未定 / Chưa xác định' : formatMD(req.endDate)}
                    </span>
                    <span className="text-xs text-gray-400 ml-2">{req.reason}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {req.status === 'approved' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-bold">
                        承認済 / Đã duyệt
                      </span>
                    )}
                    {req.status === 'foreman_approved' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-bold">
                        職長済 / Đốc công đã duyệt
                      </span>
                    )}
                    {req.status === 'pending' && (
                      <>
                        <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-bold">
                          承認待ち / Đang chờ
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
                      <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold">
                        却下 / Từ chối
                      </span>
                    )}
                    {req.status === 'cancelled' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-200 text-gray-500 font-medium">
                        取り消し済 / Đã hủy
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

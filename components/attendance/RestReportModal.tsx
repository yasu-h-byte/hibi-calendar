/**
 * 欠勤届モーダル（attendance/[token]/page.tsx から抽出）
 *
 * 出勤日に休む場合の届出。理由をラジオボタンで選択。
 */
'use client'

interface RestReason {
  value: string
  label: string
  vi: string
}

export const REST_REASONS: RestReason[] = [
  { value: 'sick', label: '体調不良', vi: 'Bị ốm' },
  { value: 'hospital', label: '通院', vi: 'Đi khám bệnh' },
  { value: 'personal', label: '私用', vi: 'Việc riêng' },
  { value: 'family', label: '家族の事情', vi: 'Việc gia đình' },
  { value: 'homeCountry', label: '帰国関連', vi: 'Liên quan về nước' },
  { value: 'other', label: 'その他', vi: 'Khác' },
]

interface Props {
  isOpen: boolean
  onClose: () => void
  reason: string
  setReason: (s: string) => void
  note: string
  setNote: (s: string) => void
  saving: boolean
  onSubmit: () => void
}

export default function RestReportModal({
  isOpen,
  onClose,
  reason,
  setReason,
  note,
  setNote,
  saving,
  onSubmit,
}: Props) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center">
          欠勤届 / Đơn xin nghỉ
        </h3>
        <p className="text-xs text-gray-400 text-center mb-4">
          出勤日に休む場合の届出です / Đơn nghỉ khi ngày đi làm
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-600 font-bold block mb-2">
              理由 / Lý do
            </label>
            <div className="space-y-2">
              {REST_REASONS.map(r => (
                <label key={r.value} className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition ${
                  reason === r.value ? 'bg-hibi-navy text-white' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                }`}>
                  <input type="radio" name="restReason" value={r.value}
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                    className="hidden" />
                  <span className="font-medium">{r.label}</span>
                  <span className={`text-sm ${reason === r.value ? 'text-white/70' : 'text-gray-400'}`}>/ {r.vi}</span>
                </label>
              ))}
            </div>
          </div>

          {reason === 'other' && (
            <div>
              <label className="text-sm text-gray-600 font-bold block mb-1">
                補足 / Chi tiết
              </label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)}
                placeholder="理由を入力 / Nhập lý do"
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
            </div>
          )}

          <button onClick={onSubmit}
            disabled={saving}
            className="w-full bg-gray-700 text-white rounded-2xl py-4 text-base font-bold active:bg-gray-800 transition disabled:opacity-50">
            欠勤届を提出 / Gửi đơn xin nghỉ
          </button>

          <button onClick={onClose}
            className="w-full bg-gray-200 text-gray-600 rounded-xl py-3 text-sm">
            戻る / Quay lại
          </button>
        </div>
      </div>
    </div>
  )
}

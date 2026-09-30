/**
 * 欠勤届モーダル（attendance/[token]/page.tsx から抽出）
 *
 * 出勤日に休む場合の届出。理由をラジオボタンで選択。
 *
 * 2026-09-30 追加（代表決定）:
 *   - 先頭に「現場が休み（会社の都合）」を置く。選ぶと 0.6補 として登録（欠勤にならない）。
 *     以前は選択肢が無く、本人が「その他」＋メモ「60%」で出して欠勤扱いになっていた（201・8/26）
 *   - 自分の都合の休みを選ぶと「この日は給料が約○円減ります」と有給の残りを見せ、有給へ誘導する
 *   - 過去の日の「休み」もこの画面を通す（lockDate で日付を固定）
 */
'use client'

interface RestReason {
  value: string
  label: string
  vi: string
}

/** 会社の都合の休み（現場が休み）。REST_REASONS とは別扱い（欠勤ではない） */
export const COMPANY_REST = 'company'

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
  date: string
  setDate: (s: string) => void
  minDate: string
  saving: boolean
  onSubmit: () => void
  /** 自分の都合で1日休むと減る給料の目安（円）。null なら出さない */
  dayPay?: number | null
  /** 有給の残り日数 */
  plRemaining?: number | null
  /** 有給申請を開く（休む日を渡す）。有給は5日前までの申請 */
  onChooseLeave?: (date: string) => void
  /** 有給申請ができる最初の日（YYYY-MM-DD） */
  leaveMinDate?: string
  /** 過去の日から開いたとき: 日付を変えさせない */
  lockDate?: boolean
}

export default function RestReportModal({
  isOpen,
  onClose,
  reason,
  setReason,
  note,
  setNote,
  date,
  setDate,
  minDate,
  saving,
  onSubmit,
  dayPay,
  plRemaining,
  onChooseLeave,
  leaveMinDate,
  lockDate,
}: Props) {
  if (!isOpen) return null
  const isFuture = !!date && !!minDate && date > minDate
  const isCompany = reason === COMPANY_REST
  const canLeave = !!onChooseLeave && (plRemaining ?? 0) > 0 && !!date && !!leaveMinDate && date >= leaveMinDate

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-8 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-hibi-navy mb-1 text-center">
          欠勤届 / Đơn xin nghỉ
        </h3>
        <p className="text-xs text-gray-400 text-center mb-4">
          出勤日に休む場合の届出です / Đơn nghỉ khi ngày đi làm
          <br />先の日付も選べます / Có thể chọn ngày trong tương lai
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-600 font-bold block mb-1">
              休む日 / Ngày nghỉ
            </label>
            <input
              type="date"
              value={date}
              min={minDate}
              disabled={lockDate}
              onChange={e => setDate(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:ring-2 focus:ring-hibi-navy focus:outline-none"
            />
            {isFuture && (
              <p className="text-xs text-blue-600 mt-1 font-bold">
                先の日の欠勤届です / Đơn nghỉ cho ngày trong tương lai
              </p>
            )}
          </div>

          <div>
            <label className="text-sm text-gray-600 font-bold block mb-2">
              理由 / Lý do
            </label>
            <div className="space-y-2">
              <label className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition border-2 ${
                isCompany ? 'bg-hibi-amber text-hibi-charcoal border-hibi-amber' : 'bg-amber-50 text-hibi-charcoal border-amber-200'
              }`}>
                <input type="radio" name="restReason" value={COMPANY_REST}
                  checked={isCompany}
                  onChange={() => setReason(COMPANY_REST)}
                  className="hidden" />
                <span className="text-xl">🚧</span>
                <span>
                  <span className="font-bold block">現場が休み（会社の都合）</span>
                  <span className="text-xs opacity-80">Công trường nghỉ (do công ty)</span>
                </span>
              </label>
              <p className="text-xs text-gray-500 px-1 pb-1">
                ↓ 自分の都合で休むとき / Khi nghỉ vì lý do cá nhân
              </p>
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

          {isCompany ? (
            <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              会社や職長から「休み」と言われた日です。自分の都合の休みより、給料が多く出ます。<br />
              <span className="text-green-700">Ngày công ty hoặc tổ trưởng báo nghỉ. Lương được nhiều hơn nghỉ vì lý do cá nhân.</span>
            </div>
          ) : (
            <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 space-y-2">
              <p className="font-bold">
                {dayPay
                  ? <>この日は給料が約 {dayPay.toLocaleString()}円 減ります<br /><span className="font-normal">Ngày này lương sẽ bị giảm khoảng {dayPay.toLocaleString('vi-VN')} yên</span></>
                  : <>自分の都合の休みは、給料が減ります<br /><span className="font-normal">Nghỉ vì lý do cá nhân thì lương bị giảm</span></>}
              </p>
              {(plRemaining ?? 0) > 0 && (
                <div className="bg-white/70 rounded-lg px-3 py-2 text-gray-700">
                  有給が残り <b>{plRemaining}日</b> あります。有給にすると給料は減りません。<br />
                  <span className="text-gray-500">Bạn còn <b>{plRemaining} ngày</b> nghỉ phép. Nếu dùng nghỉ phép thì lương không bị giảm.</span>
                  {canLeave ? (
                    <button type="button" onClick={() => onChooseLeave!(date)}
                      className="mt-2 w-full bg-green-600 text-white rounded-xl py-3 font-bold active:bg-green-700">
                      🌴 有給を申請する / Xin nghỉ phép
                    </button>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      有給は5日前までに申請してください。次に休む予定があるときは、早めに有給を申請しましょう。<br />
                      Nghỉ phép phải xin trước 5 ngày. Lần sau hãy xin nghỉ phép sớm.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

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
            disabled={saving || !date}
            className={`w-full rounded-2xl py-4 text-base font-bold transition disabled:opacity-50 ${
              isCompany ? 'bg-hibi-amber text-hibi-charcoal active:opacity-80' : 'bg-gray-700 text-white active:bg-gray-800'
            }`}>
            {isCompany ? '会社の都合の休みを登録 / Đăng ký nghỉ do công ty' : '欠勤届を提出 / Gửi đơn xin nghỉ'}
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

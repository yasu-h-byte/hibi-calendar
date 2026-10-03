/**
 * 有給申請モーダル（attendance/[token]/page.tsx から抽出）
 *
 * スタッフが自分のスマホから有給を申請するモーダル。
 * 日本語＋ベトナム語の二言語表記。日付範囲指定 + 任意理由。
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */
'use client'
import { leaveRequestEarliestDate } from '@/lib/leave-rules'
import { todayJstIso } from '@/lib/date-utils'
import { STAFF_TEXT, biLine } from '@/lib/labels'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

export interface LeaveRequestData {
  id: string
  date: string
  status: 'pending' | 'foreman_approved' | 'approved' | 'rejected' | 'cancelled' | 'revoked'
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
  /** 送信。全部送れたら true・送れなかったら false（失敗の文は errorMsg で呼び出し側が出す）・日付の不備で止めたら null */
  onSubmit: () => Promise<boolean | null>
  onCancelRequest: (requestId: string) => void
  // 2026-06-XX 追加: 残数表示 + 残0時のボタン disable (監査 finding #26 対応)
  /** 有給残日数（pending申請差し引き済み） */
  plRemaining?: number | null
}

// 最短申請日 = 明日（2026-09-30 代表決定: 有給は前日までに申請。旧: 今日 + 5日）
//   端末の時差（ベトナム時間など）に左右されないよう日本時間の今日から求める（2026-09-30 点検）
function getMinDate(): string {
  return leaveRequestEarliestDate(todayJstIso())
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
  plRemaining,
}: Props) {
  // 2026-06-XX 追加: 申請日数を計算（日曜以外）
  const requestedDays = (() => {
    // 終了日が空なら開始日1日分として数える（旧: 0扱いで超過チェックが素通りしていた）
    if (!dateFrom) return 0
    if (!dateTo) return 1
    const from = new Date(dateFrom + 'T00:00:00')
    const to = new Date(dateTo + 'T00:00:00')
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return 0
    let count = 0
    const c = new Date(from)
    while (c <= to) { if (c.getDay() !== 0) count++; c.setDate(c.getDate() + 1) }
    return count
  })()
  // 残数 0 or 申請日数 > 残数 のとき申請ブロック
  const isNoBalance = plRemaining !== null && plRemaining !== undefined && plRemaining <= 0
  const isOverBalance = plRemaining !== null && plRemaining !== undefined && requestedDays > plRemaining
  const submitBlocked = isNoBalance || isOverBalance

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="有給申請 / Xin nghỉ phép"
      bilingual
      dirty={!!dateFrom || !!dateTo || reason.trim() !== ''}
      footer={
        <>
          <CancelButton onClick={onClose} disabled={submitting} size="lg">やめる / Hủy</CancelButton>
          {/* 2026-06-XX 修正: 残数不足/超過時はボタン disable */}
          <SaveButton
            action="申請"
            label={isNoBalance ? '残りなし / Không còn ngày phép' : isOverBalance ? '日数超過 / Vượt quá ngày phép' : '有給を申請する / Gửi đơn nghỉ phép'}
            savingLabel="送信しています / Đang gửi"
            savedLabel="申請しました / Đã gửi đơn"
            retryLabel="もう一度申請する / Gửi lại"
            disabled={submitting || !dateFrom || submitBlocked}
            size="lg"
            className="flex-1"
            onSave={async () => { const r = await onSubmit(); if (r !== true) return r }}
          />
        </>
      }
    >
      <div>
        {/* 2026-06-XX 追加: 残数表示（モーダル内でも常時確認できるように） */}
        {plRemaining !== null && plRemaining !== undefined && (
          <div className={`rounded-xl p-3 text-center mb-3 ${
            isNoBalance
              ? 'bg-red-100 text-red-700 border-2 border-red-300'
              : plRemaining <= 3
                ? 'bg-yellow-50 text-yellow-800 border border-yellow-300'
                : 'bg-green-50 text-green-700 border border-green-200'
          }`}>
            <div className="text-xs">有給残り / Nghỉ phép còn</div>
            <div className="text-2xl font-bold">
              {plRemaining}<span className="text-sm font-normal ml-1">日</span>
            </div>
            {isNoBalance && (
              <div className="text-xs font-bold mt-1">
                残りがないため申請できません<br/>Không còn ngày phép, không thể xin nghỉ
              </div>
            )}
          </div>
        )}

        {successMsg && (
          <div className="bg-green-100 text-green-700 rounded-xl p-3 text-center font-bold mb-3 animate-pulse">
            しんせい しました / Đã gửi đơn
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
              {requestedDays}日分の申請になります / Sẽ gửi {requestedDays} ngày
            </p>
          )}
          {/* 2026-06-XX 追加: 申請日数が残数を超える場合の警告 */}
          {isOverBalance && (
            <p className="text-xs text-red-600 mt-2 font-bold">
              ⚠ 残り{plRemaining}日を超えているため申請できません<br/>
              Vượt quá {plRemaining} ngày còn lại, không thể xin nghỉ
            </p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            ※ 前日までに申請してください（明日から選べます）/ Xin trước 1 ngày (chọn được từ ngày mai)
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
            placeholder={biLine(STAFF_TEXT.leaveReasonExample)}
            className="w-full border border-gray-300 rounded-lg px-3 py-3 text-base"
          />
        </div>

        {/* Request history */}
        {requests.length > 0 && (
          <div className="mt-6">
            <div className="text-sm text-gray-500 font-bold mb-2">
              申請の状況 / Trạng thái đơn
            </div>
            <div className="space-y-2">
              {requests.map(req => (
                <div key={req.id} className={`py-2 px-3 rounded-lg ${req.status === 'cancelled' || req.status === 'revoked' ? 'bg-gray-100 opacity-60' : 'bg-gray-50'}`}>
                <div className="flex items-center justify-between min-h-[44px]">
                  <span className="text-sm text-gray-700 font-medium">
                    {formatLeaveDate(req.date)}
                  </span>
                  <div className="flex items-center gap-2">
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
                        {/* 44px 以上（2026-10-02 総合点検。旧: 24px） */}
                        <button
                          onClick={() => onCancelRequest(req.id)}
                          className="text-sm min-h-[44px] px-3 rounded-xl bg-red-50 border-2 border-red-200 text-red-600 font-bold active:bg-red-100"
                        >
                          取り消し / Hủy
                        </button>
                      </>
                    )}
                    {req.status === 'rejected' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold">
                        {biLine(STAFF_TEXT.rejected)}
                      </span>
                    )}
                    {req.status === 'cancelled' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-200 text-gray-500 font-medium">
                        取り消し済 / Đã hủy
                      </span>
                    )}
                    {req.status === 'revoked' && (
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-200 text-gray-500 font-medium">
                        {biLine(STAFF_TEXT.revoked)}
                      </span>
                    )}
                  </div>
                </div>
                {/* 却下の理由は本文に出す（2026-10-02 総合点検。旧: title 属性だけで、スマホでは見えなかった） */}
                {req.status === 'rejected' && (
                  <div className="text-sm text-red-800 mt-0.5">
                    {biLine(STAFF_TEXT.rejectedReason)}: {req.rejectedReason || '—'}
                  </div>
                )}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </Modal>
  )
}

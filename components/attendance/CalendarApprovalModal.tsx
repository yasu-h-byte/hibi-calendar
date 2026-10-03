/**
 * 翌月カレンダー承認モーダル（attendance/[token]/page.tsx から抽出）
 *
 * 本人のトークンで認証された外国人スタッフが、翌月の全現場カレンダーを
 * 確認してサインするモーダル。日本語＋ベトナム語の二言語表記。
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */
'use client'

import { useState } from 'react'
import { STAFF_DOW_VI, STAFF_TEXT, biLine } from '@/lib/labels'
import { notify } from '@/lib/notify'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

export interface PendingCalendarSite {
  siteId: string
  siteName: string
  status: 'approved' | 'draft' | 'submitted' | null
  days: Record<string, string> | null
  signed: boolean
  signedAt: string | null
  /** 署名後にカレンダーが修正された場合 true（再署名要） */
  needsResign?: boolean
  /** カレンダー最終更新日時 */
  updatedAt?: string | null
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
  /** 同意セレモニーで本人が入力した氏名を渡す。サインできたら true（失敗の文は errorMsg で呼び出し側が出す） */
  onSubmit: (consentName: string) => Promise<boolean>
  /** 質問・異議の送信（成功なら true）。承認とは独立 */
  onQuestion: (message: string) => Promise<boolean>
  onClose: () => void
  errorMsg: string | null
}

export default function CalendarApprovalModal({
  pendingCalendar,
  reviewed,
  onReviewedChange,
  signing,
  onSubmit,
  onQuestion,
  onClose,
  errorMsg,
}: Props) {
  const [y, m] = pendingCalendar.ym.split('-')
  const yearNum = parseInt(y)
  const monthNum = parseInt(m)
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate()
  const firstDow = new Date(yearNum, monthNum - 1, 1).getDay()  // 0=日

  // 同意セレモニー: 本人が氏名を入力して同意を明示する（なりすまし対策・本人同意の証跡）
  const [consentName, setConsentName] = useState('')
  const consentOk = consentName.trim().length >= 2

  // 質問・異議（承認とは独立して送信できる）
  const [showQuestion, setShowQuestion] = useState(false)
  const [questionText, setQuestionText] = useState('')
  const [questionSent, setQuestionSent] = useState(false)

  // 表示対象: 承認済みの現場
  const targetSites = pendingCalendar.sites.filter(s => s.status === 'approved')
  // 「サインが必要な現場」= 未署名 OR 署名後に修正された（needsResign）
  const sitesNeedingAction = targetSites.filter(s => !s.signed || s.needsResign)
  // ヘッダー文言を変えるための判定: 全てが needsResign なら「更新」モード、混在なら混合
  const hasRevisions = sitesNeedingAction.some(s => s.needsResign)
  const hasFirstTimeSign = sitesNeedingAction.some(s => !s.signed)
  // 送信している間は閉じない
  const close = () => { if (!signing) onClose() }

  return (
    <Modal
      open
      onClose={close}
      closeOnEsc={!signing}
      closeOnOverlay={!signing}
      size="lg"
      bilingual
      autoFocus="none"
      dirty={consentName.trim() !== '' || reviewed || questionText.trim() !== ''}
      title={`${yearNum}年${monthNum}月 ${sitesNeedingAction.length === 0 ? 'カレンダー' : 'カレンダー承認'}`}
      sub={sitesNeedingAction.length === 0 ? `Lịch tháng ${monthNum}/${yearNum}` : `Xác nhận lịch tháng ${monthNum}/${yearNum}`}
      footer={
        <>
          <CancelButton onClick={close} disabled={signing} size="lg">
            {sitesNeedingAction.length === 0 ? biLine(STAFF_TEXT.close) : 'やめる / Hủy'}
          </CancelButton>
          {sitesNeedingAction.length > 0 && (
            <SaveButton
              action="送信"
              label={hasRevisions && !hasFirstTimeSign
                ? `${sitesNeedingAction.length}件の変更を承認する / Xác nhận ${sitesNeedingAction.length} thay đổi`
                : `${sitesNeedingAction.length}件のカレンダーを承認する / Ký ${sitesNeedingAction.length} lịch`}
              savingLabel="送信しています / Đang gửi"
              savedLabel="送信しました / Đã gửi"
              retryLabel="もう一度送る / Gửi lại"
              disabled={!reviewed || !consentOk || signing}
              size="lg"
              className="flex-1"
              onSave={async () => { if (!(await onSubmit(consentName.trim()))) return false }}
            />
          )}
        </>
      }
    >
        <div className="space-y-4">
          {sitesNeedingAction.length === 0 ? (
            // 署名ずみ（2026-09-30）: 休みの日をいつでも見られるように、承認後も開ける
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800">
              署名ずみです。現場の休みの日を確認できます（グレー＝休み）。
              <br />
              Đã ký. Bạn có thể xem ngày nghỉ của công trường (màu xám = nghỉ).
            </div>
          ) : hasRevisions ? (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900">
              <div className="font-bold mb-1">カレンダーが更新されました / Lịch đã được cập nhật</div>
              前回サインしたあとに、出勤日や休日が変更されている現場があります。
              内容を確認してから、もう一度サインしてください。
              <br />
              Sau khi bạn đã ký, ngày làm việc hoặc ngày nghỉ ở một số công trường đã được thay đổi.
              Hãy xem nội dung và ký lại.
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
              下のカレンダーを見て、出勤日 / 休日 を確認してください。問題なければ承認してください。
              <br />
              Hãy xem lịch dưới đây để xác nhận ngày làm việc / ngày nghỉ. Nếu không có vấn đề, hãy ký xác nhận.
            </div>
          )}

          {targetSites.map(site => {
            // 出勤日数・休日数の合計（2026-10-02 総合点検。同意する内容を数でも確かめられるように）
            const offCount = Array.from({ length: daysInMonth }, (_, i) => site.days?.[String(i + 1)] || 'work')
              .filter(t => t === 'off' || t === 'holiday').length
            const workCount = daysInMonth - offCount
            return (
            <div key={site.siteId} className={`border rounded-lg overflow-hidden ${
              site.needsResign ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
            }`}>
              <div className={`px-3 py-2 flex items-center justify-between ${
                site.needsResign ? 'bg-amber-50' : site.signed ? 'bg-green-50' : 'bg-gray-50'
              }`}>
                <div className="font-bold text-sm text-hibi-navy">{site.siteName}</div>
                {site.needsResign ? (
                  <span className="text-xs bg-amber-200 text-amber-900 px-2 py-0.5 rounded-full font-bold">
                    更新あり / Đã cập nhật
                  </span>
                ) : site.signed ? (
                  <span className="text-xs bg-green-200 text-green-800 px-2 py-0.5 rounded-full font-bold">
                    ✓ {biLine(STAFF_TEXT.signed)}
                  </span>
                ) : null}
              </div>
              {/* カレンダーグリッド
                  2026-10-02 総合点検: 出勤・休みを色だけで示していた（数字 11px・凡例 10px 日本語のみ）のをやめ、
                  各マスに「出 / Làm」「休 / Nghỉ」の文字を入れ、凡例と合計を日越 12px 以上にする（同意の根拠になる画面） */}
              <div className="p-2">
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {DOW_LABELS.map((d, i) => (
                    <div key={d} className={`py-1 font-bold text-xs leading-tight ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-600'}`}>
                      {d}<span className="block font-normal">{STAFF_DOW_VI[i]}</span>
                    </div>
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
                        className={`py-1 rounded leading-tight ${
                          isOff
                            ? 'bg-gray-200 text-gray-700'
                            : 'bg-blue-100 text-blue-900'
                        }`}
                      >
                        <div className={`text-sm font-bold tabular-nums ${!isOff && dow === 0 ? 'text-red-600' : !isOff && dow === 6 ? 'text-blue-600' : ''}`}>{day}</div>
                        <div className="text-xs">{isOff ? '休' : '出'}</div>
                        <div className="text-xs">{isOff ? 'Nghỉ' : 'Làm'}</div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-gray-700 justify-center">
                  <span><span className="inline-block w-3 h-3 bg-blue-100 border border-blue-200 rounded-sm mr-1 align-middle" />出 = {biLine(STAFF_TEXT.work)}</span>
                  <span><span className="inline-block w-3 h-3 bg-gray-200 rounded-sm mr-1 align-middle" />休 = {biLine(STAFF_TEXT.off)}</span>
                </div>
                <div className="mt-1.5 text-center text-sm font-bold text-hibi-navy tabular-nums">
                  {STAFF_TEXT.work.ja} {workCount}日・{STAFF_TEXT.off.ja} {offCount}日
                  <span className="block text-xs font-normal text-hibi-sub">{STAFF_TEXT.work.vi} {workCount} ngày · {STAFF_TEXT.off.vi} {offCount} ngày</span>
                </div>
              </div>
            </div>
            )
          })}

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-red-700 text-sm text-center">
              {errorMsg}
            </div>
          )}

          {/* 質問・異議の窓口（承認とは独立。確認したが疑問・要望がある場合） */}
          <div className="pt-2 border-t border-gray-200">
            {questionSent ? (
              <div className="text-center text-sm text-green-700">
                送信しました。担当者が確認します / Đã gửi, người phụ trách sẽ kiểm tra
              </div>
            ) : !showQuestion ? (
              /* 異議の入口は 44px 以上（2026-10-02 総合点検。旧: 12px の下線リンク1行） */
              <button
                type="button"
                onClick={() => setShowQuestion(true)}
                className="w-full min-h-[44px] py-2 rounded-lg text-sm text-blue-700 underline active:bg-blue-50"
              >
                質問・相談・変更してほしい点がある方はこちら / Có thắc mắc hoặc đề nghị?
              </button>
            ) : (
              <div className="space-y-2">
                {/* 16px（旧 text-sm だと iOS がフォーカスで画面を拡大する） */}
                <textarea
                  value={questionText}
                  onChange={e => setQuestionText(e.target.value)}
                  rows={3}
                  placeholder="質問・相談・変更してほしい点 / Câu hỏi, đề nghị thay đổi..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base"
                />
                <div className="flex items-center justify-end gap-2">
                  <CancelButton onClick={() => { setShowQuestion(false); setQuestionText('') }}>
                    {biLine(STAFF_TEXT.close)}
                  </CancelButton>
                  <SaveButton
                    action="送信"
                    label="送信 / Gửi"
                    savingLabel="送信しています / Đang gửi"
                    savedLabel="送信しました / Đã gửi"
                    retryLabel="もう一度送る / Gửi lại"
                    disabled={questionText.trim().length < 2}
                    className="flex-1"
                    onSave={async () => {
                      const ok = await onQuestion(questionText.trim())
                      if (ok) { setQuestionSent(true); return }
                      // 文面は日越で出したいので自分で帯を出す（SaveButton の既定の帯は日本語だけ）
                      notify.error('送信できませんでした / Gửi thất bại', '電波のよい所でもう一度お試しください / Vui lòng thử lại ở nơi có sóng tốt')
                      return false
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 確認チェック（承認ボタンは下のボタン列） */}
          {sitesNeedingAction.length === 0 ? (
            <div className="text-center text-sm text-green-700 font-bold">
              すべて署名済みです / Đã ký tất cả
            </div>
          ) : (
            <div className="border-t border-gray-200 pt-3 space-y-3">
              {/* 本人確認: 氏名の入力（同意セレモニー） */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  確認のため、お名前を入力してください<br />
                  <span className="text-gray-500 font-normal">Vui lòng nhập họ tên của bạn để xác nhận</span>
                </label>
                <input
                  type="text"
                  value={consentName}
                  onChange={e => setConsentName(e.target.value)}
                  placeholder={pendingCalendar.workerName}
                  autoComplete="off"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base focus:border-orange-400 focus:ring-1 focus:ring-orange-300"
                />
              </div>
              {/* 同意チェック */}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={e => onReviewedChange(e.target.checked)}
                  className="mt-1 w-5 h-5 rounded"
                />
                <span className="text-sm text-gray-800 leading-tight">
                  上記は私本人です。カレンダーの内容を確認し、同意します
                  <br />
                  <span className="text-xs text-gray-500">
                    Đây chính là tôi. Tôi đã xem và đồng ý với nội dung lịch.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
    </Modal>
  )
}

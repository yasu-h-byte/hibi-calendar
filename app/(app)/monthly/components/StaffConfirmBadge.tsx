'use client'
/**
 * 月次集計の名前の横に出す「本人の出面確認」のバッジ（2026-09-30）
 *
 * - 確認ずみ／承認前に確認／要再確認／本人から連絡あり（未対応）／連絡 対応済み
 * - 連絡のバッジを押すと中身を見られ、事務・事業責任者・代表（monthly.close）は「対応済み」にできる。
 *   返事を書くと本人のスマホの確認カードに出る。出面を直した場合は本人に再確認が出る（要再確認）
 * - 仕組みは docs/attendance.md「本人の出面確認」
 * - 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
 * - 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 */
import { useState } from 'react'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'

/** 本人確認の1人分（app/api/attendance/confirm の事務所向け GET）。状態はサーバが月締めと同じ判定で決める */
export interface StaffConfirmInfo {
  org: 'hibi' | 'hfu'
  state: 'ok' | 'none' | 'early' | 'stale' | 'issue' | 'waiting' | 'outside'
  /** その人の承認で足りない「現場×日」（waiting の説明用） */
  foremanMissing: number
  finalMissing: number
  /** 以下は確認の記録があるときだけ */
  status?: 'ok' | 'issue'
  note?: string
  at?: string
  resolvedAt?: string
  resolvedBy?: string
  reply?: string
}

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '')

export default function StaffConfirmBadge({
  info, workerId, workerName, ym, password, canResolve, onChanged,
}: {
  info: StaffConfirmInfo
  workerId: number
  workerName: string
  ym: string
  password: string
  canResolve: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reply, setReply] = useState('')
  const [saving, setSaving] = useState(false)

  const isIssue = info.status === 'issue'
  const resolved = isIssue && !!info.resolvedAt
  // 状態はサーバが決めたもの（info.state）をそのまま出す。連絡が対応済みの人だけ「確認ずみ」を見分けて出す
  const kind = info.state === 'ok' && resolved ? 'resolved' : info.state
  const cls = {
    none: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
    waiting: 'bg-gray-50 text-gray-500 border border-dashed border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600',
    outside: 'bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
    early: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
    stale: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    resolved: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
    issue: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  }[kind]
  const label = {
    none: 'まだ', waiting: '承認待ち', outside: '期間外',
    early: 'まだ（承認前に確認）', stale: '要再確認', ok: '確認ずみ ✓', resolved: '連絡 対応済み', issue: '⚠ 本人から連絡あり',
  }[kind]
  const missing = [
    info.foremanMissing > 0 ? `職長承認がまだ ${info.foremanMissing}件` : '',
    info.finalMissing > 0 ? `最終承認がまだ ${info.finalMissing}件` : '',
  ].filter(Boolean).join('・')
  const title = {
    none: '職長承認と最終承認がそろい、本人のスマホに確認が出ています。本人がまだ押していません。',
    waiting: `この人の出面の承認がそろっていないため、本人のスマホにはまだ確認が出ていません（${missing || '承認待ち'}・現場×日）。承認がそろうと確認が出ます。`,
    outside: 'スマホで確認できるのは、締める前の前の月だけです。この月は本人のスマホに確認が出ません。',
    early: `承認がそろう前に「正しい」と押した記録です（${fmt(info.at)}）。数えません。本人のスマホにもう一度確認が出ています。`,
    stale: `本人が確認したあとで出面が変わりました（確認: ${fmt(info.at)}）。本人のスマホに「もう一度確認してください」と出ています。`,
    ok: `本人がスマホで「正しい」と確認しました（${fmt(info.at)}）`,
    resolved: `本人の連絡は対応済みです（${info.resolvedBy || ''} ${fmt(info.resolvedAt)}）。押すと中身を見られます。`,
    issue: `本人から「まちがいがある」と連絡がありました（${fmt(info.at)}）。押すと中身を見て対応済みにできます。`,
  }[kind]

  const resolve = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/attendance/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'resolve', ym, workerId, reply }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, error: j.error || 'サーバが受け付けませんでした' }
      setOpen(false); setReply('')
      onChanged()
    } finally {
      setSaving(false)
    }
  }
  const close = () => { if (!saving) setOpen(false) }
  const canReply = !resolved && canResolve

  const badgeCls = `ml-1.5 text-3xs whitespace-nowrap px-1.5 py-0.5 rounded-full font-bold align-middle ${cls}`
  return (
    <>
      {isIssue ? (
        <button type="button" onClick={() => setOpen(true)} className={`${badgeCls} hover:opacity-80`} title={title}>{label}</button>
      ) : (
        <span className={badgeCls} title={title}>{label}</span>
      )}
      <Modal
        open={open}
        onClose={close}
        title={`${workerName} さんからの連絡（${parseInt(ym.slice(4, 6))}月の出面）`}
        dirty={canReply && reply !== ''}
        footer={<>
          <CancelButton onClick={close} disabled={saving}>{canReply ? 'やめる' : '閉じる'}</CancelButton>
          {canReply && <SaveButton action="対応済みに" label="対応済みにする" savingLabel="対応済みにしています" savedLabel="対応済みにしました" retryLabel="もう一度対応済みにする" onSave={resolve} />}
        </>}
      >
          <div className="space-y-3 text-left">
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm whitespace-pre-wrap">{info.note || '（内容なし）'}</div>
            <p className="text-xs text-gray-500">送られた日時: {fmt(info.at)}{info.state === 'waiting' ? '（職長承認・最終承認がそろう前の連絡）' : ''}</p>
            {resolved ? (
              <div className="rounded-lg bg-sky-50 dark:bg-sky-900/20 p-3 text-sm">
                <b>対応済み</b>（{info.resolvedBy} ／ {fmt(info.resolvedAt!)}）
                {info.reply && <p className="mt-1 whitespace-pre-wrap">本人への返事: {info.reply}</p>}
              </div>
            ) : canResolve ? (
              <>
                <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                  出面を直した場合は、本人のスマホに「もう一度確認してください」が出ます。<br />
                  直さない場合（本人の勘違いなど）は、理由を返事に書いてください。本人のスマホの確認カードに出ます。
                </p>
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3} maxLength={500}
                  placeholder="本人への返事（任意）例: 9/25 は出勤に直しました／9/8 は現場が動いていたので自分の都合の休みのままです"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:bg-gray-700" />
              </>
            ) : (
              <p className="text-xs text-gray-500">対応済みにできるのは、事務・事業責任者・代表です。</p>
            )}
          </div>
      </Modal>
    </>
  )
}

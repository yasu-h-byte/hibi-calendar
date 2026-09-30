'use client'
/**
 * 月次集計の名前の横に出す「本人の出面確認」のバッジ（2026-09-30）
 *
 * - 確認ずみ／承認前に確認／要再確認／本人から連絡あり（未対応）／連絡 対応済み
 * - 連絡のバッジを押すと中身を見られ、事務・事業責任者・代表（monthly.close）は「対応済み」にできる。
 *   返事を書くと本人のスマホの確認カードに出る。出面を直した場合は本人に再確認が出る（要再確認）
 * - 仕組みは docs/attendance.md「本人の出面確認」
 */
import { useState } from 'react'

export interface StaffConfirmInfo {
  status: 'ok' | 'issue'
  note?: string
  at: string
  stale?: boolean
  early?: boolean
  resolvedAt?: string
  resolvedBy?: string
  reply?: string
}

const fmt = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })

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
  const kind = info.stale ? 'stale'
    : isIssue ? (resolved ? 'resolved' : 'issue')
    : info.early ? 'early' : 'ok'
  const cls = {
    early: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    stale: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    resolved: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
    issue: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  }[kind]
  const label = {
    early: '本人 承認前に確認', stale: '本人 要再確認', ok: '本人確認 ✓', resolved: '連絡 対応済み', issue: '⚠ 本人から連絡あり',
  }[kind]
  const title = {
    early: `承認がそろう前に「正しい」と押した記録です（${fmt(info.at)}）。職長承認と最終承認がそろうと、本人のスマホにもう一度確認が出ます。`,
    stale: `本人が確認したあとで出面が変わりました（確認: ${fmt(info.at)}）。本人のスマホに「もう一度確認してください」と出ています。`,
    ok: `本人がスマホで「正しい」と確認しました（${fmt(info.at)}）`,
    resolved: `本人の連絡は対応済みです（${info.resolvedBy || ''} ${info.resolvedAt ? fmt(info.resolvedAt) : ''}）。押すと中身を見られます。`,
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
      if (!res.ok) { alert(`対応済みにできませんでした: ${j.error || res.status}`); return }
      setOpen(false); setReply('')
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  const badgeCls = `ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-bold align-middle ${cls}`
  return (
    <>
      {isIssue ? (
        <button type="button" onClick={() => setOpen(true)} className={`${badgeCls} hover:opacity-80`} title={title}>{label}</button>
      ) : (
        <span className={badgeCls} title={title}>{label}</span>
      )}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3 text-left" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h3 className="font-bold">{workerName} さんからの連絡（{parseInt(ym.slice(4, 6))}月の出面）</h3>
              <button onClick={() => setOpen(false)} className="text-2xl leading-none text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm whitespace-pre-wrap">{info.note || '（内容なし）'}</div>
            <p className="text-xs text-gray-500">送られた日時: {fmt(info.at)}{info.early ? '（職長承認・最終承認がそろう前の連絡）' : ''}</p>
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
                <div className="flex justify-end gap-2">
                  <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm">閉じる</button>
                  <button onClick={resolve} disabled={saving} className="px-4 py-2 rounded-lg bg-hibi-navy text-white text-sm font-bold disabled:opacity-50">
                    {saving ? '保存中…' : '対応済みにする'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-500">対応済みにできるのは、事務・事業責任者・代表です。</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

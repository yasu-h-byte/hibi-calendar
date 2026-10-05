'use client'

import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Modal, CancelButton, PrimaryButton } from '@/components/ui/Modal'
import { notify } from '@/lib/notify'
import { todayJstIso } from '@/lib/date-utils'
import { buildConfirmReminderText, isReminderUrgent, reminderTargets, type ReminderPerson } from '@/lib/confirm-reminder'

/**
 * 出面の本人確認をお願いする文面を作る（2026-10-05 代表依頼）。
 * まだの人の名前入りの文（日越並記）を出し、コピーしてスタッフのグループ（LINE など）へ貼る。
 * 日比建設と HFU は分けない（同じグループへ一斉に送るため）。文面の決まりは lib/confirm-reminder.ts
 */
export default function ConfirmReminder({ ym, people }: { ym: string; people: ReminderPerson[] }) {
  const [open, setOpen] = useState(false)
  const [urgent, setUrgent] = useState(false)
  const [text, setText] = useState('')
  const targets = useMemo(() => reminderTargets(people), [people])
  const waiting = people.filter(p => p.state === 'waiting').length
  const issue = people.filter(p => p.state === 'issue').length
  const month = Number(ym.slice(4, 6))

  // 開いたとき・急ぎを切り替えたときに文面を作り直す（手で直した分は切り替えで消える）
  useEffect(() => {
    if (open) setText(buildConfirmReminderText({ ym, people, urgent }))
  }, [open, urgent, ym, people])

  if (targets.length === 0) return null

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success('文面をコピーしました。スタッフのグループに貼り付けて送ってください')
    } catch (e) {
      notify.failed('コピー', e)
    }
  }
  const share = async () => {
    try {
      await navigator.share({ text })
    } catch {
      // 共有の窓を閉じただけのときもここに来る（お知らせは出さない）
    }
  }

  return (
    <>
      <div className="rounded-xl border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-bold text-gray-900 dark:text-white">
            {month}月分の本人確認がまだの人: {targets.length}名（日比建設・HFU の合計）
          </div>
          <div className="text-xs text-hibi-sub dark:text-gray-400 truncate">
            {targets.map(p => p.name).join('・')}
          </div>
        </div>
        <button type="button" onClick={() => { setUrgent(isReminderUrgent(ym, todayJstIso())); setOpen(true) }}
          className="h-10 px-4 rounded-[10px] text-sm font-bold bg-hibi-navy hover:bg-hibi-light text-white inline-flex items-center gap-1.5 shrink-0">
          <Icon name="bell" size={15} />お願いの文面を作る
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} size="lg" autoFocus="none"
        title={`${month}月分の出面の確認をお願いする文面`}
        sub={`まだの ${targets.length}名の名前入り。コピーして、スタッフのグループに貼り付けて送ります`}
        footer={<>
          <CancelButton onClick={() => setOpen(false)}>閉じる</CancelButton>
          {canShare && <CancelButton onClick={share}>アプリを選んで送る</CancelButton>}
          <PrimaryButton onClick={copy}><span className="inline-flex items-center gap-1.5"><Icon name="copy" size={15} />文面をコピーする</span></PrimaryButton>
        </>}>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
            <input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} className="w-4 h-4" />
            急ぎの文にする（「至急」「今日中に」。翌月5日を過ぎると初めからこちら）
          </label>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={16}
            aria-label="送る文面（直せます）"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-[10px] px-3 py-2 text-sm leading-relaxed bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" />
          <ul className="text-xs text-hibi-sub dark:text-gray-400 space-y-0.5 list-disc pl-4">
            <li>文面はここで直してからコピーできます（急ぎの切り替えをすると作り直します）</li>
            {waiting > 0 && <li>承認待ちの {waiting}名は入れていません（職長・最終承認がそろうまで、本人のスマホに確認が出ないため）</li>}
            {issue > 0 && <li>本人から連絡ありの {issue}名は入れていません（事務所が対応する番です）</li>}
          </ul>
        </div>
      </Modal>
    </>
  )
}

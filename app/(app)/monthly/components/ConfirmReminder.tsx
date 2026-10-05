'use client'

import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Modal, CancelButton, PrimaryButton } from '@/components/ui/Modal'
import { notify } from '@/lib/notify'
import { todayJstIso } from '@/lib/date-utils'
import {
  buildConfirmReminderText, reminderDueDate, reminderTargets, reminderWaiting, REMINDER_WAIT_DAYS, type ReminderPerson,
} from '@/lib/confirm-reminder'

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

/**
 * 出面の本人確認の催促（2026-10-05 代表依頼・同日ルール統一）。
 * その人のスマホに確認が出てから3日たっても押していない人がいると、警告の帯と「お願いの文面を作る」を出す。
 * 3日たつまでは灰色で「確認待ち（催促は◯日から）」とだけ出す。日比建設と HFU は分けない（同じグループへ一斉に送るため）。
 * 決まりは lib/confirm-reminder.ts
 */
export default function ConfirmReminder({ ym, people }: { ym: string; people: ReminderPerson[] }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const todayIso = todayJstIso()
  const targets = useMemo(() => reminderTargets(people, todayIso), [people, todayIso])
  const waitingList = useMemo(() => reminderWaiting(people, todayIso), [people, todayIso])
  const approvalWaiting = people.filter(p => p.state === 'waiting').length
  const issue = people.filter(p => p.state === 'issue').length
  const month = Number(ym.slice(4, 6))

  // 開いたときに文面を作る（開いている間に手で直した分は残す）
  useEffect(() => {
    if (open) setText(buildConfirmReminderText({ ym, people, todayIso }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いた時点の一覧で作る（開いている間の再取得で、手で直した文面を消さない）
  }, [open])

  if (targets.length === 0 && waitingList.length === 0) return null

  // 3日たっていない人: いつから催促になるか（いちばん早い日）
  const nextDue = waitingList.map(reminderDueDate).sort()[0]
  const waitingNote = waitingList.length > 0
    ? `確認が出て${REMINDER_WAIT_DAYS}日以内の人: ${waitingList.length}名（${waitingList.map(p => p.name).join('・')}。催促は ${md(nextDue)} から）`
    : ''

  if (targets.length === 0) {
    return (
      <div className="rounded-xl border border-hibi-line dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
        <div className="text-sm font-bold text-gray-700 dark:text-gray-200">{month}月分の本人確認を待っています: {waitingList.length}名</div>
        <div className="text-xs text-hibi-sub dark:text-gray-400">
          {waitingList.map(p => p.name).join('・')}。スマホに確認が出てから{REMINDER_WAIT_DAYS}日は本人が押すのを待ちます（催促の文面は {md(nextDue)} から作れます）
        </div>
      </div>
    )
  }

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
      <div role="alert" className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex items-start gap-2">
          <Icon name="alert" size={18} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-gray-900 dark:text-white">
              {month}月分の本人確認: 確認が出て{REMINDER_WAIT_DAYS}日たっても押していない人が {targets.length}名（日比建設・HFU の合計）
            </div>
            <div className="text-xs text-gray-700 dark:text-gray-300">{targets.map(p => p.name).join('・')}</div>
            {waitingNote && <div className="text-xs text-hibi-sub dark:text-gray-400">{waitingNote}</div>}
          </div>
        </div>
        <button type="button" onClick={() => setOpen(true)}
          className="h-10 px-4 rounded-[10px] text-sm font-bold bg-hibi-navy hover:bg-hibi-light text-white inline-flex items-center gap-1.5 shrink-0">
          <Icon name="bell" size={15} />お願いの文面を作る
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} size="lg" autoFocus="none"
        title={`${month}月分の出面の確認をお願いする文面`}
        sub={`確認が出て${REMINDER_WAIT_DAYS}日たっても押していない ${targets.length}名の名前入り。コピーして、スタッフのグループに貼り付けて送ります`}
        footer={<>
          <CancelButton onClick={() => setOpen(false)}>閉じる</CancelButton>
          {canShare && <CancelButton onClick={share}>アプリを選んで送る</CancelButton>}
          <PrimaryButton onClick={copy}><span className="inline-flex items-center gap-1.5"><Icon name="copy" size={15} />文面をコピーする</span></PrimaryButton>
        </>}>
        <div className="space-y-3">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={16}
            aria-label="送る文面（直せます）"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-[10px] px-3 py-2 text-sm leading-relaxed bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" />
          <ul className="text-xs text-hibi-sub dark:text-gray-400 space-y-0.5 list-disc pl-4">
            <li>文面はここで直してからコピーできます</li>
            {waitingList.length > 0 && <li>確認が出て{REMINDER_WAIT_DAYS}日以内の {waitingList.length}名は入れていません（{md(nextDue)} から入ります）</li>}
            {approvalWaiting > 0 && <li>承認待ちの {approvalWaiting}名は入れていません（職長・最終承認がそろうまで、本人のスマホに確認が出ないため）</li>}
            {issue > 0 && <li>本人から連絡ありの {issue}名は入れていません（事務所が対応する番です）</li>}
          </ul>
        </div>
      </Modal>
    </>
  )
}

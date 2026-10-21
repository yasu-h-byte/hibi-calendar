'use client'

/**
 * 就業カレンダーの「提出: 誰が・いつ ／ 最終承認: 誰が・いつ」と「履歴を見る」（2026-10-22）
 *
 * PC の就業カレンダー画面（月×現場の見出し）と職長スマホの「就業カレ」タブが同じものを使う。
 * 文の作り方は lib/calendar-approval-trail.ts（純粋・テストあり）。名前は人員マスタの名前だけ。
 */
import { useEffect, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { Modal, CancelButton } from '@/components/ui/Modal'
import {
  buildApprovalTrailLines, trailEntryText, trailEventTone, TRAIL_EVENT_LABEL,
  type CalendarTrailFields, type CalendarTrailEntry, type TrailTone,
} from '@/lib/calendar-approval-trail'

const TONE_TEXT: Record<TrailTone, string> = {
  green: 'text-green-700 dark:text-green-300',
  blue: 'text-hibi-navy dark:text-blue-300',
  red: 'text-red-700 dark:text-red-300',
  amber: 'text-amber-800 dark:text-amber-300',
  gray: 'text-gray-500 dark:text-gray-400',
}
const TONE_DOT: Record<TrailTone, string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  gray: 'bg-gray-400',
}

/** 「提出: 大川 10/21 18:05 ／ 最終承認: 政仁 10/22 09:10」の1行 */
export function ApprovalTrail({ cal, onHistory, className }: {
  cal: CalendarTrailFields | null | undefined
  /** 「履歴を見る」を押したとき（無ければボタンを出さない） */
  onHistory?: () => void
  className?: string
}) {
  const lines = buildApprovalTrailLines(cal)
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5 ${className || ''}`}>
      {lines.map((l, i) => (
        <span key={l.label} className="whitespace-nowrap">
          {i > 0 && <span className="text-gray-300 dark:text-gray-600 mr-2">／</span>}
          <span className="text-gray-500 dark:text-gray-400">{l.label}: </span>
          <span className={`font-bold ${TONE_TEXT[l.tone]}`}>{l.text}</span>
        </span>
      ))}
      {onHistory && (
        <button type="button" onClick={onHistory}
          className="ml-1 text-xs underline underline-offset-2 text-hibi-sub dark:text-gray-400 hover:text-hibi-navy dark:hover:text-white">
          履歴を見る
        </button>
      )}
    </div>
  )
}

interface HistoryResp { entries: CalendarTrailEntry[] }

/** 月×現場の提出・承認・差し戻し・取り消しの時系列（/api/calendar/history） */
export function CalendarHistoryModal({ open, onClose, siteId, siteName, ym, password }: {
  open: boolean
  onClose: () => void
  siteId: string
  siteName: string
  /** 'YYYY-MM' */
  ym: string
  password: string
}) {
  const [entries, setEntries] = useState<CalendarTrailEntry[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !password) return
    let alive = true
    setEntries(null)
    setError('')
    fetchWithAuth(`/api/calendar/history?siteId=${encodeURIComponent(siteId)}&ym=${ym}`, { password })
      .then(async res => {
        if (!alive) return
        if (!res.ok) { setError('履歴を取得できませんでした'); setEntries([]); return }
        const d = (await res.json()) as HistoryResp
        setEntries(d.entries || [])
      })
      .catch(() => { if (alive) { setError('通信エラーが発生しました'); setEntries([]) } })
    return () => { alive = false }
  }, [open, password, siteId, ym])

  const [y, m] = ym.split('-')
  const hasDocOnly = !!entries?.length && entries.every(e => e.source === 'doc')
  return (
    <Modal open={open} onClose={onClose} size="md" autoFocus="none"
      title={`${siteName} ${Number(y)}年${Number(m)}月 の提出・承認の履歴`}
      sub="職長の提出 → 政仁さんの最終承認。差し戻し・取り消し・承認後の修正も、起きた順に並びます"
      footer={<CancelButton onClick={onClose}>閉じる</CancelButton>}>
      {entries === null && <div className="py-6 text-center text-sm text-gray-400">読み込み中…</div>}
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {entries !== null && !error && entries.length === 0 && (
        <div className="py-6 text-center text-sm text-gray-400">記録がありません（この月はまだ提出・承認されていないか、記録を残す前の月です）</div>
      )}
      {!!entries?.length && (
        <ol className="space-y-2">
          {entries.map((e, i) => {
            const tone = trailEventTone(e.event)
            return (
              <li key={`${e.at}_${e.event}_${i}`} className="flex items-start gap-2.5 text-sm">
                <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} aria-hidden />
                <div className="min-w-0">
                  <div className={`font-bold ${TONE_TEXT[tone]}`}>{TRAIL_EVENT_LABEL[e.event]}</div>
                  <div className="text-gray-700 dark:text-gray-200 break-words">{trailEntryText(e).replace(`${TRAIL_EVENT_LABEL[e.event]} `, '')}</div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {hasDocOnly && (
        <p className="mt-4 text-2xs text-gray-500 dark:text-gray-400">
          この月は台帳を付け始める前のもので、今のカレンダーに残っている記録だけを出しています（取り消した承認・提出は残っていません）。
        </p>
      )}
    </Modal>
  )
}

'use client'
/**
 * 使い方を聞く（2026-11-10）。「困ったこと・要望」のいちばん上に置く欄。決まりは lib/help.ts、通信は /api/help。
 * 質問を書くと AI がマニュアルを読んで答える。解決しなければ「代表に送る」で、質問と答えを付けたまま要望にする。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { notify } from '@/lib/notify'
import { Chip, FieldError } from '@/components/ui/PageParts'
import { SaveButton } from '@/components/ui/SaveButton'
import { HELP_LIMITS, helpQuestionError, helpEscalationText, type HelpAnswer, type HelpSource, type HelpTurn } from '@/lib/help'

interface Turn extends HelpTurn { answered: boolean; sources: HelpSource[] }
interface LogRow { id: string; at: string; name: string; question: string; answered: boolean; answer: string }

const fmtAt = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function HelpAsk({ password, manage, onEscalate }: {
  password: string
  /** 代表（質問の記録を見られる） */
  manage: boolean
  /** 「代表に送る」: 要望を書く窓を、この文を入れた状態で開く */
  onEscalate: (text: string) => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [configured, setConfigured] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!password) return
    let alive = true
    fetchWithAuth('/api/help', { password })
      .then(async r => {
        if (!r.ok || !alive) return
        const j = await r.json()
        setRemaining(typeof j.remaining === 'number' ? j.remaining : null)
        setConfigured(j.configured !== false)
      })
      .catch(() => null)
    return () => { alive = false }
  }, [password])

  useEffect(() => { if (turns.length) endRef.current?.scrollIntoView({ block: 'nearest' }) }, [turns.length])

  const err = helpQuestionError(text)
  const ask = async () => {
    setTried(true)
    if (err) return null
    const question = text.trim()
    const r = await fetchWithAuth('/api/help', { password,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: turns.slice(-HELP_LIMITS.historyPairs).map(t => ({ q: t.q, a: t.a })) }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: j?.error || 'サーバが受け付けませんでした' }
    const a = j as HelpAnswer
    setTurns(prev => [...prev, { q: question, a: a.answer, answered: a.answered, sources: a.sources || [] }])
    setRemaining(a.remaining)
    setText('')
    setTried(false)
  }

  const last = turns[turns.length - 1]
  const outOfQuota = remaining === 0

  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-2">
        <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">使い方を聞く</h2>
        <Chip tone="blue">AI がその場で答えます</Chip>
        <span className="text-xs text-hibi-sub dark:text-gray-400">
          マニュアルをもとに答えます。出面や給与などの実際のデータは見ません
        </span>
      </div>

      {turns.length > 0 && (
        <div className="px-5 py-4 space-y-3">
          {turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl px-3.5 py-2.5 bg-hibi-active text-gray-900 dark:bg-blue-900/40 dark:text-gray-100 text-sm whitespace-pre-wrap break-words">{t.q}</div>
              </div>
              <div className="flex justify-start">
                <div className={`max-w-[92%] rounded-xl px-3.5 py-2.5 border ${t.answered
                  ? 'bg-green-50 border-green-200 text-gray-900 dark:bg-green-900/30 dark:border-green-800 dark:text-gray-100'
                  : 'bg-amber-50 border-amber-200 text-gray-900 dark:bg-amber-900/30 dark:border-amber-800 dark:text-gray-100'}`}>
                  <div className="text-2xs font-bold text-hibi-sub dark:text-gray-400 mb-0.5">
                    AI の答え{!t.answered && '（資料からは答えられませんでした）'}
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{t.a}</div>
                  {t.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="font-bold text-hibi-sub dark:text-gray-400">もとにした資料</span>
                      {t.sources.map(s => (
                        <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer"
                          className="text-hibi-navy dark:text-blue-300 underline">{s.title}</a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {last && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-hibi-sub dark:text-gray-400">解決しないときは</span>
              <button type="button" onClick={() => onEscalate(helpEscalationText(turns))}
                className="h-9 px-3 rounded-lg border border-gray-400 dark:border-gray-500 text-xs font-bold text-gray-700 dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                これでは分からない → 代表に送る
              </button>
              <button type="button" onClick={() => { setTurns([]); setText(''); setTried(false) }}
                className="h-9 px-3 rounded-lg text-xs font-bold text-hibi-sub dark:text-gray-400 hover:bg-hibi-bg dark:hover:bg-gray-700">
                別の質問をはじめる
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className={`px-5 py-4 space-y-2 ${turns.length > 0 ? 'border-t border-hibi-line dark:border-gray-700' : ''}`}>
        {!configured ? (
          <div className="text-sm text-hibi-sub dark:text-gray-400">AI の設定がまだ済んでいません。右上の「新しく書く」から書いてください</div>
        ) : (
          <>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={turns.length > 0 ? 2 : 3} maxLength={HELP_LIMITS.question}
              aria-label="使い方の質問"
              placeholder={turns.length > 0 ? '続けて聞く（例: そのボタンが出ないときは？）' : '例: 山岡への請求書で「確認1」はどこから押しますか？／有給の申請を取り消すには？'}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
            {tried && err && <FieldError>{err}</FieldError>}
            <div className="flex items-center gap-3 flex-wrap">
              <SaveButton action="質問" label="聞く" savingLabel="資料を読んでいます…" savedLabel="答えました" retryLabel="もう一度聞く"
                disabled={outOfQuota} onSave={ask} />
              <span className="text-xs text-hibi-sub dark:text-gray-400">
                {outOfQuota
                  ? `今日はもう${HELP_LIMITS.perDay}回聞きました。続きは「新しく書く」から書いてください`
                  : <>答えが出るまで10〜30秒ほどかかります{remaining !== null && remaining <= 5 && `・今日はあと${remaining}回`}</>}
              </span>
            </div>
          </>
        )}
      </div>

      {manage && <HelpLog password={password} />}
    </section>
  )
}

/** 代表だけ: みんなが何を聞いたかの記録（マニュアルの足りない所を見つける材料） */
function HelpLog({ password }: { password: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<LogRow[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetchWithAuth('/api/help?log=1', { password })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('質問の記録の読み込み', j?.error || 'サーバが受け付けませんでした'); return }
      setRows(j.log || [])
    } catch (e) { notify.failed('質問の記録の読み込み', e) }
  }, [password])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) load()
  }

  return (
    <div className="border-t border-hibi-line dark:border-gray-700">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="w-full px-5 py-2.5 text-left text-xs font-bold text-hibi-sub dark:text-gray-400 hover:bg-hibi-bg dark:hover:bg-gray-700/40">
        {open ? '▼' : '▶'} 質問の記録（代表だけに見えます・新しい順に50件）
      </button>
      {open && (rows === null ? (
        <div className="px-5 py-4 text-sm text-hibi-sub">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-4 text-sm text-hibi-sub dark:text-gray-400">まだ質問はありません</div>
      ) : rows.map(r => (
        <div key={r.id} className="border-t border-hibi-line dark:border-gray-700">
          <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} aria-expanded={openId === r.id}
            className="w-full px-5 py-2.5 flex items-start gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40">
            <Chip tone={r.answered ? 'green' : 'amber'}>{r.answered ? '答えた' : '答えられず'}</Chip>
            <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-200 truncate">{r.question}</span>
            <span className="shrink-0 text-xs text-hibi-sub dark:text-gray-400 tabular-nums">{r.name}・{fmtAt(r.at)}</span>
          </button>
          {openId === r.id && (
            <div className="px-5 pb-3 space-y-2 text-sm text-gray-800 dark:text-gray-200">
              <div className="whitespace-pre-wrap break-words font-bold">{r.question}</div>
              <div className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2">{r.answer}</div>
            </div>
          )}
        </div>
      )))}
    </div>
  )
}

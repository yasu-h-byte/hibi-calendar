'use client'
/**
 * 経費の事前チェック（2026-11-08・docs/mf-expense-check.md 第1段階）。
 * MF経費の承認待ちの申請を毎朝読み、引っかかった申請だけを総務に見せる。見るだけの画面で、承認は MF で人が押す。
 * データは /api/mf-expense。決まりは lib/mf-expense-rules.ts。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { can } from '@/lib/permissions'
import { notify } from '@/lib/notify'
import { confirmDanger } from '@/lib/confirm-dialog'
import { Chip, FieldError, PageHeader, RowButton, SearchBox, TodoCard, UnderlineTabs } from '@/components/ui/PageParts'
import { SaveButton } from '@/components/ui/SaveButton'
import { todayJstIso } from '@/lib/date-utils'
import { buildMfRejectComment, hasMfRejectComment, type MfCommentLang } from '@/lib/mf-expense-comment'
import {
  MF_ITEM_KINDS, MF_ITEM_KIND_LABEL, MF_REVIEW_NOTE_MAX, MF_RULE_LABEL, mfApprovalWaitingLabel, mfExpenseSettingsError, normalizeMfReviewNote,
  type MfApprovalStep, type MfExpenseFlag, type MfExpenseReview, type MfExpenseSettings, type MfExpenseTx, type MfItemKind, type MfMemberLink, type MfReminderEntry,
} from '@/lib/mf-expense-rules'

interface Check {
  reportId: string
  number: number | null
  title: string
  status?: string
  approvals?: MfApprovalStep[]
  commentLang?: MfCommentLang
  submittedIso: string
  memberName: string
  total: number
  targetYm: string
  txs: MfExpenseTx[]
  flags: MfExpenseFlag[]
  confirmCount: number
  infoCount: number
  review?: MfExpenseReview
}

interface PageData {
  connection: {
    configured: boolean
    connected: boolean
    officeId: string | null
    officeName: string | null
    offices: { id: string; name: string }[]
    connectedAt: string | null
    authorizedMember: string | null
    needsReconnect: boolean
    lastError: string | null
  }
  runState: { lastRunAt: string | null; partial: boolean; lastError: string | null }
  receiptState: { configured: boolean; lastRunAt: string | null; lastError: string | null; lastRead: number; remaining: number }
  settings: MfExpenseSettings
  items: { id: string; name: string; active: boolean }[]
  members: MfMemberLink[]
  reminders: MfReminderEntry[]
  checks: Check[]
  workers: { id: number; name: string }[]
  redirectUri: string
}

type Tab = 'reports' | 'reminders' | 'members' | 'items' | 'rules'

const yen = (n: number) => `${Math.round(n).toLocaleString('ja-JP')}円`
const fmtDay = (iso: string) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '日付なし')
const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだありません')
const inputCls = 'h-9 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 text-sm'
const cardCls = 'bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 rounded-xl'
const MF_RESULT_MESSAGE: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'MF経費につなぎました。「今すぐチェック」で最初の読み込みをしてください' },
  denied: { ok: false, text: 'MF の画面で承認されなかったので、つないでいません' },
  state: { ok: false, text: '接続の手続きの有効期限が切れました。もう一度「MF経費につなぐ」を押してください' },
  failed: { ok: false, text: 'MF経費につなげませんでした。Vercel に入れた鍵と、MF に登録した Redirect URI を確かめてください' },
}

export default function ExpenseCheckPage() {
  const { password, ready, user } = useAuthPassword()
  const searchParams = useSearchParams()
  const canEdit = can(user, 'expenseCheck.edit')
  const isOwner = can(user, 'system.admin')
  const [data, setData] = useState<PageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('reports')
  const [running, setRunning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [reading, setReading] = useState(false)

  const load = useCallback(async () => {
    if (!password) return
    try {
      const r = await fetchWithAuth('/api/mf-expense', { password })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('読み込み', j?.error || 'サーバが受け付けませんでした'); return }
      setData(j)
    } catch (e) { notify.failed('読み込み', e) } finally { setLoading(false) }
  }, [password])
  useEffect(() => { if (ready) load() }, [ready, load])

  // MF の承認画面から戻ってきたときの結果
  useEffect(() => {
    const result = MF_RESULT_MESSAGE[searchParams.get('mf') || '']
    if (!result) return
    if (result.ok) notify.success(result.text, undefined, { sticky: true })
    else notify.error('MF経費につなげませんでした', result.text)
    window.history.replaceState(null, '', '/expense-check')
  }, [searchParams])

  const post = useCallback((body: unknown) => postJson<Record<string, unknown>>('/api/mf-expense', body, { password: password || undefined }), [password])

  const connect = async () => {
    setConnecting(true)
    const r = await post({ action: 'connect' })
    if (r.ok && typeof r.data?.url === 'string') { window.location.href = r.data.url; return }
    setConnecting(false)
    notify.failed('MF経費への接続', r.error)
  }

  const disconnect = async () => {
    const ok = await confirmDanger({ title: 'MF経費との接続を切りますか？', description: '毎朝のチェックが止まります。つなぎ直すには、もう一度 MF の画面で承認が要ります。', confirmLabel: '接続を切る' })
    if (!ok) return
    const r = await post({ action: 'disconnect' })
    if (!r.ok) { notify.failed('接続の解除', r.error); return }
    notify.success('MF経費との接続を切りました')
    load()
  }

  const run = async () => {
    setRunning(true)
    const r = await post({ action: 'run' })
    setRunning(false)
    if (!r.ok) { notify.failed('チェック', r.error || (typeof r.data?.message === 'string' ? r.data.message : undefined)); await load(); return }
    notify.success(typeof r.data?.message === 'string' ? r.data.message : 'チェックしました')
    await load()
  }

  const readReceipts = async () => {
    setReading(true)
    const res = await postJson<Record<string, unknown>>('/api/mf-expense/receipts', {}, { password: password || undefined })
    setReading(false)
    const message = typeof res.data?.message === 'string' ? res.data.message : undefined
    if (!res.ok) notify.failed('領収書の読み取り', res.error || message)
    else notify.success(message || '領収書を読みました')
    await load()
  }

  const chooseOffice = async (officeId: string) => {
    const r = await post({ action: 'selectOffice', officeId })
    if (!r.ok) { notify.failed('事業者の選択', r.error); return }
    load()
  }

  const conn = data?.connection
  const counts = useMemo(() => {
    const checks = data?.checks || []
    const unlinked = (data?.members || []).filter(m => m.active && m.how === null).length
    const unsetItems = (data?.items || []).filter(i => i.active && !data?.settings.itemKinds[i.id]).length
    return {
      flagged: checks.filter(c => c.confirmCount > 0 && !c.review).length,
      reviewed: checks.filter(c => c.confirmCount > 0 && c.review).length,
      clean: checks.filter(c => c.confirmCount === 0).length,
      unlinked,
      unsetItems,
      reminders: (data?.reminders || []).length,
    }
  }, [data])

  if (loading) return <div className="max-w-5xl mx-auto text-sm text-hibi-sub dark:text-gray-400 py-10">読み込んでいます</div>
  if (!data || !conn) return <div className="max-w-5xl mx-auto text-sm text-hibi-sub dark:text-gray-400 py-10">表示できませんでした。画面を開き直してください</div>

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader
        group="締め・請求"
        title="経費の事前チェック"
        sub="MF経費の承認待ちの申請を毎朝 7 時に確認し、引っかかった申請を上に出します。見るだけの画面です。承認と差し戻しは、これまでどおり MF経費で行います"
      />

      <ConnectionCard
        data={data} isOwner={isOwner} canEdit={canEdit} running={running} connecting={connecting} reading={reading}
        onConnect={connect} onDisconnect={disconnect} onRun={run} onReadReceipts={readReceipts} onChooseOffice={chooseOffice}
      />

      {conn.connected && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <TodoCard icon="alert" tone={counts.flagged > 0 ? 'warn' : 'ok'} title="要確認の申請" big={`${counts.flagged} 件`} sub={`確認済み ${counts.reviewed} 件・問題なし ${counts.clean} 件`} onClick={() => setTab('reports')} />
            <TodoCard icon="bell" tone={counts.reminders > 0 ? 'info' : 'ok'} title="声かけ" big={`${counts.reminders} 人`} sub="出し忘れ・差し戻したまま" onClick={() => setTab('reminders')} />
            <TodoCard icon="users" tone={counts.unlinked > 0 ? 'warn' : 'ok'} title="結びつけが未確定" big={`${counts.unlinked} 人`} sub="未確定の人は出面と比べられません" onClick={() => setTab('members')} />
            <TodoCard icon="receipt" tone={counts.unsetItems > 0 ? 'warn' : 'ok'} title="種類が未設定の科目" big={`${counts.unsetItems} 個`} sub="未設定の科目はチェックしません" onClick={() => setTab('items')} />
          </div>

          <UnderlineTabs
            label="表示の切り替え" active={tab} onChange={setTab}
            tabs={[
              { key: 'reports', label: '申請', badge: counts.flagged },
              { key: 'reminders', label: '声かけ', badge: counts.reminders },
              { key: 'members', label: '従業員の結びつけ', badge: counts.unlinked },
              { key: 'items', label: '科目の種類', badge: counts.unsetItems },
              { key: 'rules', label: '決まりの数字' },
            ]}
          />

          {tab === 'reports' && <ReportsTab checks={data.checks} canEdit={canEdit} post={post} reload={load} />}
          {tab === 'reminders' && <RemindersTab reminders={data.reminders} />}
          {tab === 'members' && <MembersTab members={data.members} workers={data.workers} canEdit={canEdit} post={post} reload={load} />}
          {tab === 'items' && <ItemsTab data={data} canEdit={canEdit} post={post} reload={load} />}
          {tab === 'rules' && <RulesTab data={data} canEdit={canEdit} post={post} reload={load} />}
        </>
      )}
    </div>
  )
}

type Post = (body: unknown) => ReturnType<typeof postJson<Record<string, unknown>>>

function ConnectionCard({ data, isOwner, canEdit, running, connecting, reading, onConnect, onDisconnect, onRun, onReadReceipts, onChooseOffice }: {
  data: PageData; isOwner: boolean; canEdit: boolean; running: boolean; connecting: boolean; reading: boolean
  onConnect: () => void; onDisconnect: () => void; onRun: () => void; onReadReceipts: () => void; onChooseOffice: (id: string) => void
}) {
  const { connection: c, runState: s, receiptState: rs } = data
  if (!c.configured) {
    return (
      <div className={`${cardCls} p-5 text-sm text-gray-700 dark:text-gray-200`}>
        MF経費の鍵がまだ設定されていません。{isOwner ? 'Vercel の環境変数に MF_EXPENSE_CLIENT_ID と MF_EXPENSE_CLIENT_SECRET を入れてください（手順は docs/mf-expense-check.md）。' : '代表の設定をお待ちください。'}
      </div>
    )
  }
  if (!c.connected || c.needsReconnect) {
    return (
      <div className={`${cardCls} p-5 flex flex-wrap items-center justify-between gap-3`}>
        <div className="text-sm text-gray-700 dark:text-gray-200">
          {c.needsReconnect ? (c.lastError || 'MF経費との接続が切れました。つなぎ直してください') : 'MF経費にまだつながっていません。'}
          {!isOwner && ' つなぐのは代表の作業です。'}
        </div>
        {isOwner && <RowButton tone="main" busy={connecting} busyLabel="MF の画面を開いています" onClick={onConnect}>{c.needsReconnect ? 'つなぎ直す' : 'MF経費につなぐ'}</RowButton>}
      </div>
    )
  }
  return (
    <div className={`${cardCls} p-5 space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700 dark:text-gray-200 space-y-0.5">
          <div>接続先: <b>{c.officeName || '事業者が選ばれていません'}</b>{c.authorizedMember && <span className="text-hibi-sub dark:text-gray-400">（{c.authorizedMember} さんの権限）</span>}</div>
          <div className="text-xs text-hibi-sub dark:text-gray-400">最後のチェック: {fmtAt(s.lastRunAt)}{s.partial && '（途中まで）'}</div>
          <div className="text-xs text-hibi-sub dark:text-gray-400">
            {rs.configured ? `領収書の読み取り: ${fmtAt(rs.lastRunAt)}${rs.remaining > 0 ? `（残り ${rs.remaining} 枚）` : ''}` : '領収書の読み取り: 鍵が未設定のため止まっています'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && c.officeId && <RowButton tone="main" busy={running} busyLabel="チェックしています" onClick={onRun}>今すぐチェック</RowButton>}
          {canEdit && c.officeId && rs.configured && <RowButton tone="ghost" busy={reading} busyLabel="領収書を読んでいます" onClick={onReadReceipts}>領収書を読む</RowButton>}
          {isOwner && <RowButton tone="ghost" onClick={onDisconnect}>接続を切る</RowButton>}
        </div>
      </div>
      {!c.officeId && isOwner && (
        <select defaultValue="" onChange={e => e.target.value && onChooseOffice(e.target.value)} className={inputCls} aria-label="事業者">
          <option value="">チェックする事業者を選んでください</option>
          {c.offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
      {s.lastError && <FieldError>前回のチェックは失敗しました: {s.lastError}</FieldError>}
      {rs.lastError && <FieldError>前回の領収書の読み取りで問題がありました: {rs.lastError}</FieldError>}
    </div>
  )
}

function FlagLine({ flag }: { flag: MfExpenseFlag }) {
  return (
    <div className="flex items-start gap-2 text-[0.8125rem] text-gray-800 dark:text-gray-200">
      <span className="shrink-0"><Chip tone={flag.level === 'confirm' ? 'amber' : 'gray'}>{MF_RULE_LABEL[flag.rule]}</Chip></span>
      <span>{flag.message}</span>
    </div>
  )
}

/** 要確認の申請に「確認した・理由」を残す欄。最終承認の人が、確認済みか見落としかを見分けるためのもの */
function ReviewBox({ c, canEdit, post, reload }: { c: Check; canEdit: boolean; post: Post; reload: () => Promise<void> }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (value: string | null) => {
    setBusy(true)
    const r = await post({ action: 'saveReview', reportId: c.reportId, note: value })
    if (!r.ok) { setBusy(false); notify.failed('確認の記録', r.error); return }
    await reload()
    setBusy(false)
    setNote('')
    setError('')
  }
  const save = () => {
    const n = normalizeMfReviewNote(note)
    if (!n.ok) { setError(n.error); return }
    send(n.note)
  }
  if (c.review) {
    return (
      <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-gray-800 dark:text-gray-200">
        <span><b>確認済み:</b> {c.review.note}<span className="text-xs text-hibi-sub dark:text-gray-400">（{c.review.byName}・{fmtAt(c.review.at)}）</span></span>
        {canEdit && <RowButton tone="ghost" busy={busy} busyLabel="取り消しています" onClick={() => send(null)}>取り消す</RowButton>}
      </div>
    )
  }
  if (!canEdit) return null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          className={`${inputCls} flex-1 min-w-0`} value={note} maxLength={MF_REVIEW_NOTE_MAX}
          aria-label={`${c.memberName} の申請の確認メモ`} placeholder="確かめた内容や理由を1行で（MF には書き込みません）"
          onChange={e => { setNote(e.target.value); setError('') }}
        />
        <RowButton tone="main" busy={busy} busyLabel="記録しています" onClick={save}>確認した</RowButton>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}

/** MF の差し戻しに貼るコメントの下書き。言語を切り替えられ、貼る前に直せる */
function RejectCommentBox({ c }: { c: Check }) {
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState<MfCommentLang>(c.commentLang || 'ja')
  const [text, setText] = useState('')
  const make = (l: MfCommentLang) => buildMfRejectComment({ flags: c.flags, txs: c.txs, targetYm: c.targetYm, today: todayJstIso(), lang: l })
  const start = () => { setText(make(lang)); setOpen(true) }
  const switchLang = (l: MfCommentLang) => { setLang(l); setText(make(l)) }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success('コピーしました。MF経費の差し戻しのコメントに貼り付けてください')
    } catch (e) { notify.failed('コピー', e) }
  }
  if (!open) return <div><RowButton tone="ghost" onClick={start}>差し戻しコメントを作る</RowButton></div>
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <RowButton tone={lang === 'ja' ? 'main' : 'ghost'} onClick={() => switchLang('ja')}>日本語</RowButton>
        <RowButton tone={lang === 'vi' ? 'main' : 'ghost'} onClick={() => switchLang('vi')}>ベトナム語</RowButton>
        <span className="ml-auto flex items-center gap-2">
          <RowButton tone="main" onClick={copy}>コピー</RowButton>
          <RowButton tone="ghost" onClick={() => setOpen(false)}>閉じる</RowButton>
        </span>
      </div>
      <textarea
        className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm leading-relaxed"
        rows={Math.min(14, text.split('\n').length + 1)} value={text} aria-label={`${c.memberName} の差し戻しコメント`}
        onChange={e => setText(e.target.value)}
      />
    </div>
  )
}

/** 「森田 ✓ → 日比（待ち）」の形で承認の進み具合を出す */
function ApprovalLine({ c }: { c: Check }) {
  const steps = c.approvals || []
  const named = steps.filter(a => a.name)
  if (named.length === 0) {
    const label = mfApprovalWaitingLabel(c.status || '', steps)
    return label ? <span className="col-span-2 text-xs text-hibi-sub dark:text-gray-400">{label}</span> : null
  }
  return (
    <span className="col-span-2 text-xs text-hibi-sub dark:text-gray-400">
      承認:{' '}
      {named.map((a, i) => (
        <span key={`${a.step}-${i}`}>
          {i > 0 && ' → '}
          <span className={a.active ? 'font-bold text-gray-800 dark:text-gray-100' : ''}>{a.name}</span>
          {a.approvedAt ? ' ✓' : a.active ? '（待ち）' : ''}
        </span>
      ))}
    </span>
  )
}

function ReportRow({ c, canEdit, post, reload }: { c: Check; canEdit: boolean; post: Post; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const shownFlags = [...c.flags].sort((a, b) => (a.level === b.level ? 0 : a.level === 'confirm' ? -1 : 1))
  return (
    <div className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-3 space-y-2">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full text-left grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 items-center">
        <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{c.memberName}</span>
        <span className="justify-self-end text-sm font-bold text-gray-900 dark:text-gray-100 tabular-nums">{yen(c.total)}</span>
        <span className="text-xs text-hibi-sub dark:text-gray-400 truncate">{c.title || '題名なし'}（申請 {fmtDay(c.submittedIso)}・明細 {c.txs.length} 件）</span>
        <span className="justify-self-end">
          {c.confirmCount === 0 ? <Chip tone="green">✓ チェック済み</Chip> : c.review ? <Chip tone="blue">確認済み</Chip> : <Chip tone="amber">要確認 {c.confirmCount}</Chip>}
        </span>
        <ApprovalLine c={c} />
      </button>
      {shownFlags.length > 0 && <div className="space-y-1">{shownFlags.map((f, i) => <FlagLine key={i} flag={f} />)}</div>}
      {c.confirmCount > 0 && <ReviewBox c={c} canEdit={canEdit} post={post} reload={reload} />}
      {canEdit && hasMfRejectComment(c.flags) && <RejectCommentBox c={c} />}
      {open && (
        <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 divide-y divide-hibi-line dark:divide-gray-700">
          {c.txs.map(t => (
            <div key={t.id} className="px-3 py-1.5 grid grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-2 text-xs text-gray-700 dark:text-gray-300">
              <span className="tabular-nums">{fmtDay(t.date)}</span>
              <span className="truncate">{t.itemName}・{t.remark || '内容なし'}{!t.hasFile && <span className="text-hibi-sub dark:text-gray-400">（添付なし）</span>}{t.receipt && <span className="text-hibi-sub dark:text-gray-400">（領収書 {t.receipt.readable ? `${t.receipt.date ? fmtDay(t.receipt.date) : '日付不明'}・${t.receipt.amount !== null ? yen(t.receipt.amount) : '金額不明'}` : '読めず'}）</span>}</span>
              <span className="tabular-nums justify-self-end">{yen(t.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 未確認の要確認 → 確認済み → 問題なし の順 */
const reportRank = (c: Check) => (c.confirmCount === 0 ? 2 : c.review ? 1 : 0)

function ReportsTab({ checks, canEdit, post, reload }: { checks: Check[]; canEdit: boolean; post: Post; reload: () => Promise<void> }) {
  if (checks.length === 0) return <div className={`${cardCls} p-8 text-center text-sm text-hibi-sub dark:text-gray-400`}>承認待ちの申請はありません</div>
  const sorted = [...checks].sort((a, b) => reportRank(a) - reportRank(b) || b.confirmCount - a.confirmCount || b.infoCount - a.infoCount || a.submittedIso.localeCompare(b.submittedIso))
  const waiting = new Map<string, number>()
  for (const c of checks) {
    const label = mfApprovalWaitingLabel(c.status || '', c.approvals)
    if (label) waiting.set(label, (waiting.get(label) || 0) + 1)
  }
  return (
    <div className="space-y-3">
      {waiting.size > 0 && (
        <div className="flex flex-wrap gap-2">
          {Array.from(waiting).map(([label, n]) => <Chip key={label} tone="blue">{label} {n} 件</Chip>)}
        </div>
      )}
      <div className={cardCls}>{sorted.map(c => <ReportRow key={c.reportId} c={c} canEdit={canEdit} post={post} reload={reload} />)}</div>
    </div>
  )
}

function RemindersTab({ reminders }: { reminders: MfReminderEntry[] }) {
  if (reminders.length === 0) return <div className={`${cardCls} p-8 text-center text-sm text-hibi-sub dark:text-gray-400`}>今は声をかける人はいません（毎月 8 日から出ます）</div>
  return (
    <div className={cardCls}>
      {reminders.map((r, i) => (
        <div key={i} className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-2.5 flex items-center gap-3">
          <Chip tone={r.level === 'confirm' ? 'amber' : 'gray'}>{MF_RULE_LABEL[r.rule]}</Chip>
          <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{r.name}</span>
          <span className="text-xs text-hibi-sub dark:text-gray-400">{r.message}</span>
        </div>
      ))}
    </div>
  )
}

function MembersTab({ members, workers, canEdit, post, reload }: {
  members: MfMemberLink[]; workers: PageData['workers']; canEdit: boolean; post: Post; reload: () => Promise<void>
}) {
  const [q, setQ] = useState('')
  const workerName = useMemo(() => new Map(workers.map(w => [w.id, w.name])), [workers])
  const order = (m: MfMemberLink) => (m.how === null ? 0 : m.nameDiffers ? 1 : 2)
  const norm = q.trim().replace(/[\s　]/g, '')
  const shown = members
    .filter(m => m.active && (!norm || m.name.replace(/[\s　]/g, '').includes(norm)))
    .sort((a, b) => order(a) - order(b) || a.number.localeCompare(b.number))

  const save = async (mfId: string, value: string) => {
    const workerId = value === 'excluded' ? null : Number(value)
    const r = await post({ action: 'saveMember', mfId, workerId })
    if (!r.ok) { notify.failed('保存', r.error); return }
    notify.success('結びつけを保存しました', '「今すぐチェック」を押すと、申請の結果に反映されます')
    reload()
  }

  if (members.length === 0) return <div className={`${cardCls} p-8 text-center text-sm text-hibi-sub dark:text-gray-400`}>「今すぐチェック」を押すと MF の従業員を読み込みます</div>
  return (
    <div className="space-y-3">
      <p className="text-xs text-hibi-sub dark:text-gray-400">MF の従業員番号とキャシュモの番号が一致した人は自動で結びつけています。未確定の人は、氏名の近い作業員を候補の先頭に出しているので、確かめて選んでください。作業員でない人は「作業員ではない」を選びます。</p>
      <SearchBox value={q} onChange={setQ} placeholder="MF の氏名で探す" />
      <div className={cardCls}>
        {shown.map(m => (
          <div key={m.mfId} className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-2.5 flex flex-wrap items-center gap-3">
            <span className="w-14 text-xs tabular-nums text-hibi-sub dark:text-gray-400">{m.number || '番号なし'}</span>
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100 min-w-[8rem]">{m.name}</span>
            {m.how === null && <Chip tone="amber">未確定</Chip>}
            {m.how === 'number' && <Chip tone="green">番号が一致</Chip>}
            {m.how === 'manual' && <Chip tone="blue">確定</Chip>}
            {m.how === 'excluded' && <Chip tone="gray">作業員ではない</Chip>}
            {m.nameDiffers && <Chip tone="amber" title="番号は一致しましたが、氏名の書き方が違います。同じ人か確かめてください">氏名が違う</Chip>}
            <select
              className={`${inputCls} ml-auto`} aria-label={`${m.name} の作業員`} disabled={!canEdit}
              value={m.how === 'excluded' ? 'excluded' : m.workerId === null ? '' : String(m.workerId)}
              onChange={e => e.target.value && save(m.mfId, e.target.value)}
            >
              <option value="">選んでください</option>
              {m.candidates.length > 0 && (
                <optgroup label="候補">
                  {m.candidates.map(id => <option key={id} value={String(id)}>{workerName.get(id) || id}</option>)}
                </optgroup>
              )}
              <optgroup label="日比建設の作業員">
                {workers.map(w => <option key={w.id} value={String(w.id)}>{w.name}</option>)}
              </optgroup>
              <option value="excluded">作業員ではない</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

function ItemsTab({ data, canEdit, post, reload }: { data: PageData; canEdit: boolean; post: Post; reload: () => Promise<void> }) {
  const [kinds, setKinds] = useState<Record<string, MfItemKind>>(data.settings.itemKinds)
  const save = async () => {
    const r = await post({ action: 'saveSettings', settings: { ...data.settings, itemKinds: kinds } })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  }
  const items = data.items.filter(i => i.active)
  if (items.length === 0) return <div className={`${cardCls} p-8 text-center text-sm text-hibi-sub dark:text-gray-400`}>「今すぐチェック」を押すと MF の経費科目を読み込みます</div>
  return (
    <div className="space-y-3">
      <p className="text-xs text-hibi-sub dark:text-gray-400">MF の科目ごとに種類を選びます。種類が未設定の科目は、領収書や科目のチェックをしません。</p>
      <div className={cardCls}>
        {[...items].sort((a, b) => Number(!!kinds[a.id]) - Number(!!kinds[b.id])).map(i => (
          <div key={i.id} className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-2.5 flex items-center justify-between gap-3">
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{i.name}</span>
            <select className={inputCls} aria-label={`${i.name} の種類`} disabled={!canEdit} value={kinds[i.id] || ''}
              onChange={e => setKinds(prev => {
                const next = { ...prev }
                if (e.target.value) next[i.id] = e.target.value as MfItemKind
                else delete next[i.id]
                return next
              })}>
              <option value="">未設定</option>
              {MF_ITEM_KINDS.map(k => <option key={k} value={k}>{MF_ITEM_KIND_LABEL[k]}</option>)}
            </select>
          </div>
        ))}
      </div>
      {canEdit && <SaveButton onSave={save} onSaved={reload} />}
    </div>
  )
}

function RulesTab({ data, canEdit, post, reload }: { data: PageData; canEdit: boolean; post: Post; reload: () => Promise<void> }) {
  const [form, setForm] = useState({
    amountPct: String(data.settings.amountPct), m1Day: String(data.settings.m1Day), m2Day: String(data.settings.m2Day),
    transitWords: data.settings.transitWords.join('、'), gasWords: data.settings.gasWords.join('、'), splitWords: data.settings.splitWords.join('、'),
  })
  const words = (s: string) => s.split(/[、,\s　]+/).map(w => w.trim()).filter(Boolean)
  const next: MfExpenseSettings = {
    itemKinds: data.settings.itemKinds,
    amountPct: Number(form.amountPct), m1Day: Number(form.m1Day), m2Day: Number(form.m2Day),
    transitWords: words(form.transitWords), gasWords: words(form.gasWords), splitWords: words(form.splitWords),
  }
  const error = mfExpenseSettingsError(next)
  const save = async () => {
    const r = await post({ action: 'saveSettings', settings: next })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  }
  const Field = ({ k, label, type = 'number' }: { k: keyof typeof form; label: string; type?: string }) => (
    <label className="block space-y-1">
      <span className="text-xs font-bold text-gray-700 dark:text-gray-300">{label}</span>
      <input type={type} className={`${inputCls} w-full`} disabled={!canEdit} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
    </label>
  )
  return (
    <div className={`${cardCls} p-5 space-y-4 max-w-xl`}>
      {Field({ k: 'amountPct', label: '「いつもと大きく違う」の幅（%）' })}
      {Field({ k: 'm1Day', label: '出し忘れの声かけを出し始める日' })}
      {Field({ k: 'm2Day', label: '締め切り後の確認を出し始める日' })}
      {Field({ k: 'transitWords', label: '交通費の言葉（「、」で区切る）', type: 'text' })}
      {Field({ k: 'gasWords', label: 'ガソリン代の言葉（「、」で区切る）', type: 'text' })}
      {Field({ k: 'splitWords', label: '道具代の折半の言葉（「、」で区切る）', type: 'text' })}
      {error && <FieldError>{error}</FieldError>}
      {canEdit && <SaveButton onSave={save} onSaved={reload} disabled={!!error} />}
    </div>
  )
}

'use client'
/**
 * 困ったこと・要望（2026-10-09 代表「要望欄で森田さんとやり取りしながらシステムの修正につなげたい」）。
 * 決まりは lib/feedback.ts、保存は /api/feedback。
 *
 * - 書いた人: 自分の書き込みだけが並ぶ。行を押すと右にやり取りが開き、返信できる
 * - 代表: 全員の書き込みが並ぶ。返信と状態（受付・対応中・直した・見送り）の切り替え
 * - 返信が来ると、メニューの「困ったこと・要望」に件数が付く（開くと消える）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { notify } from '@/lib/notify'
import { visibleMenuItems } from '@/lib/menu'
import { PageHeader, ToolButton, Segment, Chip, SidePanel, CloseButton, FieldError } from '@/components/ui/PageParts'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import {
  FEEDBACK_KIND_LABEL, FEEDBACK_STATUS_LABEL, FEEDBACK_STATUS_TONE, FEEDBACK_LIMITS, feedbackTextError, isUnreadFor, sortFeedback,
  type FeedbackKind, type FeedbackStatus, type FeedbackThread, type FeedbackMessage,
} from '@/lib/feedback'

interface ListRow {
  id: string
  createdAt: string
  updatedAt: string
  author: { workerId: number; name: string }
  kind: FeedbackKind
  page: string
  title: string
  status: FeedbackStatus
  unreadForAuthor: boolean
  unreadForOwner: boolean
  count: number
  last: { by: FeedbackMessage['by']; text: string; at: string } | null
}
interface Me { workerId: number; name: string; manage: boolean }
type SignedImage = { path: string; name: string; url: string | null }
type ThreadDetail = Omit<FeedbackThread, 'messages'> & { messages: (Omit<FeedbackMessage, 'images'> & { images?: SignedImage[] })[] }
interface Attach { name: string; dataUrl: string }

const fmtAt = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 画像を縮めて JPEG の data URL にする（長い辺 1600px・送る量を減らす） */
async function shrinkImage(file: File): Promise<Attach> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('画像を読み込めませんでした'))
      i.src = url
    })
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('画像を縮められませんでした')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    let q = 0.82
    let dataUrl = canvas.toDataURL('image/jpeg', q)
    // 1枚の上限（base64 は約4/3倍）に収まるまで画質を下げる
    while (dataUrl.length * 0.75 > FEEDBACK_LIMITS.imageBytes && q > 0.4) {
      q -= 0.12
      dataUrl = canvas.toDataURL('image/jpeg', q)
    }
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', dataUrl }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 画像を付ける欄（スクリーンショット・写真） */
function AttachPicker({ items, onChange }: { items: Attach[]; onChange: (a: Attach[]) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const pick = async (files: FileList | null) => {
    if (!files) return
    const room = FEEDBACK_LIMITS.images - items.length
    const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, room)
    try {
      const shrunk = await Promise.all(list.map(shrinkImage))
      onChange([...items, ...shrunk])
    } catch (e) { notify.failed('画像を付ける', e) }
    if (ref.current) ref.current.value = ''
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {items.map((a, i) => (
        <span key={i} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL のプレビュー */}
          <img src={a.dataUrl} alt={a.name} className="h-14 w-14 object-cover rounded border border-hibi-line dark:border-gray-600" />
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white text-xs leading-5 text-center" aria-label="この画像を外す">×</button>
        </span>
      ))}
      {items.length < FEEDBACK_LIMITS.images && (
        <button type="button" onClick={() => ref.current?.click()}
          className="h-9 px-3 rounded-lg border border-dashed border-gray-400 dark:border-gray-500 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-hibi-bg dark:hover:bg-gray-700">
          ＋ 画像（スクショ）を付ける
        </button>
      )}
      <input ref={ref} type="file" accept="image/*" multiple className="hidden" onChange={e => pick(e.target.files)} />
    </div>
  )
}

type Filter = 'active' | 'all' | 'closed'

export default function FeedbackPage() {
  const { password, user, ready } = useAuthPassword()
  const [list, setList] = useState<ListRow[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [filter, setFilter] = useState<Filter>('active')

  const fetchList = useCallback(async () => {
    if (!password) return
    try {
      const r = await fetch('/api/feedback', { headers: { 'x-admin-password': password } })
      if (!r.ok) { const j = await r.json().catch(() => null); notify.failed('読み込み', j?.error || 'サーバが受け付けませんでした'); return }
      const j = await r.json()
      setList(j.list || [])
      setMe(j.me || null)
    } catch (e) { notify.failed('読み込み', e) } finally { setLoading(false) }
  }, [password])

  useEffect(() => { if (ready) fetchList() }, [ready, fetchList])

  const unread = useCallback((t: ListRow) => !!me && isUnreadFor(t, me), [me])
  const closed = (s: FeedbackStatus) => s === 'done' || s === 'wontfix'
  const shown = useMemo(() => sortFeedback(
    list.filter(t => filter === 'all' || (filter === 'closed' ? closed(t.status) : !closed(t.status))), unread,
  ), [list, filter, unread])
  const unreadCount = list.filter(unread).length

  // 「どの画面のことか」の選択肢は、その人のメニュー
  const pageOptions = useMemo(() => user ? visibleMenuItems(user).map(i => i.label) : [], [user])

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader
        group="マスタ・管理"
        title="困ったこと・要望"
        sub={me?.manage
          ? '全員の書き込みです。行を押すとやり取りが開きます。返信と状態（受付・対応中・直した・見送り）の切り替えができます'
          : 'システムで困ったこと・こうしてほしいこと・使い方の質問を書いてください。返事はここに届きます（メニューに件数が付きます）'}
        actions={<ToolButton icon="pen" onClick={() => setShowNew(true)}>新しく書く</ToolButton>}
      />

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
          <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">
            {me?.manage ? '書き込み' : '自分の書き込み'}
            {unreadCount > 0 && <span className="ml-2 text-sm text-red-700 dark:text-red-400">未読 {unreadCount}件</span>}
          </h2>
          <Segment value={filter} onChange={setFilter} items={[
            ['active', `やり取り中 ${list.filter(t => !closed(t.status)).length}`],
            ['closed', `終わったもの ${list.filter(t => closed(t.status)).length}`],
            ['all', `すべて ${list.length}`],
          ]} />
        </div>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-hibi-sub">読み込み中...</div>
        ) : shown.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-hibi-sub dark:text-gray-400">
            {list.length === 0 ? <>まだ書き込みはありません。右上の「新しく書く」から書いてください</> : '当てはまる書き込みはありません'}
          </div>
        ) : shown.map(t => {
          const u = unread(t)
          return (
            <div key={t.id} role="button" tabIndex={0}
              onClick={() => setOpenId(t.id)} onKeyDown={e => { if (e.key === 'Enter') setOpenId(t.id) }}
              className="border-t first:border-t-0 border-hibi-line dark:border-gray-700 px-5 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${u ? 'bg-red-600' : 'bg-transparent'}`} aria-label={u ? '未読' : undefined} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={FEEDBACK_STATUS_TONE[t.status]}>{FEEDBACK_STATUS_LABEL[t.status]}</Chip>
                  <Chip tone="gray">{FEEDBACK_KIND_LABEL[t.kind]}</Chip>
                  {t.page && <span className="text-xs text-hibi-sub dark:text-gray-400">{t.page}</span>}
                </div>
                <div className={`mt-1 text-[0.9375rem] truncate ${u ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-800 dark:text-gray-200'}`}>{t.title}</div>
                {t.last && (
                  <div className="text-xs text-hibi-sub dark:text-gray-400 truncate">
                    {t.last.by.kind === 'dev' ? '開発' : t.last.by.name}: {t.last.text || '（画像）'}
                  </div>
                )}
              </div>
              <div className="text-right shrink-0 text-xs text-hibi-sub dark:text-gray-400 tabular-nums">
                {me?.manage && <div className="font-bold text-gray-700 dark:text-gray-300">{t.author.name}</div>}
                <div>{fmtAt(t.updatedAt)}</div>
                <div>{t.count}件</div>
              </div>
            </div>
          )
        })}
      </section>

      {openId && me && (
        <ThreadPanel id={openId} me={me} password={password}
          onClose={() => setOpenId(null)} onChanged={fetchList} />
      )}
      {showNew && (
        <NewModal password={password} pageOptions={pageOptions}
          onClose={() => setShowNew(false)}
          onCreated={id => { setShowNew(false); fetchList(); setOpenId(id) }} />
      )}
    </div>
  )
}

// ────────────────────────────────────────
//  新しく書く
// ────────────────────────────────────────

function NewModal({ password, pageOptions, onClose, onCreated }: {
  password: string
  pageOptions: string[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [kind, setKind] = useState<FeedbackKind>('trouble')
  const [page, setPage] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attach[]>([])
  const [tried, setTried] = useState(false)
  const err = feedbackTextError(text, images.length)
  const dirty = !!(title || text || images.length)

  const send = async () => {
    setTried(true)
    if (err) return null
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ action: 'create', kind, page, title, text, images }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: j?.error || 'サーバが受け付けませんでした' }
    notify.success('書き込みました。返事はこの画面に届きます')
    onCreated(j.id)
  }

  return (
    <Modal open onClose={onClose} title="困ったこと・要望を書く" size="lg" dirty={dirty}
      footer={<><CancelButton onClick={onClose} /><SaveButton action="送る" label="送る" onSave={send} /></>}>
      <div className="space-y-4">
        <div>
          <div className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">種類</div>
          <Segment value={kind} onChange={setKind} items={(Object.keys(FEEDBACK_KIND_LABEL) as FeedbackKind[]).map(k => [k, FEEDBACK_KIND_LABEL[k]] as const)} />
        </div>
        <label className="block">
          <span className="text-xs font-bold text-gray-600 dark:text-gray-300">どの画面のこと？</span>
          <select value={page} onChange={e => setPage(e.target.value)}
            className="mt-1 w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
            <option value="">全体・わからない</option>
            {pageOptions.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="スタッフのスマホ">スタッフのスマホ</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold text-gray-600 dark:text-gray-300">ひとことで（なくても可）</span>
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={FEEDBACK_LIMITS.title}
            placeholder="例: ラップさんの購入履歴が出ない"
            className="mt-1 w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-xs font-bold text-gray-600 dark:text-gray-300">内容</span>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6} maxLength={FEEDBACK_LIMITS.text}
            placeholder="何をしたら、どうなったか。どうなってほしいか。だれ（スタッフ名）・いつ（日付）の話かも書いてもらえると早く直せます"
            className="mt-1 w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          {tried && err && <FieldError>{err}</FieldError>}
        </label>
        <AttachPicker items={images} onChange={setImages} />
      </div>
    </Modal>
  )
}

// ────────────────────────────────────────
//  やり取り（右から開く）
// ────────────────────────────────────────

function ThreadPanel({ id, me, password, onClose, onChanged }: {
  id: string
  me: Me
  password: string
  onClose: () => void
  onChanged: () => void
}) {
  const [t, setT] = useState<ThreadDetail | null>(null)
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attach[]>([])
  const [tried, setTried] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/feedback?id=${encodeURIComponent(id)}`, { headers: { 'x-admin-password': password } })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('読み込み', j?.error || 'サーバが受け付けませんでした'); return null }
      setT(j.thread)
      return j.thread as ThreadDetail
    } catch (e) { notify.failed('読み込み', e); return null }
  }, [id, password])

  // 開いたら読み込み、未読なら既読にする（メニューの件数も減る）
  useEffect(() => {
    let alive = true
    load().then(async th => {
      if (!alive || !th) return
      if (isUnreadFor(th, me)) {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
          body: JSON.stringify({ action: 'markRead', id }),
        }).catch(() => null)
        onChanged()
      }
    })
    return () => { alive = false }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps -- 開いたときだけ

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [t?.messages.length])

  const err = feedbackTextError(text, images.length)
  const send = async () => {
    setTried(true)
    if (err) return null
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ action: 'reply', id, text, images }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: j?.error || 'サーバが受け付けませんでした' }
    setText('')
    setImages([])
    setTried(false)
    await load()
    onChanged()
  }

  const setStatus = async (status: FeedbackStatus) => {
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'setStatus', id, status }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) { notify.failed('状態の変更', j?.error || 'サーバが受け付けませんでした'); return }
      notify.success(`「${FEEDBACK_STATUS_LABEL[status]}」にしました`)
      await load()
      onChanged()
    } catch (e) { notify.failed('状態の変更', e) }
  }

  const who = (m: ThreadDetail['messages'][number]) =>
    m.by.kind === 'dev' ? '開発（Claude）' : m.by.kind === 'owner' ? `${m.by.name}（代表）` : m.by.name
  const isMine = (m: ThreadDetail['messages'][number]) =>
    m.by.kind !== 'dev' && m.by.workerId === me.workerId

  return (
    <SidePanel label={t ? `${t.title} のやり取り` : 'やり取り'} onClose={onClose} dirty={!!(text || images.length)}>
      <div className="flex flex-col min-h-full bg-white dark:bg-gray-800">
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-hibi-line dark:border-gray-700 px-6 py-4 flex items-start gap-3 z-10">
          <div className="flex-1 min-w-0">
            <h2 className="text-[1.25rem] font-bold text-gray-900 dark:text-white break-words">{t?.title || '読み込み中…'}</h2>
            {t && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-hibi-sub dark:text-gray-400">
                <Chip tone={FEEDBACK_STATUS_TONE[t.status]}>{FEEDBACK_STATUS_LABEL[t.status]}</Chip>
                <Chip tone="gray">{FEEDBACK_KIND_LABEL[t.kind]}</Chip>
                {t.page && <span>{t.page}</span>}
                <span>・{t.author.name}・{fmtAt(t.createdAt)}</span>
              </div>
            )}
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {t && me.manage && (
          <div className="px-6 pt-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-gray-600 dark:text-gray-300">状態</span>
            <Segment value={t.status} onChange={setStatus}
              items={(Object.keys(FEEDBACK_STATUS_LABEL) as FeedbackStatus[]).map(s => [s, FEEDBACK_STATUS_LABEL[s]] as const)} />
          </div>
        )}

        <div className="flex-1 px-6 py-4 space-y-3">
          {t?.messages.map(m => (
            <div key={m.id} className={`flex ${isMine(m) ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 ${isMine(m)
                ? 'bg-hibi-active text-gray-900 dark:bg-blue-900/40 dark:text-gray-100'
                : m.by.kind === 'dev'
                  ? 'bg-green-50 text-gray-900 border border-green-200 dark:bg-green-900/30 dark:text-gray-100 dark:border-green-800'
                  : 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'}`}>
                <div className="text-2xs font-bold text-hibi-sub dark:text-gray-400 mb-0.5">{who(m)}・{fmtAt(m.at)}</div>
                {m.text && <div className="text-sm whitespace-pre-wrap break-words">{m.text}</div>}
                {m.images && m.images.length > 0 && (
                  <div className="flex gap-2 flex-wrap mt-1.5">
                    {m.images.map(im => im.url ? (
                      <a key={im.path} href={im.url} target="_blank" rel="noopener noreferrer" title="大きく見る">
                        {/* eslint-disable-next-line @next/next/no-img-element -- 署名つきURL（15分）の画像 */}
                        <img src={im.url} alt={im.name} className="h-24 max-w-[180px] object-cover rounded border border-hibi-line dark:border-gray-600" />
                      </a>
                    ) : <span key={im.path} className="text-xs text-hibi-sub">（画像を開けません）</span>)}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {t && (
          <div className="sticky bottom-0 bg-white dark:bg-gray-800 border-t border-hibi-line dark:border-gray-700 px-6 py-3 space-y-2">
            <textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={FEEDBACK_LIMITS.text}
              placeholder={me.manage && t.author.workerId !== me.workerId ? `${t.author.name} さんへの返信` : '返信・書き足し'}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
            {tried && err && <FieldError>{err}</FieldError>}
            <div className="flex items-center gap-2 flex-wrap">
              <AttachPicker items={images} onChange={setImages} />
              <span className="ml-auto"><SaveButton action="返信" label="送る" onSave={send} /></span>
            </div>
          </div>
        )}
      </div>
    </SidePanel>
  )
}

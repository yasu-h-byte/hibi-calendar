'use client'

/**
 * 書類庫（2026-09-28 第1段階）— スタッフの在留カード・雇用契約書などを入れておく場所。
 * 仕組みは lib/staff-docs.ts、API は app/api/staff-docs/route.ts。
 *
 * - 上: 期限切れ・90日以内・人員マスタとの食い違い・不足書類のまとめ
 * - 下: スタッフごとの書類（最新／旧版）。ファイルは署名つきURLで新しいタブに開く
 * - 「＋ 書類を入れる」: ファイルを選ぶ（またはドラッグ）→ 種類・期限 → 登録
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { can } from '@/lib/permissions'
import { cardCls } from '@/lib/styles'
import { visaLabel } from '@/lib/labels'
import { todayJstIso } from '@/lib/date-utils'
import {
  STAFF_DOC_TYPES, STAFF_DOC_ALLOWED_TYPES, STAFF_DOC_MAX_FILE_BYTES, STAFF_DOC_MAX_FILES, EXPIRY_WARN_DAYS,
  staffDocTypeDef, expiryState, daysUntil, masterMismatches, missingRequiredTypes, inferDocType,
  type StaffDoc, type StaffDocType,
} from '@/lib/staff-docs'

interface W { id: number; name: string; visaType?: string; visa?: string; visaExpiry?: string; retired?: string; company?: string; org?: string }

const isForeign = (w: W) => { const v = w.visaType ?? w.visa; return !!v && v !== 'none' }

/** ブラウザが Content-Type を付けない HEIC などを拡張子で補う */
function contentTypeOf(f: File): string {
  if (f.type) return f.type
  const ext = f.name.toLowerCase().split('.').pop()
  if (ext === 'heic') return 'image/heic'
  if (ext === 'heif') return 'image/heif'
  if (ext === 'pdf') return 'application/pdf'
  return ''
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

function ExpiryBadge({ expiresOn, today }: { expiresOn?: string; today: string }) {
  const st = expiryState(expiresOn, today)
  if (st === 'none') return null
  const n = daysUntil(expiresOn, today) ?? 0
  if (st === 'expired') return <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[11px] font-bold">期限切れ（{-n}日前）</span>
  if (st === 'soon') return <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-bold">あと{n}日</span>
  return <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px]">あと{n}日</span>
}

export default function StaffDocsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中...</div>}>
      <StaffDocsInner />
    </Suspense>
  )
}

function StaffDocsInner() {
  const { user, ready } = useAuthPassword()
  const canEdit = can(user, 'staffDocs.edit')
  const canDelete = can(user, 'staffDocs.delete')
  const today = todayJstIso()
  const search = useSearchParams()
  const focusWorker = Number(search.get('worker') || 0) || null

  const [workers, setWorkers] = useState<W[]>([])
  const [docs, setDocs] = useState<StaffDoc[]>([])
  const [storageReady, setStorageReady] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterWorker, setFilterWorker] = useState<number | null>(focusWorker)
  const [showOld, setShowOld] = useState<Record<number, boolean>>({})
  const [uploadFor, setUploadFor] = useState<{ workerId: number | null; type?: StaffDocType } | null>(null)
  const [editing, setEditing] = useState<StaffDoc | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [wr, dr] = await Promise.all([fetchWithAuth('/api/workers'), fetchWithAuth('/api/staff-docs')])
      if (!dr.ok) {
        const j = await dr.json().catch(() => ({}))
        throw new Error(j.error || `読み込みに失敗しました（${dr.status}）`)
      }
      const wj = await wr.json()
      const dj = await dr.json()
      setWorkers((wj.workers || []) as W[])
      setDocs((dj.docs || []) as StaffDoc[])
      setStorageReady(dj.storageReady !== false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (ready) load() }, [ready, load])

  // 対象: 在籍中のベトナム人 ＋ 書類が既にある人（退職者の書類も見られるように）
  const targets = useMemo(() => {
    const withDocs = new Set(docs.map(d => d.workerId))
    return workers
      .filter(w => (isForeign(w) && !w.retired) || withDocs.has(w.id))
      .sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || a.id - b.id)
  }, [workers, docs])

  const docsOf = useCallback((id: number) => docs.filter(d => d.workerId === id), [docs])

  // ── まとめ（期限・食い違い・不足）──
  const summary = useMemo(() => {
    const expiring: { w: W; label: string; expiresOn: string; source: string }[] = []
    const mismatches: { w: W; msg: string }[] = []
    const missing: { w: W; types: StaffDocType[] }[] = []
    for (const w of targets) {
      if (w.retired) continue
      const ds = docsOf(w.id)
      for (const d of ds.filter(d => d.status === 'current')) {
        const st = expiryState(d.expiresOn, today)
        if (st === 'expired' || st === 'soon') expiring.push({ w, label: staffDocTypeDef(d.type).label, expiresOn: d.expiresOn!, source: '書類' })
      }
      // 在留カードがまだ入っていない人は、人員マスタの在留期限で知らせる
      if (!ds.some(d => d.type === 'residence_card' && d.status === 'current')) {
        const st = expiryState(w.visaExpiry, today)
        if (st === 'expired' || st === 'soon') expiring.push({ w, label: '在留期限', expiresOn: w.visaExpiry!, source: '人員マスタ' })
      }
      for (const msg of masterMismatches(w, ds)) mismatches.push({ w, msg })
      const miss = missingRequiredTypes(ds)
      if (miss.length > 0) missing.push({ w, types: miss })
    }
    expiring.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))
    return { expiring, mismatches, missing }
  }, [targets, docsOf, today])

  const openFile = async (d: StaffDoc, i: number) => {
    // ポップアップブロックを避けるため、先にタブを開いてから URL を入れる
    const win = window.open('', '_blank')
    try {
      const res = await fetchWithAuth(`/api/staff-docs?open=${encodeURIComponent(d.id)}&i=${i}`)
      const j = await res.json()
      if (!res.ok || !j.url) throw new Error(j.error || 'ファイルを開けませんでした')
      if (win) win.location.href = j.url
      else window.location.href = j.url
    } catch (e) {
      win?.close()
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const setStatus = async (d: StaffDoc, status: 'current' | 'old') => {
    const r = await postJson('/api/staff-docs', { action: 'setStatus', docId: d.id, status })
    if (!r.ok) { alert(r.error || '変更できませんでした'); return }
    load()
  }

  const remove = async (d: StaffDoc) => {
    if (!confirm(`「${staffDocTypeDef(d.type).label}${d.title ? `（${d.title}）` : ''}」をファイルごと削除します。元に戻せません。よろしいですか？\n\n古くなっただけなら、削除ではなく「旧版にする」を使ってください。`)) return
    const r = await postJson('/api/staff-docs', { action: 'delete', docId: d.id })
    if (!r.ok) { alert(r.error || '削除できませんでした'); return }
    load()
  }

  const shown = filterWorker ? targets.filter(w => w.id === filterWorker) : targets

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">🗂 書類庫</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            在留カード・雇用契約書など。新しい書類を入れると前のものは「旧版」として残ります。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filterWorker ?? ''}
            onChange={e => setFilterWorker(e.target.value ? Number(e.target.value) : null)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white"
          >
            <option value="">全員</option>
            {targets.map(w => <option key={w.id} value={w.id}>{w.name}{w.retired ? '（退職）' : ''}</option>)}
          </select>
          {canEdit && (
            <button
              onClick={() => setUploadFor({ workerId: filterWorker })}
              disabled={!storageReady}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-hibi-navy text-white hover:bg-hibi-light disabled:opacity-40"
            >
              ＋ 書類を入れる
            </button>
          )}
        </div>
      </div>

      {!storageReady && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm p-3">
          ファイルの置き場に接続できません。書類の一覧は見られますが、登録と閲覧はできません（サーバー設定の確認が必要です）。
        </div>
      )}
      {error && <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm p-3">{error}</div>}
      {loading && <div className={cardCls('p-8 text-center text-gray-400')}>読み込み中...</div>}

      {!loading && !error && (
        <>
          {/* ── まとめ ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className={cardCls('p-4')}>
              <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-2">⏰ 期限が近い・切れている（{EXPIRY_WARN_DAYS}日以内）</h2>
              {summary.expiring.length === 0 ? <p className="text-xs text-gray-400">ありません</p> : (
                <ul className="space-y-1.5">
                  {summary.expiring.map((e, i) => (
                    <li key={i} className="text-xs flex items-center gap-2 flex-wrap">
                      <button onClick={() => setFilterWorker(e.w.id)} className="font-bold text-hibi-navy dark:text-blue-300 hover:underline">{e.w.name}</button>
                      <span className="text-gray-600 dark:text-gray-300">{e.label} {e.expiresOn}</span>
                      <ExpiryBadge expiresOn={e.expiresOn} today={today} />
                      {e.source === '人員マスタ' && <span className="text-[10px] text-gray-400">（人員マスタ・カード未登録）</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className={cardCls('p-4')}>
              <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-2">⚠ 人員マスタとの食い違い</h2>
              {summary.mismatches.length === 0 ? <p className="text-xs text-gray-400">ありません</p> : (
                <ul className="space-y-1.5">
                  {summary.mismatches.map((m, i) => (
                    <li key={i} className="text-xs">
                      <button onClick={() => setFilterWorker(m.w.id)} className="font-bold text-hibi-navy dark:text-blue-300 hover:underline mr-1">{m.w.name}</button>
                      <span className="text-red-700 dark:text-red-300">{m.msg}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-gray-400 mt-2">人員マスタ側を直すときは 人員マスタ → 編集 から</p>
            </div>
            <div className={cardCls('p-4')}>
              <h2 className="text-sm font-bold text-hibi-navy dark:text-white mb-2">📭 まだ入っていない書類</h2>
              {summary.missing.length === 0 ? <p className="text-xs text-gray-400">全員そろっています</p> : (
                <ul className="space-y-1.5">
                  {summary.missing.map((m, i) => (
                    <li key={i} className="text-xs">
                      <button onClick={() => setFilterWorker(m.w.id)} className="font-bold text-hibi-navy dark:text-blue-300 hover:underline mr-1">{m.w.name}</button>
                      <span className="text-gray-600 dark:text-gray-300">{m.types.map(t => staffDocTypeDef(t).label).join('・')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── スタッフごと ── */}
          <div className="space-y-3">
            {shown.map(w => {
              const ds = docsOf(w.id)
              const current = ds.filter(d => d.status === 'current')
                .sort((a, b) => STAFF_DOC_TYPES.findIndex(t => t.key === a.type) - STAFF_DOC_TYPES.findIndex(t => t.key === b.type))
              const old = ds.filter(d => d.status === 'old')
              const miss = missingRequiredTypes(ds)
              return (
                <div key={w.id} className={cardCls('p-4')}>
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-hibi-navy dark:text-white">{w.name}</span>
                      <span className="text-xs text-gray-500">{visaLabel(w.visaType ?? w.visa)}</span>
                      {w.retired && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">退職 {w.retired}</span>}
                      <span className="text-xs text-gray-500">人員マスタの在留期限: {w.visaExpiry || '未登録'}</span>
                      {!w.retired && miss.map(t => (
                        <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200">{staffDocTypeDef(t).label} なし</span>
                      ))}
                    </div>
                    {canEdit && storageReady && (
                      <button onClick={() => setUploadFor({ workerId: w.id })} className="text-xs px-3 py-1.5 rounded-lg border border-hibi-navy text-hibi-navy dark:text-blue-300 hover:bg-hibi-navy hover:text-white transition">
                        ＋ 書類を入れる
                      </button>
                    )}
                  </div>
                  {current.length === 0 && <p className="text-xs text-gray-400">書類はまだありません</p>}
                  <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {current.map(d => (
                      <DocRow key={d.id} d={d} today={today} canEdit={canEdit} canDelete={canDelete}
                        onOpen={openFile} onEdit={setEditing} onStatus={setStatus} onDelete={remove} />
                    ))}
                  </div>
                  {old.length > 0 && (
                    <div className="mt-2">
                      <button onClick={() => setShowOld(s => ({ ...s, [w.id]: !s[w.id] }))} className="text-[11px] text-gray-500 hover:text-hibi-navy">
                        {showOld[w.id] ? '▲' : '▼'} 旧版 {old.length}件
                      </button>
                      {showOld[w.id] && (
                        <div className="mt-1 pl-3 border-l-2 border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 opacity-80">
                          {old.map(d => (
                            <DocRow key={d.id} d={d} today={today} canEdit={canEdit} canDelete={canDelete}
                              onOpen={openFile} onEdit={setEditing} onStatus={setStatus} onDelete={remove} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {uploadFor && (
        <UploadModal
          workers={targets.filter(w => !w.retired)}
          initialWorkerId={uploadFor.workerId}
          initialType={uploadFor.type}
          onClose={() => setUploadFor(null)}
          onDone={() => { setUploadFor(null); load() }}
        />
      )}
      {editing && (
        <EditModal d={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

function DocRow({ d, today, canEdit, canDelete, onOpen, onEdit, onStatus, onDelete }: {
  d: StaffDoc; today: string; canEdit: boolean; canDelete: boolean
  onOpen: (d: StaffDoc, i: number) => void
  onEdit: (d: StaffDoc) => void
  onStatus: (d: StaffDoc, s: 'current' | 'old') => void
  onDelete: (d: StaffDoc) => void
}) {
  const def = staffDocTypeDef(d.type)
  return (
    <div className="py-2 flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-bold text-gray-800 dark:text-gray-100">{def.label}</span>
          {d.title && <span className="text-gray-600 dark:text-gray-300">{d.title}</span>}
          {d.status === 'old' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">旧版</span>}
          {d.status === 'current' && <ExpiryBadge expiresOn={d.expiresOn} today={today} />}
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5 flex gap-3 flex-wrap">
          {d.validFrom && <span>開始 {d.validFrom}</span>}
          {d.expiresOn && <span>{def.expiryLabel || '期限'} {d.expiresOn}</span>}
          <span>登録 {d.uploadedAt.slice(0, 10)}</span>
          {d.note && <span className="text-gray-600 dark:text-gray-300">📝 {d.note}</span>}
        </div>
        <div className="flex gap-1.5 flex-wrap mt-1">
          {d.files.map((f, i) => (
            <button key={i} onClick={() => onOpen(d, i)} title={`${f.name}（${fmtSize(f.size)}）`}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-hibi-navy hover:text-hibi-navy max-w-[220px] truncate">
              {f.contentType === 'application/pdf' ? '📄' : '🖼'} {f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] shrink-0">
        {canEdit && <button onClick={() => onEdit(d)} className="text-blue-600 dark:text-blue-400 hover:underline">編集</button>}
        {canEdit && (d.status === 'current'
          ? <button onClick={() => onStatus(d, 'old')} className="text-gray-500 hover:underline">旧版にする</button>
          : <button onClick={() => onStatus(d, 'current')} className="text-gray-500 hover:underline">最新に戻す</button>)}
        {canDelete && <button onClick={() => onDelete(d)} className="text-red-600 hover:underline">削除</button>}
      </div>
    </div>
  )
}

function DocFields({ type, setType, title, setTitle, validFrom, setValidFrom, expiresOn, setExpiresOn, note, setNote }: {
  type: StaffDocType | ''; setType: (t: StaffDocType) => void
  title: string; setTitle: (v: string) => void
  validFrom: string; setValidFrom: (v: string) => void
  expiresOn: string; setExpiresOn: (v: string) => void
  note: string; setNote: (v: string) => void
}) {
  const def = staffDocTypeDef(type)
  const input = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm'
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block sm:col-span-2">
        <span className="text-xs text-gray-500">種類</span>
        <select value={type} onChange={e => setType(e.target.value as StaffDocType)} className={`${input} ${type ? '' : 'border-amber-400'}`}>
          {!type && <option value="">選んでください</option>}
          {STAFF_DOC_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <span className="text-[11px] text-gray-400">{def.hint}</span>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-xs text-gray-500">見出し（任意）</span>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="例: 2026年10月 賃金改定・特定技能2号へ移行" className={input} />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">開始日・交付日（任意）</span>
        <input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} className={input} />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">{def.expiryLabel || '期限'}{def.hasExpiry ? '' : '（任意）'}</span>
        <input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} className={input} />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-xs text-gray-500">メモ（任意）</span>
        <input value={note} onChange={e => setNote(e.target.value)} className={input} />
      </label>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-hibi-navy dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function UploadModal({ workers, initialWorkerId, initialType, onClose, onDone }: {
  workers: W[]; initialWorkerId: number | null; initialType?: StaffDocType
  onClose: () => void; onDone: () => void
}) {
  const [workerId, setWorkerId] = useState<number | null>(initialWorkerId)
  // 既定の種類は置かない（2026-09-28: 既定の「在留カード」のまま契約書が登録された）。ファイル名で見当がつけば自動で選ぶ
  const [type, setType] = useState<StaffDocType | ''>(initialType || '')
  const [title, setTitle] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [note, setNote] = useState('')
  const [makeCurrent, setMakeCurrent] = useState(true)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list)
    const bad = arr.filter(f => !STAFF_DOC_ALLOWED_TYPES.includes(contentTypeOf(f)))
    const big = arr.filter(f => f.size > STAFF_DOC_MAX_FILE_BYTES)
    if (bad.length) { setErr(`入れられない形式です: ${bad.map(f => f.name).join('、')}（PDF・JPEG・PNG・HEIC だけ）`); return }
    if (big.length) { setErr(`25MBを超えています: ${big.map(f => f.name).join('、')}`); return }
    setErr('')
    setFiles(prev => [...prev, ...arr].slice(0, STAFF_DOC_MAX_FILES))
    if (!type) {
      const guess = arr.map(f => inferDocType(f.name)).find(Boolean)
      if (guess) setType(guess)
    }
  }

  const submit = async () => {
    if (!workerId) { setErr('スタッフを選んでください'); return }
    if (!type) { setErr('書類の種類を選んでください'); return }
    if (files.length === 0) { setErr('ファイルを選んでください'); return }
    setErr('')
    try {
      setBusy('準備中...')
      const prep = await postJson<{ docId: string; uploads: { path: string; name: string; contentType: string; size: number; url: string }[] }>(
        '/api/staff-docs',
        { action: 'prepare', workerId, type, files: files.map(f => ({ name: f.name, contentType: contentTypeOf(f), size: f.size })) },
      )
      if (!prep.ok || !prep.data) throw new Error(prep.error || '準備に失敗しました')
      const { docId, uploads } = prep.data
      for (let i = 0; i < uploads.length; i++) {
        setBusy(`アップロード中 ${i + 1}/${uploads.length}...`)
        const res = await fetch(uploads[i].url, { method: 'PUT', headers: { 'Content-Type': uploads[i].contentType }, body: files[i] })
        if (!res.ok) throw new Error(`アップロードに失敗しました: ${files[i].name}（${res.status}）`)
      }
      setBusy('登録中...')
      const commit = await postJson('/api/staff-docs', {
        action: 'commit', docId, workerId, type, title, validFrom, expiresOn, note, makeCurrent,
        files: uploads.map(u => ({ path: u.path, name: u.name, contentType: u.contentType, size: u.size })),
      })
      if (!commit.ok) throw new Error(commit.error || '登録に失敗しました')
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const w = workers.find(x => x.id === workerId)
  return (
    <Modal title="書類を入れる" onClose={busy ? () => {} : onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-gray-500">スタッフ</span>
          <select value={workerId ?? ''} onChange={e => setWorkerId(e.target.value ? Number(e.target.value) : null)}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
            <option value="">選んでください</option>
            {workers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>

        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
          onClick={() => inputRef.current?.click()}
          className={`rounded-lg border-2 border-dashed p-4 text-center cursor-pointer text-sm transition ${dragOver ? 'border-hibi-navy bg-blue-50' : 'border-gray-300 dark:border-gray-600 hover:border-hibi-navy'}`}
        >
          <div className="text-gray-600 dark:text-gray-300">ここにファイルをドラッグ、またはクリックして選ぶ</div>
          <div className="text-[11px] text-gray-400 mt-1">PDF・写真（JPEG/PNG/HEIC）／1件に{STAFF_DOC_MAX_FILES}個まで（在留カードの表と裏は1件にまとめて）／1ファイル25MBまで</div>
          <input ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*" className="hidden"
            onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
        </div>
        {files.length > 0 && (
          <ul className="text-xs space-y-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="truncate">{f.name}（{fmtSize(f.size)}）</span>
                <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-red-500 hover:underline shrink-0">外す</button>
              </li>
            ))}
          </ul>
        )}

        <DocFields type={type} setType={setType} title={title} setTitle={setTitle} validFrom={validFrom} setValidFrom={setValidFrom}
          expiresOn={expiresOn} setExpiresOn={setExpiresOn} note={note} setNote={setNote} />
        {(() => {
          const guesses = Array.from(new Set(files.map(f => inferDocType(f.name)).filter(Boolean))) as StaffDocType[]
          const other = guesses.find(g => type && g !== type)
          return other ? (
            <p className="text-[11px] font-bold text-red-600">⚠ ファイル名は「{staffDocTypeDef(other).label}」のようですが、種類が「{staffDocTypeDef(type).label}」になっています。確認してください</p>
          ) : null
        })()}
        {type && staffDocTypeDef(type).hasExpiry && !expiresOn && (
          <p className="text-[11px] text-amber-700">{staffDocTypeDef(type).expiryLabel}を入れると、期限切れの警告と人員マスタとの食い違いのチェックが効きます</p>
        )}
        {type === 'residence_card' && w && (
          <p className="text-[11px] text-gray-500">人員マスタの在留期限: {w.visaExpiry || '未登録'}（カードの期限と違えば、登録後に「食い違い」に出ます）</p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={makeCurrent} onChange={e => setMakeCurrent(e.target.checked)} />
          これを最新にする（同じ種類の今の最新は「旧版」になります）
        </label>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={!!busy} className="px-4 py-2 rounded-lg text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40">やめる</button>
          <button onClick={submit} disabled={!!busy} className="px-4 py-2 rounded-lg text-sm font-bold bg-hibi-navy text-white hover:bg-hibi-light disabled:opacity-60">
            {busy || '登録する'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function EditModal({ d, onClose, onDone }: { d: StaffDoc; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<StaffDocType>(d.type)
  const [title, setTitle] = useState(d.title || '')
  const [validFrom, setValidFrom] = useState(d.validFrom || '')
  const [expiresOn, setExpiresOn] = useState(d.expiresOn || '')
  const [note, setNote] = useState(d.note || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setBusy(true)
    const r = await postJson('/api/staff-docs', { action: 'update', docId: d.id, type, title, validFrom, expiresOn, note })
    setBusy(false)
    if (!r.ok) { setErr(r.error || '保存できませんでした'); return }
    onDone()
  }
  return (
    <Modal title="書類の情報を直す" onClose={onClose}>
      <div className="space-y-3">
        <DocFields type={type} setType={setType} title={title} setTitle={setTitle} validFrom={validFrom} setValidFrom={setValidFrom}
          expiresOn={expiresOn} setExpiresOn={setExpiresOn} note={note} setNote={setNote} />
        {err && <div className="text-sm text-red-600">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-gray-100 text-gray-700 hover:bg-gray-200">やめる</button>
          <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-bold bg-hibi-navy text-white hover:bg-hibi-light disabled:opacity-60">保存</button>
        </div>
      </div>
    </Modal>
  )
}

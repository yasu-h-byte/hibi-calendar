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
import { isAlreadyRetired } from '@/lib/workers'
import { PageHeader, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton } from '@/components/ui/PageParts'
import WorkerAvatar from '@/components/WorkerAvatar'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
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
  if (st === 'expired') return <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xxs font-bold">期限切れ（{-n}日前）</span>
  if (st === 'soon') return <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xxs font-bold">あと{n}日</span>
  return <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-xxs">あと{n}日</span>
}

type SdFilter = 'all' | 'expiring' | 'mismatch' | 'missing'
const SD_FILTER_LABEL: Record<Exclude<SdFilter, 'all'>, string> = {
  expiring: '期限が近い人', mismatch: '人員マスタと違う人', missing: '書類が足りない人',
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
  // ?worker=0（代表）も有効な id。「0 は無し」と扱わないよう、パラメータの有無で判定する
  const workerParam = search.get('worker')
  const focusWorker = workerParam !== null && workerParam !== '' && Number.isFinite(Number(workerParam)) ? Number(workerParam) : null

  const [workers, setWorkers] = useState<W[]>([])
  const [docs, setDocs] = useState<StaffDoc[]>([])
  const [storageReady, setStorageReady] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<number | null>(focusWorker)
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState<SdFilter>('all')
  const [scope, setScope] = useState<'active' | 'retired'>('active')
  const { photos } = useWorkerPhotos()
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

  // 退職の判定は「今日の時点で退職日を過ぎたか」（lib/workers.ts isAlreadyRetired・2026-10-02 総合点検）。
  //   旧: `!w.retired` だったので、退職「予定」（先の日付）を入れた在籍中の人が退職側へ移り、
  //   在留期限の警告・不足の警告から外れ、書類も入れられなくなっていた
  const retiredNow = useCallback((w: { retired?: string }) => isAlreadyRetired(w.retired, today), [today])
  // 対象: 在籍中のベトナム人 ＋ 書類が既にある人（退職者の書類も見られるように）
  const targets = useMemo(() => {
    const withDocs = new Set(docs.map(d => d.workerId))
    return workers
      .filter(w => (isForeign(w) && !retiredNow(w)) || withDocs.has(w.id))
      .sort((a, b) => Number(retiredNow(a)) - Number(retiredNow(b)) || a.id - b.id)
  }, [workers, docs, retiredNow])

  const docsOf = useCallback((id: number) => docs.filter(d => d.workerId === id), [docs])

  // ── まとめ（期限・食い違い・不足）──
  const summary = useMemo(() => {
    const expiring: { w: W; label: string; expiresOn: string; source: string }[] = []
    const mismatches: { w: W; msg: string }[] = []
    const missing: { w: W; types: StaffDocType[] }[] = []
    for (const w of targets) {
      if (retiredNow(w)) continue
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
  }, [targets, docsOf, today, retiredNow])

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

  // 一覧の絞り込み（2026-10-01 改修）: 今やることのカード → その人たちだけ
  const filterIds: Record<Exclude<SdFilter, 'all'>, Set<number>> = {
    expiring: new Set(summary.expiring.map(e => e.w.id)),
    mismatch: new Set(summary.mismatches.map(m => m.w.id)),
    missing: new Set(summary.missing.map(m => m.w.id)),
  }
  const toggleFilter = (f: Exclude<SdFilter, 'all'>) => { setScope('active'); setListFilter(listFilter === f ? 'all' : f) }
  const q = query.trim().replace(/[\s　]/g, '').toLowerCase()
  const activeTargets = targets.filter(w => !retiredNow(w))
  const retiredTargets = targets.filter(w => retiredNow(w))
  const shown = (scope === 'retired' ? retiredTargets : activeTargets)
    .filter(w => listFilter === 'all' || filterIds[listFilter].has(w.id))
    .filter(w => !q || w.name.replace(/[\s　]/g, '').toLowerCase().includes(q))
  const openWorker = targets.find(w => w.id === openId) || null

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="人・書類"
        title="書類庫"
        sub="在留カード・雇用契約書など。新しい書類を入れると、前のものは「旧版」として残ります"
        actions={canEdit ? (
          <button onClick={() => setUploadFor({ workerId: null })} disabled={!storageReady}
            className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-15 font-bold hover:bg-hibi-light disabled:opacity-40 inline-flex items-center gap-1.5">
            <span className="text-lg leading-none">＋</span>書類を入れる
          </button>
        ) : undefined}
      />

      {!storageReady && (
        <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm px-4 py-3">
          ファイルの置き場に接続できません。書類の一覧は見られますが、登録と閲覧はできません（サーバー設定の確認が必要です）。
        </div>
      )}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm px-4 py-3">{error}</div>}
      {loading && <div className={cardCls('p-8 text-center text-gray-400')}>読み込み中...</div>}

      {!loading && !error && (
        <>
          {/* ① 今やること（旧: まとめの3つの箱） */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <TodoCard icon="alert" tone={summary.expiring.length > 0 ? 'urgent' : 'ok'} title="期限が近い・切れている"
              big={summary.expiring.length > 0 ? `${summary.expiring.length}件` : 'ありません'}
              sub={summary.expiring.length > 0
                ? summary.expiring.slice(0, 2).map(e => {
                    const n = daysUntil(e.expiresOn, today) ?? 0
                    return `${e.w.name} ${e.label}（${n < 0 ? `${-n}日前に切れた` : `残り${n}日`}）`
                  }).join('・') + (summary.expiring.length > 2 ? ` ほか${summary.expiring.length - 2}件` : '')
                : `${EXPIRY_WARN_DAYS}日以内に期限が来る書類はありません`}
              action={summary.expiring.length > 0 ? '見る' : undefined} active={listFilter === 'expiring'}
              onClick={summary.expiring.length > 0 ? () => toggleFilter('expiring') : undefined} />
            <TodoCard icon="alert" tone={summary.mismatches.length > 0 ? 'warn' : 'ok'} title="人員マスタとの食い違い"
              big={summary.mismatches.length > 0 ? `${summary.mismatches.length}件` : 'ありません'}
              sub={summary.mismatches.length > 0 ? `${summary.mismatches[0].w.name}：${summary.mismatches[0].msg}${summary.mismatches.length > 1 ? ` ほか${summary.mismatches.length - 1}件` : ''}` : '書類と人員マスタの内容は合っています'}
              action={summary.mismatches.length > 0 ? '見る' : undefined} active={listFilter === 'mismatch'}
              onClick={summary.mismatches.length > 0 ? () => toggleFilter('mismatch') : undefined} />
            <TodoCard icon="folder" tone={summary.missing.length > 0 ? 'info' : 'ok'} title="まだ入っていない書類"
              big={summary.missing.length > 0 ? `${summary.missing.length}名` : 'ありません'}
              sub={summary.missing.length > 0
                ? `${summary.missing[0].w.name}（${summary.missing[0].types.map(t => staffDocTypeDef(t).label).join('・')}）${summary.missing.length > 1 ? ` ほか${summary.missing.length - 1}名` : ''}`
                : '必要な書類は全員そろっています'}
              action={summary.missing.length > 0 ? '見る' : undefined} active={listFilter === 'missing'}
              onClick={summary.missing.length > 0 ? () => toggleFilter('missing') : undefined} />
          </section>

          {/* ② スタッフごと（1人1行・書類は札で） */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-17 font-bold text-gray-900 dark:text-white">スタッフごとの書類</h2>
              {retiredTargets.length > 0 && (
                <Segment value={scope} onChange={v => { setScope(v); setListFilter('all') }} items={[
                  ['active', `在籍 ${activeTargets.length}`], ['retired', `退職 ${retiredTargets.length}`],
                ]} />
              )}
              {listFilter !== 'all' && (
                <button onClick={() => setListFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-13 font-bold">
                  {SD_FILTER_LABEL[listFilter]}だけ表示中 ×
                </button>
              )}
              <SearchBox value={query} onChange={setQuery} placeholder="名前で探す" />
            </div>
            <div className="hidden lg:grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1.6fr)_80px] gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
              <span>名前</span><span>在留資格</span><span>入っている書類</span><span className="text-right">書類</span>
            </div>
            {shown.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">当てはまる人はいません</div>
            ) : shown.map(w => {
              const ds = docsOf(w.id)
              const current = ds.filter(d => d.status === 'current')
                .sort((a, b) => STAFF_DOC_TYPES.findIndex(t => t.key === a.type) - STAFF_DOC_TYPES.findIndex(t => t.key === b.type))
              const miss = retiredNow(w) ? [] : missingRequiredTypes(ds)
              const mismatch = !retiredNow(w) && masterMismatches(w, ds).length > 0
              return (
                <div key={w.id} role="button" tabIndex={0}
                  onClick={() => setOpenId(w.id)}
                  onKeyDown={e => { if (e.key === 'Enter') setOpenId(w.id) }}
                  className="border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_110px_minmax(0,1.6fr)_80px] gap-x-3 gap-y-1.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
                  <span className="flex items-center gap-2.5 min-w-0">
                    <WorkerAvatar name={w.name} src={photos[String(w.id)]} size={36} />
                    <span className="text-15 font-bold text-gray-900 dark:text-gray-100 truncate">{w.name}</span>
                    {retiredNow(w) ? <Chip tone="gray">退職</Chip> : w.retired ? <Chip tone="amber" title="この日までは在籍中です">退職予定 {w.retired}</Chip> : null}
                  </span>
                  <span><Chip tone="gray">{visaLabel(w.visaType ?? w.visa)}</Chip></span>
                  <span className="flex flex-wrap gap-1.5">
                    {current.map(d => {
                      const st = expiryState(d.expiresOn, today)
                      const n = daysUntil(d.expiresOn, today) ?? 0
                      const label = staffDocTypeDef(d.type).label
                      return st === 'expired' ? <Chip key={d.id} tone="red">{label} 期限切れ</Chip>
                        : st === 'soon' ? <Chip key={d.id} tone={n <= 30 ? 'red' : 'amber'}>{label} 残り{n}日</Chip>
                        : <Chip key={d.id} tone="gray">{label}</Chip>
                    })}
                    {miss.map(t => <Chip key={t} tone="red">{staffDocTypeDef(t).label} なし</Chip>)}
                    {mismatch && <Chip tone="amber">マスタと違う</Chip>}
                    {current.length === 0 && miss.length === 0 && <span className="text-xs text-hibi-sub">書類はまだありません</span>}
                  </span>
                  <span className="lg:text-right text-sm text-hibi-sub dark:text-gray-400 tabular-nums">{ds.length}件</span>
                </div>
              )
            })}
          </section>
        </>
      )}

      {/* 一人の書類（右から開く） */}
      {openWorker && (() => {
        const w = openWorker
        const ds = docsOf(w.id)
        const current = ds.filter(d => d.status === 'current')
          .sort((a, b) => STAFF_DOC_TYPES.findIndex(t => t.key === a.type) - STAFF_DOC_TYPES.findIndex(t => t.key === b.type))
        const old = ds.filter(d => d.status === 'old')
        const miss = retiredNow(w) ? [] : missingRequiredTypes(ds)
        const mism = retiredNow(w) ? [] : masterMismatches(w, ds)
        return (
          <SidePanel label={`${w.name} の書類`} onClose={() => setOpenId(null)}>
            <div className="p-6 space-y-5">
              <div className="flex items-center gap-3">
                <WorkerAvatar name={w.name} src={photos[String(w.id)]} size={52} />
                <div className="flex-1 min-w-0">
                  <h2 className="text-22 font-bold text-gray-900 dark:text-white truncate">{w.name}</h2>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 text-13 text-hibi-sub dark:text-gray-400">
                    <Chip tone="gray">{visaLabel(w.visaType ?? w.visa)}</Chip>
                    {retiredNow(w) ? <Chip tone="gray">退職 {w.retired}</Chip> : w.retired ? <Chip tone="amber" title="この日までは在籍中です">退職予定 {w.retired}</Chip> : null}
                    <span>人員マスタの在留期限 {w.visaExpiry || '未登録'}</span>
                  </div>
                </div>
                <CloseButton onClick={() => setOpenId(null)} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canEdit && storageReady && !retiredNow(w) && (
                  <button onClick={() => setUploadFor({ workerId: w.id })}
                    className="h-10 px-4 rounded-[10px] bg-hibi-navy text-white text-sm font-bold hover:bg-hibi-light inline-flex items-center gap-1.5">
                    <span className="text-base leading-none">＋</span>この人に書類を入れる
                  </button>
                )}
                <a href={`/workers?edit=${w.id}`} className="ml-auto text-13 font-bold text-hibi-navy dark:text-blue-300 hover:underline">人員マスタで開く</a>
              </div>

              {mism.length > 0 && (
                <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 space-y-1">
                  <b>人員マスタとの食い違い</b>
                  {mism.map((m, i) => <div key={i}>{m}</div>)}
                  <a href={`/workers?edit=${w.id}`} className="inline-block text-13 font-bold text-hibi-navy dark:text-blue-300 hover:underline">人員マスタを直す</a>
                </div>
              )}
              {miss.length > 0 && (
                <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-800 dark:text-red-200 flex flex-wrap items-center gap-2">
                  <b>まだ入っていない:</b>
                  {miss.map(t => (
                    canEdit && storageReady
                      ? <button key={t} onClick={() => setUploadFor({ workerId: w.id, type: t })} className="underline font-bold">{staffDocTypeDef(t).label}を入れる</button>
                      : <span key={t}>{staffDocTypeDef(t).label}</span>
                  ))}
                </div>
              )}

              <section className="space-y-2.5">
                {current.length === 0 && <p className="text-sm text-hibi-sub">書類はまだありません</p>}
                {current.map(d => (
                  <div key={d.id} className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-1">
                    <DocRow d={d} today={today} canEdit={canEdit} canDelete={canDelete}
                      onOpen={openFile} onEdit={setEditing} onStatus={setStatus} onDelete={remove} />
                  </div>
                ))}
              </section>

              {old.length > 0 && (
                <section>
                  <button onClick={() => setShowOld(s => ({ ...s, [w.id]: !s[w.id] }))} className="text-13 font-bold text-hibi-sub hover:text-hibi-navy">
                    {showOld[w.id] ? '旧版を隠す' : `旧版 ${old.length}件を見る`}
                  </button>
                  {showOld[w.id] && (
                    <div className="mt-2 space-y-2 opacity-80">
                      {old.map(d => (
                        <div key={d.id} className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-1">
                          <DocRow d={d} today={today} canEdit={canEdit} canDelete={canDelete}
                            onOpen={openFile} onEdit={setEditing} onStatus={setStatus} onDelete={remove} />
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </SidePanel>
        )
      })()}

      {uploadFor && (

        <UploadModal
          workers={targets.filter(w => !retiredNow(w))}
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
          {d.status === 'old' && <span className="text-2xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">旧版</span>}
          {d.status === 'current' && <ExpiryBadge expiresOn={d.expiresOn} today={today} />}
        </div>
        <div className="text-xxs text-gray-500 mt-0.5 flex gap-3 flex-wrap">
          {d.validFrom && <span>開始 {d.validFrom}</span>}
          {d.expiresOn && <span>{def.expiryLabel || '期限'} {d.expiresOn}</span>}
          <span>登録 {d.uploadedAt.slice(0, 10)}</span>
          {d.note && <span className="text-gray-600 dark:text-gray-300">メモ: {d.note}</span>}
        </div>
        <div className="flex gap-1.5 flex-wrap mt-1">
          {d.files.map((f, i) => (
            <button key={i} onClick={() => onOpen(d, i)} title={`${f.name}（${fmtSize(f.size)}）`}
              className="text-xxs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-hibi-navy hover:text-hibi-navy max-w-[220px] truncate">
              {f.contentType === 'application/pdf' ? 'PDF' : '画像'}・{f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xxs shrink-0">
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
        <span className="text-xxs text-gray-400">{def.hint}</span>
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
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
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
          <div className="text-xxs text-gray-400 mt-1">PDF・写真（JPEG/PNG/HEIC）／1件に{STAFF_DOC_MAX_FILES}個まで（在留カードの表と裏は1件にまとめて）／1ファイル25MBまで</div>
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
            <p className="text-xxs font-bold text-red-600">⚠ ファイル名は「{staffDocTypeDef(other).label}」のようですが、種類が「{staffDocTypeDef(type).label}」になっています。確認してください</p>
          ) : null
        })()}
        {type && staffDocTypeDef(type).hasExpiry && !expiresOn && (
          <p className="text-xxs text-amber-700">{staffDocTypeDef(type).expiryLabel}を入れると、期限切れの警告と人員マスタとの食い違いのチェックが効きます</p>
        )}
        {type === 'residence_card' && w && (
          <p className="text-xxs text-gray-500">人員マスタの在留期限: {w.visaExpiry || '未登録'}（カードの期限と違えば、登録後に「食い違い」に出ます）</p>
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

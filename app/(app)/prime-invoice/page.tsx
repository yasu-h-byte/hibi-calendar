'use client'

/**
 * 山岡（一次）への請求書（2026-10-20・代表指示）。仕組みは lib/prime-invoice.ts の冒頭と docs/prime-invoice.md。
 *
 * 大林組の請求書（控え）の PDF と、山岡の控除計算書の PDF を入れると、サーバーが読み取って
 * 工種ごとの請求額（85%・他社借受の切り出し・給与の控除）を計算し、山岡の請求書フォーマットで印刷できる。
 * 画面の型: ① 今月の状況 → ② 1行一覧（現場ごと）→ 行を押すと下に詳細（検算・枚・ファイル・印刷面）。
 * 発行の流れは応援の請求書と同じ（事務が申請 → 事業責任者・管理者が承認して発行）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { confirmDialog, confirmDanger, confirmWithReason } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { shiftYm } from '@/lib/month-nav'
import { can } from '@/lib/permissions'
import { currentYmJst } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Chip, RowButton, FieldError, type ChipTone } from '@/components/ui/PageParts'
import InvoiceNav from '@/components/invoice/InvoiceNav'
import PrimeInvoiceDocument from '@/components/invoice/PrimeInvoiceDocument'
import { Modal, CancelButton, PrimaryButton } from '@/components/ui/Modal'
import {
  PRIME_INVOICE_ALLOWED_TYPES, PRIME_INVOICE_MAX_FILE_BYTES, PRIME_INVOICE_MAX_REQUEST_BYTES, PRIME_INVOICE_MAX_FILES, parseMoneyToken,
  type PrimeInvoiceBundle, type PrimeSheet, type PrimeManDays, type PrimeCheckRow, type PrimeInvoiceStatus,
} from '@/lib/prime-invoice'

type Bundle = PrimeInvoiceBundle & { wageMasked?: boolean }
interface MonthData {
  ym: string
  records: Bundle[]
  companies: { id: string; name: string }[]
  sites: Record<string, { id: string; name: string }[]>
  months: Record<string, number>
  storageReady: boolean
}
interface DetailData {
  record: Bundle
  check: { manDays: PrimeManDays; rows: PrimeCheckRow[]; memoSheetIndex: number; approval: { required: boolean; foremanMissing: number; finalMissing: number; message: string } } | null
  storageReady: boolean
}

const yen = (v: number | null | undefined) => (typeof v === 'number' ? '¥' + Math.round(v).toLocaleString() : '—')
const signedNum = (v: number, unit: string) => (v === 0 ? '±0' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v * 100) / 100).toLocaleString()) + unit
const ymLabelOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月分`
const jpDate = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[1]}/${parseInt(m[2])}/${parseInt(m[3])}` : '—' }
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
const pct = (r: number) => `${Math.round(r * 100)}%`

const STATUS: Record<PrimeInvoiceStatus, { label: string; tone: ChipTone }> = {
  draft: { label: '下書き', tone: 'gray' },
  pending: { label: '承認待ち', tone: 'blue' },
  issued: { label: '発行済み', tone: 'green' },
  void: { label: '取り消し', tone: 'red' },
  rejected: { label: '差し戻し', tone: 'amber' },
  withdrawn: { label: '取り下げ', tone: 'amber' },
}
const FILE_KIND: Record<string, string> = { statement: '大林組の控え', memo: '控除計算書', other: 'その他' }

const BTN = 'h-10 px-4 rounded-[10px] text-sm font-bold transition disabled:opacity-40 inline-flex items-center gap-1.5'
const BTN_MAIN = `${BTN} bg-hibi-navy text-white hover:bg-hibi-light`
const BTN_OK = `${BTN} bg-green-700 text-white hover:bg-green-800`
const BTN_GHOST = `${BTN} border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700`
const BTN_DANGER = `${BTN} bg-white dark:bg-gray-800 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20`
const INPUT = 'w-full h-10 px-3 rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm'

export default function PrimeInvoicePage() {
  const { user, ready } = useAuthPassword()
  const canRequest = can(user, 'invoice.request')
  const canApprove = can(user, 'invoice.approve')
  const [ym, setYm] = useState(() => {
    if (typeof window === 'undefined') return shiftYm(currentYmJst(), -1)
    const q = new URLSearchParams(window.location.search).get('ym')
    // 既定は前月（控えは翌月の中旬に届く）
    return q && /^\d{6}$/.test(q) ? q : shiftYm(currentYmJst(), -1)
  })
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('id')))
  const [data, setData] = useState<MonthData | null>(null)
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<null | { mode: 'new' } | { mode: 'addFiles'; rec: Bundle } | { mode: 'editSheet'; rec: Bundle; idx: number }>(null)

  const latest = useLatestRequest()
  const load = useCallback(async () => {
    if (!ready) return
    setData(null); setErr('')
    const req = latest.begin()
    let res: Response
    try { res = await fetchWithAuth(`/api/prime-invoice?ym=${ym}`, { signal: req.signal }) }
    catch (e) { if (latest.isAbort(e) || !req.isCurrent()) return; setErr('読み込みに失敗しました'); return }
    const j = await res.json().catch(() => null)
    if (!req.isCurrent()) return
    if (!res.ok || !j) { setErr(j?.error || '読み込みに失敗しました'); return }
    setData(j)
  }, [ym, ready, latest])
  useEffect(() => { load() }, [load])

  const latestDetail = useLatestRequest()
  const loadDetail = useCallback(async (id: string) => {
    const req = latestDetail.begin()
    let res: Response
    try { res = await fetchWithAuth(`/api/prime-invoice?id=${encodeURIComponent(id)}`, { signal: req.signal }) }
    catch (e) { if (latestDetail.isAbort(e) || !req.isCurrent()) return; notify.failed('読み込み'); return }
    const j = await res.json().catch(() => null)
    if (!req.isCurrent()) return
    if (!res.ok || !j) { notify.failed('読み込み', j?.error); setOpenId(null); return }
    setDetail(j)
  }, [latestDetail])
  useEffect(() => {
    setDetail(null)
    if (openId && ready) loadDetail(openId)
  }, [openId, ready, loadDetail])

  // URL に月と開いている1件を残す（通知ベルのリンク・リロードで戻れる）
  useEffect(() => {
    if (typeof window === 'undefined') return
    const u = new URL(window.location.href)
    u.searchParams.set('ym', ym)
    if (openId) u.searchParams.set('id', openId); else u.searchParams.delete('id')
    window.history.replaceState(null, '', u.toString())
  }, [ym, openId])

  const refreshAll = useCallback(async (id?: string | null) => {
    await load()
    if (id) await loadDetail(id)
  }, [load, loadDetail])

  const act = async (body: Record<string, unknown>, action: string, okMsg: string) => {
    setBusy(true)
    try {
      const r = await postJson<{ ok: boolean; record?: Bundle }>('/api/prime-invoice', body)
      if (!r.ok) { notify.failed(action, r.error); return false }
      notify.success(okMsg)
      await refreshAll(typeof body.id === 'string' && body.action !== 'delete' ? body.id : null)
      return true
    } finally { setBusy(false) }
  }

  const rec = detail?.record || null
  const check = detail?.check || null
  const approvalBlocked = !!check && check.approval.required && (check.approval.foremanMissing > 0 || check.approval.finalMissing > 0)

  const handleRequest = async () => {
    if (!rec) return
    const ok = await confirmDialog({ title: `${rec.siteName} ${ymLabelOf(rec.ym)} の請求書の発行を申請しますか？`, description: `税込 ${yen(rec.total)}（${rec.sheets.length}枚）。申請した内容は凍結され、事業責任者・管理者が承認すると番号が付いて発行されます。`, confirmLabel: '申請する' })
    if (ok) await act({ action: 'request', id: rec.id }, '申請', '発行を申請しました。承認をお待ちください')
  }
  const handleIssue = async (approve: boolean) => {
    if (!rec) return
    const ok = await confirmDialog({ title: approve ? 'この内容で承認して発行しますか？' : 'この内容で発行しますか？', description: `税込 ${yen(rec.total)}（${rec.sheets.length}枚）。発行すると番号が付き、内容は変えられなくなります（作り直すときは取り消し）。`, confirmLabel: approve ? '承認して発行する' : '発行する' })
    if (ok) await act({ action: approve ? 'approve' : 'issue', id: rec.id }, '発行', '請求書を発行しました')
  }
  const handleReject = async () => {
    if (!rec) return
    const reason = await confirmWithReason({ title: 'この申請を差し戻しますか？', description: '下書きに戻ります。申請した人が直して、もう一度申請できます。', confirmLabel: '差し戻す', reason: { label: '差し戻しの理由', placeholder: '例: 控除計算書が先月のものです', required: true } })
    if (reason !== null) await act({ action: 'reject', id: rec.id, reason }, '差し戻し', '差し戻しました')
  }
  const handleWithdraw = async () => {
    if (!rec) return
    const ok = await confirmDialog({ title: '申請を取り下げますか？', description: '下書きに戻ります。直してからもう一度申請できます。', confirmLabel: '取り下げる' })
    if (ok) await act({ action: 'withdraw', id: rec.id }, '取り下げ', '申請を取り下げました')
  }
  const handleVoid = async () => {
    if (!rec) return
    const reason = await confirmWithReason({ title: `請求書 ${rec.no} を取り消しますか？`, description: '取り消した番号は欠番のまま残ります。作り直すときは、控えをもう一度入れて新しく作ります。', confirmLabel: '取り消す', tone: 'danger', reason: { label: '取り消しの理由', required: false } })
    if (reason !== null) await act({ action: 'void', id: rec.id, reason }, '取り消し', '取り消しました')
  }
  const handleDelete = async () => {
    if (!rec) return
    const ok = await confirmDanger({ title: 'この下書きを削除しますか？', description: '入れた控え・控除計算書のファイルも消えます。元に戻せません。', confirmLabel: '削除する' })
    if (!ok) return
    const done = await act({ action: 'delete', id: rec.id }, '削除', '下書きを削除しました')
    if (done) setOpenId(null)
  }
  const handleRemoveFile = async (f: Bundle['files'][number]) => {
    if (!rec) return
    const ok = await confirmDanger({ title: `${f.name} を外しますか？`, description: '残りのファイルで読み直します。手で直した数字は読み直しで元に戻ります。', confirmLabel: '外す' })
    if (ok) await act({ action: 'removeFile', id: rec.id, path: f.path }, 'ファイルを外す', 'ファイルを外して読み直しました')
  }
  const openFile = async (b: Bundle, i: number) => {
    const res = await fetchWithAuth(`/api/prime-invoice?open=${encodeURIComponent(b.id)}&i=${i}`)
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.url) { notify.failed('ファイルを開く', j?.error); return }
    window.open(j.url, '_blank', 'noopener')
  }

  const records = data?.records || []
  const nPending = records.filter(r => r.status === 'pending').length
  const nDraft = records.filter(r => r.status === 'draft').length
  const nIssued = records.filter(r => r.status === 'issued').length
  const noCompanies = !!data && data.companies.length === 0

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="no-print space-y-5">
        <PageHeader
          group="請求・原価"
          title="山岡への請求書"
          sub="大林組の請求書（控え）のPDFと、山岡の控除計算書のPDFを入れると、85%と控除を計算して山岡のフォーマットで請求書を作ります。金額は控えから読み取るので、手で写しません"
          actions={canRequest && (
            <button onClick={() => setModal({ mode: 'new' })} disabled={!data || noCompanies || !data.storageReady} className={BTN_MAIN}>
              <Icon name="pen" size={15} />控えを入れて作る
            </button>
          )}
        />
        <InvoiceNav current="prime" />

        <div className="flex items-center gap-2">
          <button onClick={() => { setOpenId(null); setYm(shiftYm(ym, -1)) }} className="w-9 h-9 rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" aria-label="前の月">‹</button>
          <div className="text-base font-bold min-w-[8rem] text-center">{ymLabelOf(ym)}</div>
          <button onClick={() => { setOpenId(null); setYm(shiftYm(ym, 1)) }} className="w-9 h-9 rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" aria-label="次の月">›</button>
          {data && Object.keys(data.months).length > 0 && (
            <span className="text-xs text-hibi-sub dark:text-gray-400 ml-2">
              記録のある月: {Object.entries(data.months).sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).map(([m, n]) => (
                <button key={m} onClick={() => { setOpenId(null); setYm(m) }} className={`mr-2 underline-offset-2 ${m === ym ? 'font-bold text-hibi-navy dark:text-white' : 'hover:underline'}`}>{parseInt(m.slice(0, 4))}年{parseInt(m.slice(4, 6))}月（{n}）</button>
              ))}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <TodoCard icon="receipt" tone={nDraft > 0 ? 'info' : 'ok'} title="下書き" big={`${nDraft}件`} sub="控えを入れた。数字を確かめて申請へ" />
          <TodoCard icon="bell" tone={nPending > 0 ? 'warn' : 'ok'} title="承認待ち" big={`${nPending}件`} sub="事業責任者・管理者が承認すると発行" />
          <TodoCard icon="check" tone="ok" title="発行済み" big={`${nIssued}件`} sub="番号が付いた請求書。印刷して送る" />
          <TodoCard icon="yen" tone="info" title="この月の請求額（税込）" big={yen(records.filter(r => r.status === 'issued' || r.status === 'pending' || r.status === 'draft').reduce((s, r) => s + r.total, 0))} sub="下書き・承認待ちも含む見込み" />
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
        {data && !data.storageReady && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">ファイルの置き場に接続できないため、いまは控えを入れられません（サーバー設定）。</p>}
        {noCompanies && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">取引先マスタに「一次」の役割の会社がありません。取引先マスタで山岡建設工業の役割に「一次」を付けてください。</p>}

        {/* ── 一覧 ── */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 overflow-hidden">
          {!data && !err && <p className="text-sm text-gray-400 p-4">読み込み中…</p>}
          {data && records.length === 0 && <p className="text-sm text-gray-400 p-4">この月の請求書はまだありません。「控えを入れて作る」から始めます。</p>}
          {records.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-hibi-bg dark:bg-gray-700/50 text-xs text-hibi-sub dark:text-gray-400">
                <tr><th className="text-left px-4 py-2">現場</th><th className="text-left px-2 py-2">請求先</th><th className="text-left px-2 py-2">状態</th><th className="text-right px-2 py-2">枚</th><th className="text-right px-2 py-2">税抜</th><th className="text-right px-2 py-2">税込</th><th className="text-left px-2 py-2">番号</th><th className="text-left px-2 py-2">注意</th></tr>
              </thead>
              <tbody>
                {records.map(r => {
                  const warn = r.warnings.length + r.sheets.reduce((s, x) => s + x.warnings.length, 0)
                  const on = r.id === openId
                  return (
                    <tr key={r.id} onClick={() => setOpenId(on ? null : r.id)} className={`border-t border-hibi-line dark:border-gray-700 cursor-pointer ${on ? 'bg-hibi-active/60 dark:bg-blue-900/20' : 'hover:bg-hibi-bg dark:hover:bg-gray-700/40'}`}>
                      <td className="px-4 py-2.5 font-bold">{r.siteName}</td>
                      <td className="px-2 py-2.5">{r.companyName}</td>
                      <td className="px-2 py-2.5"><Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip></td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{r.sheets.length}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{yen(r.subtotal)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums font-bold">{yen(r.total)}</td>
                      <td className="px-2 py-2.5 text-xs">{r.no || '—'}</td>
                      <td className="px-2 py-2.5">{warn > 0 ? <Chip tone="amber">{warn}件</Chip> : <Chip tone="green">なし</Chip>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── 詳細 ── */}
        {openId && !detail && <p className="text-sm text-gray-400">読み込み中…</p>}
        {rec && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold">{rec.siteName}　{ymLabelOf(rec.ym)}　<Chip tone={STATUS[rec.status].tone}>{STATUS[rec.status].label}</Chip>{rec.no && <span className="ml-2 text-sm text-hibi-sub">{rec.no}</span>}</h2>
              <span className="text-xs text-hibi-sub dark:text-gray-400">人工の期間 {jpDate(rec.period.from)}〜{jpDate(rec.period.to)}・請求年月日 {jpDate(rec.issueDate || rec.invoiceDate)}</span>
              <button onClick={() => setOpenId(null)} className="ml-auto text-xs text-hibi-sub hover:underline">閉じる</button>
            </div>

            {rec.rejectReason && rec.status === 'draft' && (
              <div className="rounded-xl px-4 py-2.5 text-sm bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800">
                <b>差し戻し・取り下げの記録:</b> {rec.rejectReason}（{jpDate(rec.rejectedAt || '')}）
              </div>
            )}
            {(rec.warnings.length > 0 || rec.sheets.some(s => s.warnings.length > 0)) && (
              <div className="rounded-xl px-4 py-2.5 text-sm bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800 space-y-1">
                <b>読み取りの注意</b>
                <ul className="list-disc pl-5 text-xs space-y-0.5">
                  {rec.warnings.map((w, i) => <li key={`b${i}`}>{w}</li>)}
                  {rec.sheets.flatMap((s, si) => s.warnings.map((w, i) => <li key={`s${si}_${i}`}>{s.tradeName}: {w}</li>))}
                </ul>
              </div>
            )}
            {approvalBlocked && check && (
              <div className="rounded-xl px-4 py-2.5 text-sm bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-800">
                <b>人工の期間の中に、職長承認・最終承認が済んでいない日があるため、まだ発行できません。</b>
                <span className="block text-xs mt-1 whitespace-pre-line">{check.approval.message}</span>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => window.print()} className={BTN_GHOST}><Icon name="download" size={15} />印刷 / PDF保存（{rec.sheets.length}枚）</button>
              {rec.status === 'draft' && canRequest && <button onClick={() => setModal({ mode: 'addFiles', rec })} disabled={busy} className={BTN_GHOST}><Icon name="folder" size={15} />ファイルを足す</button>}
              {rec.status === 'draft' && canRequest && <button onClick={handleRequest} disabled={busy || approvalBlocked} className={BTN_MAIN}>{approvalBlocked && <Icon name="lock" size={14} />}発行を申請（承認へ回す）</button>}
              {rec.status === 'draft' && canApprove && <button onClick={() => handleIssue(false)} disabled={busy || approvalBlocked} className={BTN_OK}>{approvalBlocked && <Icon name="lock" size={14} />}この内容で発行</button>}
              {rec.status === 'pending' && canApprove && <button onClick={() => handleIssue(true)} disabled={busy || approvalBlocked} className={BTN_OK}>{approvalBlocked && <Icon name="lock" size={14} />}承認して発行</button>}
              {rec.status === 'pending' && canApprove && <button onClick={handleReject} disabled={busy} className={BTN_DANGER}>差し戻し</button>}
              {rec.status === 'pending' && canRequest && <button onClick={handleWithdraw} disabled={busy} className={BTN_GHOST}>申請を取り下げ</button>}
              {rec.status === 'issued' && canApprove && <button onClick={handleVoid} disabled={busy} className={BTN_DANGER}>取り消し</button>}
              {rec.status === 'draft' && canRequest && <button onClick={handleDelete} disabled={busy} className={BTN_DANGER}>下書きを削除</button>}
              {rec.status === 'draft' && !canRequest && !canApprove && <span className="text-xs text-hibi-sub">発行の申請は事務、承認は事業責任者・管理者が行います</span>}
            </div>

            {/* 枚の一覧 */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-sm min-w-[860px]">
                <thead className="bg-hibi-bg dark:bg-gray-700/50 text-xs text-hibi-sub dark:text-gray-400">
                  <tr>
                    <th className="text-left px-3 py-2">工種（取引件名）</th>
                    <th className="text-right px-2 py-2">大林組への請求額<br /><span className="font-normal">今回請求金額計（税抜）</span></th>
                    <th className="text-right px-2 py-2">他社借受の切り出し</th>
                    <th className="text-right px-2 py-2">×{pct(rec.ratio)}</th>
                    <th className="text-right px-2 py-2">給与の控除<br /><span className="font-normal">山岡が直接払った分</span></th>
                    <th className="text-right px-2 py-2">請求額（税抜）</th>
                    <th className="text-right px-2 py-2">消費税</th>
                    <th className="text-right px-2 py-2">税込</th>
                    {rec.status === 'draft' && canRequest && <th className="px-2 py-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {rec.sheets.map((s, i) => (
                    <tr key={i} className="border-t border-hibi-line dark:border-gray-700 align-top">
                      <td className="px-3 py-2">
                        <div className="font-bold">{s.tradeName || '（工種なし）'}</div>
                        <div className="text-2xs text-hibi-sub dark:text-gray-400">帳票No {s.docNo || '—'}・{s.source === 'manual' ? <Chip tone="amber">手で直した</Chip> : <Chip tone="gray">PDFから読んだ</Chip>}{s.memoFile && <Chip tone="blue">控除計算書あり</Chip>}</div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{yen(s.gcAmount)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {s.borrowed.length === 0 ? <span className="text-gray-400">—</span> : s.borrowed.map((b, k) => <div key={k}>−{yen(b.amount)} <span className="text-2xs text-hibi-sub">{b.name}{b.companyName ? `（${b.companyName}）` : ''}</span></div>)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{rec.wageMasked ? <span className="text-gray-400" title="給与を見られる人だけに出ます">伏せ</span> : yen(s.ratioAmount)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {s.wageDeductions.length === 0 ? <span className="text-gray-400">—</span> : s.wageDeductions.map((w, k) => <div key={k}>{rec.wageMasked ? <span className="text-gray-400">あり（伏せ）</span> : `−${yen(w.amount)}`} <span className="text-2xs text-hibi-sub">{w.name}</span></div>)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-bold">{yen(s.amount)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{yen(s.tax)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-bold">{yen(s.total)}</td>
                      {rec.status === 'draft' && canRequest && <td className="px-2 py-2"><RowButton onClick={() => setModal({ mode: 'editSheet', rec, idx: i })}>直す</RowButton></td>}
                    </tr>
                  ))}
                  {rec.sheets.length === 0 && <tr><td colSpan={9} className="px-3 py-3 text-sm text-gray-400">控えから枚を読み取れていません。ファイルを確かめるか、「ファイルを足す」で入れ直してください。</td></tr>}
                </tbody>
                <tfoot className="bg-hibi-bg dark:bg-gray-700/50 font-bold">
                  <tr><td className="px-3 py-2">合計（{rec.sheets.length}枚）</td><td className="px-2 py-2 text-right tabular-nums">{yen(rec.sheets.reduce((t, s) => t + s.gcAmount, 0))}</td><td></td><td></td><td></td><td className="px-2 py-2 text-right tabular-nums">{yen(rec.subtotal)}</td><td className="px-2 py-2 text-right tabular-nums">{yen(rec.tax)}</td><td className="px-2 py-2 text-right tabular-nums">{yen(rec.total)}</td>{rec.status === 'draft' && canRequest && <td></td>}</tr>
                </tfoot>
              </table>
            </div>

            {/* 出面との検算 */}
            {check && (
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 p-4 space-y-3">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="font-bold text-sm">出面との検算（{jpDate(check.manDays.period.from)}〜{jpDate(check.manDays.period.to)}・{rec.siteName}）</h3>
                  <span className="text-xs text-hibi-sub dark:text-gray-400">山岡が大林組へ出した人工（控除計算書の内訳）と、DEDURA＋ の出面を並べます。{check.memoSheetIndex < 0 && '控除計算書が無い月は出面の値だけを出します。'}</span>
                </div>
                <table className="text-sm">
                  <thead className="text-xs text-hibi-sub dark:text-gray-400"><tr><th className="text-left pr-6 py-1">項目</th><th className="text-right pr-6 py-1">山岡のメモ</th><th className="text-right pr-6 py-1">出面</th><th className="text-right py-1">差（出面−メモ）</th></tr></thead>
                  <tbody>
                    {check.rows.map(r => {
                      const u = r.unit === '円' ? '円' : r.unit === '人' ? '人' : 'h'
                      const fmt = (v: number) => (r.unit === '円' ? yen(v) : `${Math.round(v * 100) / 100}${u}`)
                      const tone: ChipTone = r.diff === null ? 'gray' : Math.abs(r.diff) < (r.unit === '円' ? 1000 : 0.01) ? 'green' : 'red'
                      return (
                        <tr key={r.label} className="border-t border-hibi-line dark:border-gray-700">
                          <td className="pr-6 py-1.5 font-bold">{r.label}</td>
                          <td className="pr-6 py-1.5 text-right tabular-nums">{r.memo === null ? '—' : fmt(r.memo)}</td>
                          <td className="pr-6 py-1.5 text-right tabular-nums">{fmt(r.dedura)}</td>
                          <td className="py-1.5 text-right"><Chip tone={tone}>{r.diff === null ? 'メモなし' : signedNum(r.diff, r.unit === '円' ? '円' : u)}</Chip></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="text-xs text-hibi-sub dark:text-gray-400">
                  出面側の単価: 鳶 {yen(check.manDays.rates.tobiRate)}・土工 {yen(check.manDays.rates.dokoRate)}（残業 {yen(check.manDays.rates.tobiOtRate)}／{yen(check.manDays.rates.dokoOtRate)} 毎時）。
                  他社から借りた人（吉本の志賀さんなど）は出面に無いので、その分はメモの方が多くなります。出向者（山岡が給与を払う人）は人工に含めています。
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-hibi-navy dark:text-blue-300">人ごとの内訳（{check.manDays.rows.length}人）</summary>
                  <table className="mt-2 text-xs">
                    <thead className="text-hibi-sub"><tr><th className="text-left pr-4">名前</th><th className="text-left pr-4">鳶/土工</th><th className="text-right pr-4">人工</th><th className="text-right pr-4">残業h</th><th></th></tr></thead>
                    <tbody>{check.manDays.rows.map(r => <tr key={r.key}><td className="pr-4 py-0.5">{r.label}</td><td className="pr-4">{r.group}</td><td className="pr-4 text-right tabular-nums">{r.days}</td><td className="pr-4 text-right tabular-nums">{r.otH || ''}</td><td>{r.dispatched && <Chip tone="blue">出向</Chip>}</td></tr>)}</tbody>
                  </table>
                </details>
              </div>
            )}

            {/* ファイル */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-hibi-line dark:border-gray-700 p-4">
              <h3 className="font-bold text-sm mb-2">入れたファイル（{rec.files.length}）</h3>
              <ul className="space-y-1 text-sm">
                {rec.files.map((f, i) => (
                  <li key={f.path} className="flex items-center gap-2 flex-wrap">
                    <Chip tone={f.kind === 'statement' ? 'blue' : f.kind === 'memo' ? 'cyan' : 'gray'}>{FILE_KIND[f.kind] || f.kind}</Chip>
                    <button onClick={() => openFile(rec, i)} className="text-hibi-navy dark:text-blue-300 hover:underline">{f.name}</button>
                    <span className="text-2xs text-hibi-sub">{fmtSize(f.size)}</span>
                    {f.parseError && <Chip tone="red">{f.parseError}</Chip>}
                    {rec.status === 'draft' && canRequest && <button onClick={() => handleRemoveFile(f)} disabled={busy} className="text-2xs text-red-700 dark:text-red-300 hover:underline">外す</button>}
                  </li>
                ))}
                {rec.wageMasked && <li className="text-xs text-hibi-sub">控除計算書（給与の内訳）は、給与を見られる人だけに出ます。</li>}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* ── 印刷面（画面でも見える） ── */}
      {rec && rec.sheets.length > 0 && (
        <div className="space-y-2">
          <div className="no-print text-xs text-hibi-sub dark:text-gray-400">印刷面（A4 横・工種ごとに1枚）。ブラウザの印刷で PDF に保存できます。</div>
          <PrimeInvoiceDocument b={rec} />
        </div>
      )}

      {modal?.mode === 'new' && data && (
        <UploadModal companies={data.companies} sites={data.sites} ym={ym} onClose={() => setModal(null)}
          onDone={async (id) => { setModal(null); await load(); setOpenId(id) }} />
      )}
      {modal?.mode === 'addFiles' && data && (
        <UploadModal companies={data.companies} sites={data.sites} ym={modal.rec.ym} fixed={{ companyId: modal.rec.companyId, siteId: modal.rec.siteId, docId: modal.rec.id, existing: modal.rec.files.length }} onClose={() => setModal(null)}
          onDone={async (id) => { setModal(null); await refreshAll(id) }} />
      )}
      {modal?.mode === 'editSheet' && (
        <EditSheetModal rec={modal.rec} idx={modal.idx} onClose={() => setModal(null)}
          onSaved={async () => { setModal(null); await refreshAll(modal.rec.id) }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// 控えを入れる（新規・ファイルを足す）
// ─────────────────────────────────────────────

function contentTypeOf(f: File): string {
  if (f.type) return f.type
  return f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : ''
}

function UploadModal({ companies, sites, ym, fixed, onClose, onDone }: {
  companies: { id: string; name: string }[]
  sites: Record<string, { id: string; name: string }[]>
  ym: string
  fixed?: { companyId: string; siteId: string; docId: string; existing: number }
  onClose: () => void
  onDone: (id: string) => Promise<void>
}) {
  const [companyId, setCompanyId] = useState(fixed?.companyId || companies[0]?.id || '')
  const [siteId, setSiteId] = useState(fixed?.siteId || sites[companies[0]?.id || '']?.[0]?.id || '')
  const [files, setFiles] = useState<File[]>([])
  const [fieldErr, setFieldErr] = useState('')
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'reading'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const siteList = useMemo(() => sites[companyId] || [], [sites, companyId])
  useEffect(() => { if (!fixed && !siteList.some(s => s.id === siteId)) setSiteId(siteList[0]?.id || '') }, [siteList, siteId, fixed])

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (!PRIME_INVOICE_ALLOWED_TYPES.includes(contentTypeOf(f))) { setFieldErr(`PDF だけ入れられます: ${f.name}`); continue }
      if (f.size > PRIME_INVOICE_MAX_FILE_BYTES) { setFieldErr(`大きすぎます（4MBまで）: ${f.name}`); continue }
      if (!next.some(x => x.name === f.name && x.size === f.size)) next.push(f)
    }
    if ((fixed?.existing || 0) + next.length > PRIME_INVOICE_MAX_FILES) { setFieldErr(`ファイルは1か月につき${PRIME_INVOICE_MAX_FILES}個までです`); return }
    setFiles(next)
  }

  const submit = async () => {
    setFieldErr('')
    if (!companyId) { setFieldErr('請求先の会社を選んでください'); return }
    if (!siteId) { setFieldErr('現場を選んでください'); return }
    if (files.length === 0) { setFieldErr('大林組の控えのPDFを選んでください（控除計算書があれば一緒に）'); return }
    setPhase('uploading')
    // 置き場の CORS は本番の URL からの直接 PUT しか許していない（Preview で止まる）ので、API 経由で置く。
    // 1回の送信は 3.5MB まで（Vercel の API は本文 4.5MB まで）。超えるときは何回かに分け、2回目からは docId を付けて足す
    const batches: File[][] = []
    for (const f of files) {
      const last = batches[batches.length - 1]
      if (last && last.reduce((t, x) => t + x.size, 0) + f.size <= PRIME_INVOICE_MAX_REQUEST_BYTES) last.push(f)
      else batches.push([f])
    }
    let docId: string | undefined = fixed?.docId
    let rec: Bundle | null = null
    try {
      for (let i = 0; i < batches.length; i++) {
        if (i === batches.length - 1) setPhase('reading')
        const fd = new FormData()
        fd.set('action', 'upload'); fd.set('companyId', companyId); fd.set('siteId', siteId); fd.set('ym', ym)
        if (docId) fd.set('docId', docId)
        for (const f of batches[i]) fd.append('files', f, f.name)
        const res = await fetchWithAuth('/api/prime-invoice', { method: 'POST', body: fd })
        const j = await res.json().catch(() => null)
        if (!res.ok || !j?.record) throw new Error(j?.error || `読み取りに失敗しました（${res.status}）`)
        rec = j.record as Bundle
        docId = rec.id
      }
      if (!rec) throw new Error('読み取りに失敗しました')
      const nWarn = rec.warnings.length + rec.sheets.reduce((s, x) => s + x.warnings.length, 0)
      notify.success(`${rec.sheets.length}枚を読み取りました（税込 ${yen(rec.total)}）`, nWarn > 0 ? `注意が${nWarn}件あります。内容を確かめてください` : undefined)
      await onDone(rec.id)
    } catch (e) {
      notify.failed('読み取り', e)
      setPhase('idle')
      // 途中まで入った（2回目以降で失敗した）ときは、できた下書きを開いて残りを足せるようにする
      if (rec && !fixed) await onDone(rec.id)
    }
  }

  const busy = phase !== 'idle'
  return (
    <Modal open onClose={onClose} title={fixed ? 'ファイルを足す' : '大林組の控えを入れて作る'} sub={`${ymLabelOf(ym)}。控えは工種ごとに1枚（5枚前後）。借受職人の控除計算書（山岡のメモ）があれば一緒に入れると、切り出しと給与の控除も自動で計算します`} size="lg" dirty={files.length > 0}
      footer={<><CancelButton onClick={onClose} disabled={busy} /><PrimaryButton onClick={submit} disabled={busy}>{phase === 'uploading' ? 'アップロードしています…' : phase === 'reading' ? 'PDF を読み取っています…' : fixed ? '足して読み直す' : '読み取って下書きを作る'}</PrimaryButton></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-xs font-bold text-hibi-sub">請求先（一次）</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} disabled={!!fixed || busy} className={INPUT}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs font-bold text-hibi-sub">現場</span>
            <select value={siteId} onChange={e => setSiteId(e.target.value)} disabled={!!fixed || busy} className={INPUT}>
              {siteList.length === 0 && <option value="">（この会社に請求する自社現場がありません）</option>}
              {siteList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div
          onDragOver={e => { e.preventDefault() }}
          onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
          className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 p-5 text-center text-sm text-hibi-sub dark:text-gray-400"
        >
          ここに PDF をまとめてドロップ、または
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="ml-1 text-hibi-navy dark:text-blue-300 font-bold hover:underline">ファイルを選ぶ</button>
          <input ref={inputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
          <div className="text-2xs mt-1">大林組の「請求書（控え）」と、山岡の「借受職人給与の控除」。どちらも文字入りの PDF（スキャン画像は読めません）</div>
        </div>
        {files.length > 0 && (
          <ul className="text-sm space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}_${f.size}`} className="flex items-center gap-2">
                <Icon name="doc" size={14} /><span>{f.name}</span><span className="text-2xs text-hibi-sub">{fmtSize(f.size)}</span>
                <button type="button" onClick={() => setFiles(files.filter((_, k) => k !== i))} disabled={busy} className="text-2xs text-red-700 hover:underline">外す</button>
              </li>
            ))}
          </ul>
        )}
        <FieldError>{fieldErr}</FieldError>
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────
// 枚を手で直す（読み取れなかったとき・メモが無いとき）
// ─────────────────────────────────────────────

function EditSheetModal({ rec, idx, onClose, onSaved }: { rec: Bundle; idx: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const s = rec.sheets[idx]
  const [tradeName, setTradeName] = useState(s.tradeName)
  const [gcAmount, setGcAmount] = useState(String(s.gcAmount))
  const [borrowed, setBorrowed] = useState(s.borrowed.map(b => ({ name: b.name, companyName: b.companyName, amount: String(b.amount) })))
  const [wages, setWages] = useState(s.wageDeductions.map(w => ({ name: w.name, amount: String(w.amount) })))
  const [fieldErr, setFieldErr] = useState('')
  const [saving, setSaving] = useState(false)
  const masked = !!rec.wageMasked

  const preview = (() => {
    const gc = parseMoneyToken(gcAmount) ?? 0
    const b = borrowed.reduce((t, x) => t + (parseMoneyToken(x.amount) ?? 0), 0)
    const w = masked ? s.wageDeductions.reduce((t, x) => t + x.amount, 0) : wages.reduce((t, x) => t + (parseMoneyToken(x.amount) ?? 0), 0)
    const base = gc - b
    const ratioAmount = Math.floor(base * rec.ratio + 1e-9)
    const amount = ratioAmount - w
    const tax = Math.floor(amount * rec.taxRate + 1e-9)
    return { base, ratioAmount, amount, tax, total: amount + tax }
  })()

  const save = async () => {
    setFieldErr('')
    if (!tradeName.trim()) { setFieldErr('工種を入れてください'); return }
    if ((parseMoneyToken(gcAmount) ?? 0) <= 0) { setFieldErr('大林組への今回請求金額計を入れてください'); return }
    setSaving(true)
    try {
      const sheets = rec.sheets.map((x, i) => i !== idx ? x : {
        ...x, tradeName: tradeName.trim(), gcAmount: parseMoneyToken(gcAmount),
        borrowed: borrowed.filter(b => b.name.trim() || b.amount.trim()).map(b => ({ name: b.name.trim(), companyName: b.companyName.trim(), amount: parseMoneyToken(b.amount) ?? 0 })),
        wageDeductions: masked ? x.wageDeductions : wages.filter(w => w.name.trim() || w.amount.trim()).map(w => ({ name: w.name.trim(), amount: parseMoneyToken(w.amount) ?? 0 })),
      })
      const r = await postJson('/api/prime-invoice', { action: 'update', id: rec.id, sheets })
      if (!r.ok) { notify.failed('保存', r.error); return }
      notify.success('枚を直しました')
      await onSaved()
    } finally { setSaving(false) }
  }

  const rowCls = 'grid grid-cols-[1fr_1fr_8rem_auto] gap-2 items-center'
  return (
    <Modal open onClose={onClose} title={`${s.tradeName || '枚'} を直す`} sub="PDF から読めなかった数字や、控除計算書が無いときの切り出し・控除をここで入れます。計算（85%・消費税）はサーバーが行います" size="lg" dirty
      footer={<><CancelButton onClick={onClose} disabled={saving} /><PrimaryButton onClick={save} disabled={saving}>{saving ? '保存しています…' : '保存する'}</PrimaryButton></>}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block"><span className="text-xs font-bold text-hibi-sub">工種（取引件名）</span><input value={tradeName} onChange={e => setTradeName(e.target.value)} className={INPUT} /></label>
          <label className="block"><span className="text-xs font-bold text-hibi-sub">大林組への今回請求金額計（税抜）</span><input value={gcAmount} onChange={e => setGcAmount(e.target.value)} inputMode="numeric" className={`${INPUT} text-right tabular-nums`} /></label>
        </div>
        <div>
          <div className="flex items-baseline gap-2"><span className="text-xs font-bold text-hibi-sub">他社から借りた職人の切り出し（{pct(rec.ratio)}を掛ける前に引く）</span><button type="button" onClick={() => setBorrowed([...borrowed, { name: '', companyName: '', amount: '' }])} className="text-xs text-hibi-navy dark:text-blue-300 hover:underline">＋ 行を足す</button></div>
          {borrowed.length === 0 && <div className="text-xs text-gray-400 mt-1">なし</div>}
          {borrowed.map((b, i) => (
            <div key={i} className={`${rowCls} mt-1`}>
              <input placeholder="職人の名前（志賀）" value={b.name} onChange={e => setBorrowed(borrowed.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} className={INPUT} />
              <input placeholder="貸し元の会社（吉本建設）" value={b.companyName} onChange={e => setBorrowed(borrowed.map((x, k) => k === i ? { ...x, companyName: e.target.value } : x))} className={INPUT} />
              <input placeholder="人工 × 常用単価" value={b.amount} onChange={e => setBorrowed(borrowed.map((x, k) => k === i ? { ...x, amount: e.target.value } : x))} inputMode="numeric" className={`${INPUT} text-right tabular-nums`} />
              <button type="button" onClick={() => setBorrowed(borrowed.filter((_, k) => k !== i))} className="text-xs text-red-700 hover:underline">外す</button>
            </div>
          ))}
        </div>
        <div>
          <div className="flex items-baseline gap-2"><span className="text-xs font-bold text-hibi-sub">山岡が直接払った給与の控除（{pct(rec.ratio)}を掛けた後に引く）</span>{!masked && <button type="button" onClick={() => setWages([...wages, { name: '', amount: '' }])} className="text-xs text-hibi-navy dark:text-blue-300 hover:underline">＋ 行を足す</button>}</div>
          {masked && <div className="text-xs text-gray-400 mt-1">給与を見られる人だけが直せます（今の内容のまま保存されます）</div>}
          {!masked && wages.length === 0 && <div className="text-xs text-gray-400 mt-1">なし</div>}
          {!masked && wages.map((w, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-center mt-1">
              <input placeholder="名前（大川）" value={w.name} onChange={e => setWages(wages.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} className={INPUT} />
              <input placeholder="給与の額" value={w.amount} onChange={e => setWages(wages.map((x, k) => k === i ? { ...x, amount: e.target.value } : x))} inputMode="numeric" className={`${INPUT} text-right tabular-nums`} />
              <button type="button" onClick={() => setWages(wages.filter((_, k) => k !== i))} className="text-xs text-red-700 hover:underline">外す</button>
            </div>
          ))}
        </div>
        <div className="rounded-xl bg-hibi-bg dark:bg-gray-700/40 px-4 py-3 text-sm grid grid-cols-2 md:grid-cols-5 gap-2 tabular-nums">
          <div><div className="text-2xs text-hibi-sub">切り出し後</div><b>{yen(preview.base)}</b></div>
          <div><div className="text-2xs text-hibi-sub">×{pct(rec.ratio)}</div><b>{masked ? '伏せ' : yen(preview.ratioAmount)}</b></div>
          <div><div className="text-2xs text-hibi-sub">請求額（税抜）</div><b>{yen(preview.amount)}</b></div>
          <div><div className="text-2xs text-hibi-sub">消費税</div><b>{yen(preview.tax)}</b></div>
          <div><div className="text-2xs text-hibi-sub">税込</div><b>{yen(preview.total)}</b></div>
        </div>
        <FieldError>{fieldErr}</FieldError>
      </div>
    </Modal>
  )
}

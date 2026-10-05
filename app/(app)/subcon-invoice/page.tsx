'use client'

/**
 * 受け取った外注の請求書（2026-10-05・代表指示）。仕組みは lib/subcon-invoice.ts の冒頭を参照。
 *
 * 外注・同業者から紙で届いた請求書（PDF・写真）と合計金額をここに入れ、同じ外注先・同じ月の「出面 × 単価」と並べて差を見る。
 * 入れた請求書は経営コックピットが毎朝読み、AI で明細を読んで帳簿・資金繰りにつなぐ。
 * 画面の型は「紙の請求書の控え」と同じ: ① この月の状況 → ② 1行一覧 → 行を押すと右に見比べの詳細。
 * 2026-10-05: 山岡建設工業など一次から届く支払内訳書も、種類「支払内訳書」でここに入れる（出面とは比べない）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { shiftYm } from '@/lib/month-nav'
import { can } from '@/lib/permissions'
import { currentYmJst } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Chip, SidePanel, CloseButton } from '@/components/ui/PageParts'
import InvoiceNav from '@/components/invoice/InvoiceNav'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import { parsePaperNumber, isBlankNumberInput } from '@/lib/paper-invoice'
import {
  SUBCON_INVOICE_ALLOWED_TYPES, SUBCON_INVOICE_MAX_FILE_BYTES, SUBCON_INVOICE_MAX_FILES,
  docTypeOf, type SubconInvoice, type SubconExpected, type SubconComparison, type SubconDocType,
} from '@/lib/subcon-invoice'

interface MonthData {
  records: SubconInvoice[]
  expected: Record<string, SubconExpected>
  comparisons: Record<string, SubconComparison & { count: number }>
  missing: { companyId: string; companyName: string; workDays: number; cost: number }[]
  companies: { id: string; name: string; kind?: 'subcon' | 'prime' }[]
  storageReady: boolean
}

const yen = (v: number | null | undefined) => (typeof v === 'number' ? '¥' + Math.round(v).toLocaleString() : '—')
const signedYen = (v: number) => (v === 0 ? '±0' : (v > 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString())
const num = (v: number | null | undefined) => (typeof v === 'number' ? String(Math.round(v * 10) / 10) : '—')
const ymLabelOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月分`
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

function contentTypeOf(f: File): string {
  if (f.type) return f.type
  const ext = f.name.toLowerCase().split('.').pop()
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'heic' || ext === 'heif') return 'image/heic'
  return ''
}

function resultChip(cmp: (SubconComparison & { count?: number }) | undefined) {
  if (!cmp) return <Chip tone="gray">—</Chip>
  const suffix = cmp.count && cmp.count >= 2 ? `（${cmp.count}枚の合算）` : ''
  if (cmp.result === 'noWork') return <Chip tone="amber">出面に人工なし</Chip>
  if (cmp.result === 'match') return <Chip tone="green">出面と一致{suffix}</Chip>
  if (cmp.result === 'close') return <Chip tone="green">ほぼ一致 {signedYen(cmp.diff)}{suffix}</Chip>
  return <Chip tone="red">差 {signedYen(cmp.diff)}{suffix}</Chip>
}

export default function SubconInvoicePage() {
  const { user, ready } = useAuthPassword()
  const canEdit = can(user, 'invoice.subcon')
  const canDelete = can(user, 'invoice.approve')
  const [ym, setYm] = useState(() => {
    if (typeof window === 'undefined') return shiftYm(currentYmJst(), -1)
    const q = new URLSearchParams(window.location.search).get('ym')
    // 既定は前月（請求書は月が明けてから届くので）
    return q && /^\d{6}$/.test(q) ? q : shiftYm(currentYmJst(), -1)
  })
  const [data, setData] = useState<MonthData | null>(null)
  const [allMonths, setAllMonths] = useState<{ ym: string; n: number }[]>([])
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [modal, setModal] = useState<null | { mode: 'add'; companyId?: string } | { mode: 'edit'; rec: SubconInvoice }>(null)

  const latest = useLatestRequest()
  const load = useCallback(async () => {
    if (!ready) return
    setData(null); setErr('')
    const req = latest.begin()
    let res: Response, allRes: Response
    try {
      ;[res, allRes] = await Promise.all([
        fetchWithAuth(`/api/subcon-invoice?ym=${ym}`, { signal: req.signal }),
        fetchWithAuth('/api/subcon-invoice?all=1', { signal: req.signal }),
      ])
    } catch (e) {
      if (latest.isAbort(e) || !req.isCurrent()) return
      setErr('読み込みに失敗しました'); return
    }
    const j = await res.json().catch(() => null)
    if (!req.isCurrent()) return
    if (!res.ok || !j) { setErr(j?.error || '読み込みに失敗しました'); return }
    setData(j)
    if (allRes.ok) {
      const a = await allRes.json()
      const counts = new Map<string, number>()
      for (const r of (a.records || []) as SubconInvoice[]) counts.set(r.ym, (counts.get(r.ym) || 0) + 1)
      setAllMonths([...counts.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([k, n]) => ({ ym: k, n })))
    }
  }, [ready, ym, latest])
  useEffect(() => { load() }, [load])
  useEffect(() => { setOpenId(null) }, [ym])

  const records = data?.records || []
  const cmpOf = (r: SubconInvoice) => data?.comparisons[r.companyId]
  const differs = records.filter(r => docTypeOf(r) === 'invoice' && cmpOf(r)?.result === 'diff')
  const invoiceCount = records.filter(r => docTypeOf(r) === 'invoice').length
  const remittanceCount = records.length - invoiceCount
  const missing = data?.missing || []
  const open = records.find(r => r.id === openId) || null
  const canAdd = canEdit && !!data?.storageReady

  const openFile = async (r: SubconInvoice, i: number) => {
    // ポップアップブロックを避けるため、先にタブを開いてから URL を入れる
    const win = window.open('', '_blank')
    try {
      const res = await fetchWithAuth(`/api/subcon-invoice?open=${encodeURIComponent(r.id)}&i=${i}`)
      const j = await res.json()
      if (!res.ok || !j.url) throw new Error(j.error || 'ファイルを開けませんでした')
      if (win) win.location.href = j.url
      else window.location.href = j.url
    } catch (e) {
      win?.close()
      notify.failed('ファイルを表示', e)
    }
  }

  const remove = async (r: SubconInvoice) => {
    if (!(await confirmDanger({
      title: `${r.companyName} ${ymLabelOf(r.ym)}の請求書を削除しますか？`,
      description: '入れたファイルも消えます。経営コックピットに取り込み済みの分は、経営コックピット側には残ります。',
      confirmLabel: '削除する',
    }))) return
    const res = await postJson('/api/subcon-invoice', { action: 'delete', docId: r.id })
    if (!res.ok) { notify.failed('削除', res.error || 'サーバが受け付けませんでした'); return }
    setOpenId(null)
    load()
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="請求・原価"
        title="受け取った請求書"
        sub="外注・同業者から届いた請求書と、山岡建設工業などから届く支払内訳書（紙はスキャンか写真）を入れます。請求書は出面 × 単価と見比べます。入れたものは経営コックピットが毎朝読み、支払・入金の予定と帳簿の照合に使います"
        actions={
          <>
            <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
              <button type="button" aria-label="前の月" onClick={() => setYm(shiftYm(ym, -1))}
                className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px]">
                <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
              </button>
              <span className="px-1.5 text-[0.9375rem] font-bold tabular-nums">{ymLabelOf(ym)}</span>
              <button type="button" aria-label="次の月" onClick={() => setYm(shiftYm(ym, 1))}
                className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px]">
                <Icon name="chevronRight" size={18} strokeWidth={2.2} />
              </button>
            </div>
            {canEdit && (
              <button type="button" onClick={() => setModal({ mode: 'add' })} disabled={!data?.storageReady}
                className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[0.9375rem] font-bold hover:bg-hibi-light disabled:opacity-40">
                請求書を入れる
              </button>
            )}
          </>
        }
      />
      <InvoiceNav current="received" />

      {err && <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{err}</div>}
      {!data && !err && <div className="text-center py-12 text-gray-400">読み込み中...</div>}
      {data && !data.storageReady && (
        <div className="bg-amber-50 text-amber-800 rounded-xl p-4 text-sm">ファイルの置き場に接続できないため、いまは請求書を入れられません（サーバー設定を確認してください）</div>
      )}

      {data && (
        <>
          {/* ① この月の状況 */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TodoCard icon="doc" tone={records.length > 0 ? 'info' : 'ok'} title="入れた請求書"
              big={records.length > 0 ? `${invoiceCount}件` : 'まだありません'}
              sub={records.length > 0 ? `${ymLabelOf(ym)}に届いた請求書${remittanceCount > 0 ? `（ほかに支払内訳書 ${remittanceCount}件）` : ''}` : `${ymLabelOf(ym)}に届いた請求書・支払内訳書を入れてください`}
              action={canAdd ? '入れる' : undefined}
              onClick={canAdd ? () => setModal({ mode: 'add' }) : undefined} />
            <TodoCard icon="clock" tone={missing.length > 0 ? 'warn' : 'ok'} title="まだ届いていない"
              big={missing.length > 0 ? `${missing.length}社` : 'ありません'}
              sub={missing.length > 0 ? `出面では人工があるのに請求書が無い外注先（${missing.slice(0, 3).map(m => m.companyName).join('・')}${missing.length > 3 ? ' ほか' : ''}）` : '出面で人工がある外注先は全部そろっています'} />
            <TodoCard icon="alert" tone={differs.length > 0 ? 'warn' : 'ok'} title="出面と差がある"
              big={differs.length > 0 ? `${differs.length}件` : 'ありません'}
              sub={differs.length > 0 ? '1万円かつ3%を超える差。行を押すと現場ごとの人工・単価を右に出します' : '残業・交通費・端数の範囲（1万円か3%以内）はほぼ一致にしています'}
              onClick={differs.length > 0 ? () => setOpenId(differs[0].id) : undefined}
              action={differs.length > 0 ? '開く' : undefined} />
          </section>

          {/* ② 1行一覧 */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">{ymLabelOf(ym)}の請求書</h2>
              <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">行を押すと、出面との見比べが右に開きます</span>
            </div>
            <div className="hidden lg:grid grid-cols-[minmax(0,1fr)_140px_140px_200px_150px] gap-3.5 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
              <span>外注先</span><span className="text-right">請求書（税込）</span><span className="text-right">出面 × 単価（税抜）</span><span>見比べ</span><span>入れた人</span>
            </div>
            {records.length === 0 && missing.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この月に入れた請求書はありません</div>
            ) : (
              <>
                {records.map(r => (
                  <div key={r.id} role="button" tabIndex={0}
                    onClick={() => setOpenId(r.id)}
                    onKeyDown={e => { if (e.key === 'Enter') setOpenId(r.id) }}
                    className="border-t border-hibi-line dark:border-gray-700 first-of-type:border-t-0 px-5 py-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_140px_140px_200px_150px] gap-2 lg:gap-3.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
                    <span className="min-w-0">
                      <span className="block text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{r.companyName}</span>
                      {docTypeOf(r) === 'remittance' && <span className="block text-xs text-hibi-sub dark:text-gray-400">支払内訳書</span>}
                      {r.no && <span className="block text-xs text-hibi-sub dark:text-gray-400">{r.no}</span>}
                    </span>
                    <span className="lg:text-right text-[1.0625rem] font-bold tabular-nums text-gray-900 dark:text-white">
                      <span className="lg:hidden mr-2 text-xs font-normal text-hibi-sub dark:text-gray-400">{docTypeOf(r) === 'remittance' ? '振込額' : '請求書'}</span>{docTypeOf(r) === 'remittance' && !r.total ? '—' : yen(r.total)}
                    </span>
                    <span className="lg:text-right text-[0.9375rem] tabular-nums text-gray-700 dark:text-gray-300">
                      <span className="lg:hidden mr-2 text-xs text-hibi-sub dark:text-gray-400">出面 × 単価</span>{docTypeOf(r) === 'invoice' && data.expected[r.companyId] ? yen(data.expected[r.companyId].cost) : '—'}
                    </span>
                    <span>{docTypeOf(r) === 'remittance' ? <Chip tone="blue">支払内訳書（帳簿と照合は経営コックピット）</Chip> : resultChip(cmpOf(r))}</span>
                    <span className="text-xs text-hibi-sub dark:text-gray-400">{r.uploadedByName || '—'}・{r.files.length}ファイル</span>
                  </div>
                ))}
                {missing.map(m => (
                  <div key={m.companyId} className="border-t border-hibi-line dark:border-gray-700 first-of-type:border-t-0 px-5 py-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_140px_140px_200px_150px] gap-2 lg:gap-3.5 items-center bg-amber-50/40 dark:bg-amber-900/10">
                    <span className="block text-[0.9375rem] font-bold text-gray-700 dark:text-gray-300 truncate">{m.companyName}</span>
                    <span className="lg:text-right text-sm text-hibi-sub dark:text-gray-400">—</span>
                    <span className="lg:text-right text-[0.9375rem] tabular-nums text-gray-700 dark:text-gray-300">
                      <span className="lg:hidden mr-2 text-xs text-hibi-sub dark:text-gray-400">出面 × 単価</span>{yen(m.cost)}
                    </span>
                    <span><Chip tone="amber">まだ届いていない（{num(m.workDays)}人工）</Chip></span>
                    <span>
                      {canAdd && (
                        <button type="button" onClick={() => setModal({ mode: 'add', companyId: m.companyId })}
                          className="h-8 px-3 rounded-[9px] border border-gray-300 dark:border-gray-600 text-[0.8125rem] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                          入れる
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
          </section>

          {allMonths.length > 0 && (
            <section className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-hibi-sub dark:text-gray-400">これまでに入れた月:</span>
              {allMonths.map(m => (
                <button key={m.ym} type="button" onClick={() => setYm(m.ym)}
                  className={`h-8 px-3 rounded-full border text-[0.8125rem] font-bold ${m.ym === ym ? 'bg-hibi-navy text-white border-hibi-navy' : 'border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'}`}>
                  {ymLabelOf(m.ym)}（{m.n}）
                </button>
              ))}
            </section>
          )}

          <p className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed">
            出面 × 単価は税抜です。請求書の税抜小計を入れていないときは、税込 ÷ 1.1 で見比べます。
            紙の請求書は、スキャン・写真を入れたあとも捨てずに保管してください。
          </p>
        </>
      )}

      {open && data && (
        <SidePanel label={`${open.companyName} の見比べ`} onClose={() => setOpenId(null)} width="max-w-[760px]">
          <Detail rec={open} sameCompany={records.filter(r => r.companyId === open.companyId && docTypeOf(r) === docTypeOf(open))} exp={data.expected[open.companyId]} cmp={cmpOf(open)}
            onClose={() => setOpenId(null)} onOpenFile={i => openFile(open, i)}
            onEdit={canEdit ? () => setModal({ mode: 'edit', rec: open }) : undefined}
            onDelete={canDelete ? () => remove(open) : undefined} />
        </SidePanel>
      )}

      {modal && data && (
        <SubconInvoiceModal
          mode={modal.mode} rec={modal.mode === 'edit' ? modal.rec : undefined}
          initialCompanyId={modal.mode === 'add' ? modal.companyId : undefined}
          ym={ym} companies={data.companies}
          onClose={() => setModal(null)}
          onDone={(newYm) => { setModal(null); if (newYm && newYm !== ym) setYm(newYm); else load() }}
        />
      )}
    </div>
  )
}

function Detail({ rec, sameCompany, exp, cmp, onClose, onOpenFile, onEdit, onDelete }: {
  rec: SubconInvoice; sameCompany: SubconInvoice[]; exp?: SubconExpected; cmp?: SubconComparison & { count: number }
  onClose: () => void; onOpenFile: (i: number) => void; onEdit?: () => void; onDelete?: () => void
}) {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white">{rec.companyName}</h2>
          <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
            {ymLabelOf(rec.ym)}{rec.no && ` ／ ${rec.no}`}{rec.issueDate && ` ／ 発行日 ${rec.issueDate}`}{rec.dueDate && ` ／ 支払期日 ${rec.dueDate}`}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">{resultChip(cmp)}</div>
          {cmp && cmp.count >= 2 && (
            <p className="mt-2 text-xs text-hibi-sub dark:text-gray-400">
              この外注先はこの月に{cmp.count}枚入っているので、{cmp.count}枚の合算で見比べています（この1枚は税込 {yen(rec.total)}）。
            </p>
          )}
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <section className="space-y-2">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">ファイル</h3>
        <div className="flex flex-wrap gap-2">
          {rec.files.map((f, i) => (
            <button key={i} type="button" onClick={() => onOpenFile(i)}
              className="h-9 px-3 rounded-[9px] border border-gray-300 dark:border-gray-600 text-[0.8125rem] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 max-w-full truncate">
              {i === 0 ? '請求書' : '添付'}: {f.name}（{fmtSize(f.size)}）
            </button>
          ))}
        </div>
        <p className="text-xs text-hibi-sub dark:text-gray-400">入れた人: {rec.uploadedByName || '—'}（{rec.uploadedAt?.slice(0, 10)}）</p>
      </section>

      {docTypeOf(rec) === 'remittance' && (
        <p className="text-sm text-gray-700 dark:text-gray-300">支払内訳書です。月ごとの請求額・差し引き・振込額は、経営コックピットが AI で読んで帳簿の入金と照らします。</p>
      )}

      {cmp && docTypeOf(rec) === 'invoice' && (
        <section className="space-y-2">
          <h3 className="text-base font-bold text-gray-900 dark:text-white">請求書と出面の見比べ（税抜）</h3>
          <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-sm tabular-nums">
            {[
              { label: `請求書${cmp.count >= 2 ? `（${cmp.count}枚の合算）` : ''}${cmp.exTaxEstimated ? '（税込 ÷ 1.1）' : ''}`, value: yen(cmp.invoiceExTax) },
              { label: '出面 × 単価', value: yen(cmp.expected) },
            ].map(r => (
              <div key={r.label} className="flex justify-between gap-3 px-3 py-2 border-t first:border-t-0 border-hibi-line dark:border-gray-700">
                <span>{r.label}</span><span className="font-bold">{r.value}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 px-3 py-2 border-t border-hibi-line dark:border-gray-700">
              <span className="font-bold">差（請求書 − 出面）</span>
              <span className={`font-bold ${cmp.result === 'diff' ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}>{signedYen(cmp.diff)}</span>
            </div>
          </div>
          {sameCompany.length >= 2 && (
            <p className="text-xs text-hibi-sub dark:text-gray-400">この月の{rec.companyName}の請求書: {sameCompany.map(r => yen(r.total)).join('・')}（税込）</p>
          )}
        </section>
      )}

      {docTypeOf(rec) === 'invoice' && <section className="space-y-2">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">出面（現場ごと）</h3>
        <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-[0.8125rem]">
          {!exp || exp.sites.length === 0 ? (
            <div className="px-3 py-4 text-center text-hibi-sub dark:text-gray-400">この月、この外注先の出面はありません</div>
          ) : exp.sites.map(s => (
            <div key={s.siteId} className="px-3 py-2 border-t first:border-t-0 border-hibi-line dark:border-gray-700">
              <div className="truncate font-bold">{s.siteName}</div>
              <div className="flex flex-wrap items-baseline gap-x-3 tabular-nums text-gray-700 dark:text-gray-300">
                <span>{num(s.workDays)}人工 × {yen(s.rate)}</span>
                {s.otCount > 0 && <span>残業 {num(s.otCount)} × {yen(s.otRate)}</span>}
                <span className="ml-auto font-bold text-gray-900 dark:text-white">{yen(s.cost)}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-hibi-sub dark:text-gray-400">明細ごとの細かい見比べ（人工・単価）は、経営コックピットが AI で請求書を読んだあとに経営コックピットの「請求書の取り込み」に出ます</p>
      </section>}

      {rec.note && (
        <section className="space-y-1">
          <h3 className="text-base font-bold text-gray-900 dark:text-white">メモ</h3>
          <p className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">{rec.note}</p>
        </section>
      )}

      {(onEdit || onDelete) && (
        <div className="flex gap-2">
          {onEdit && <button type="button" onClick={onEdit} className="h-10 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">金額・日付を直す</button>}
          {onDelete && <button type="button" onClick={onDelete} className="h-10 px-4 rounded-[10px] text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">削除</button>}
        </div>
      )}
    </div>
  )
}

const toNum = (s: string) => parsePaperNumber(s)

function SubconInvoiceModal({ mode, rec, initialCompanyId, ym, companies, onClose, onDone }: {
  mode: 'add' | 'edit'; rec?: SubconInvoice; initialCompanyId?: string; ym: string; companies: { id: string; name: string; kind?: 'subcon' | 'prime' }[]
  onClose: () => void; onDone: (ym?: string) => void
}) {
  const [docType, setDocType] = useState<SubconDocType>(rec ? docTypeOf(rec) : 'invoice')
  const remit = docType === 'remittance'
  const [companyId, setCompanyId] = useState(rec?.companyId || initialCompanyId || '')
  const [targetYm, setTargetYm] = useState(rec?.ym || ym)
  const [no, setNo] = useState(rec?.no || '')
  const [issueDate, setIssueDate] = useState(rec?.issueDate || '')
  const [dueDate, setDueDate] = useState(rec?.dueDate || '')
  const [subtotal, setSubtotal] = useState(rec?.subtotal != null ? String(rec.subtotal) : '')
  const [tax, setTax] = useState(rec?.tax != null ? String(rec.tax) : '')
  const [total, setTotal] = useState(rec?.total != null ? String(rec.total) : '')
  const [note, setNote] = useState(rec?.note || '')
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const snapshot = () => JSON.stringify({ docType, companyId, targetYm, no, issueDate, dueDate, subtotal, tax, total, note })
  const [base] = useState(snapshot)
  const dirty = files.length > 0 || snapshot() !== base

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list)
    const heic = arr.filter(f => contentTypeOf(f) === 'image/heic')
    const bad = arr.filter(f => !SUBCON_INVOICE_ALLOWED_TYPES.includes(contentTypeOf(f)) && contentTypeOf(f) !== 'image/heic')
    const big = arr.filter(f => f.size > SUBCON_INVOICE_MAX_FILE_BYTES)
    if (heic.length) { setErr(`iPhone の写真（HEIC）は入れられません: ${heic.map(f => f.name).join('、')}。「写真を選ぶ」から選ぶか、JPEG・PDF にしてください`); return }
    if (bad.length) { setErr(`入れられない形式です: ${bad.map(f => f.name).join('、')}（PDF・JPEG・PNG だけ）`); return }
    if (big.length) { setErr(`20MBを超えています: ${big.map(f => f.name).join('、')}`); return }
    setErr('')
    setFiles(prev => [...prev, ...arr].slice(0, SUBCON_INVOICE_MAX_FILES))
  }

  const submit = async () => {
    if (!companyId) { setErr(remit ? '支払元の会社を選んでください' : '請求元の外注先を選んでください'); return null }
    if (!remit && !(toNum(total) > 0)) { setErr('税込合計を入れてください（数字で）'); return null }
    if (remit && !isBlankNumberInput(total) && Number.isNaN(toNum(total))) { setErr('振込額の数字が読めません'); return null }
    for (const [label, v] of [['税抜小計', subtotal], ['消費税', tax]] as const) {
      if (!isBlankNumberInput(v) && Number.isNaN(toNum(v))) { setErr(`${label}の数字が読めません`); return null }
    }
    if (mode === 'add' && files.length === 0) { setErr('請求書のファイル（PDF・写真）を選んでください'); return null }
    setErr('')
    const fields = { docType, companyId, ym: targetYm, total, subtotal: remit ? '' : subtotal, tax: remit ? '' : tax, no, issueDate, dueDate: remit ? '' : dueDate, note }
    let uploadedDocId: string | null = null
    try {
      if (mode === 'edit' && rec) {
        setBusy('保存しています')
        const r = await postJson('/api/subcon-invoice', { action: 'update', docId: rec.id, ...fields })
        if (!r.ok) throw new Error(r.error || '保存に失敗しました')
        onDone(targetYm)
        return
      }
      setBusy('準備しています')
      const prep = await postJson<{ docId: string; uploads: { path: string; name: string; contentType: string; size: number; url: string }[] }>(
        '/api/subcon-invoice',
        { action: 'prepare', ...fields, files: files.map(f => ({ name: f.name, contentType: contentTypeOf(f), size: f.size })) },
      )
      if (!prep.ok || !prep.data) throw new Error(prep.error || '準備に失敗しました')
      const { docId, uploads } = prep.data
      uploadedDocId = docId
      for (let i = 0; i < uploads.length; i++) {
        setBusy(`アップロードしています（${i + 1}/${uploads.length}）`)
        const res = await fetch(uploads[i].url, { method: 'PUT', headers: { 'Content-Type': uploads[i].contentType }, body: files[i] })
        if (!res.ok) throw new Error(`アップロードに失敗しました: ${files[i].name}（${res.status}）`)
      }
      setBusy('登録しています')
      const commit = await postJson('/api/subcon-invoice', {
        action: 'commit', docId, ...fields,
        files: uploads.map(u => ({ path: u.path, name: u.name, contentType: u.contentType, size: u.size })),
      })
      if (!commit.ok) throw new Error(commit.error || '登録に失敗しました')
      uploadedDocId = null
      onDone(targetYm)
    } catch (e) {
      // 登録できなかったら、置いたファイルを片付ける（記録がある docId はサーバが消さない）
      if (uploadedDocId) await postJson('/api/subcon-invoice', { action: 'discard', docId: uploadedDocId }).catch(() => null)
      throw e
    } finally {
      setBusy('')
    }
  }

  const inputCls = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm'
  const ymValue = `${targetYm.slice(0, 4)}-${targetYm.slice(4, 6)}`

  return (
    <Modal
      open
      title={mode === 'add' ? '受け取った請求書・支払内訳書を入れる' : '金額・日付を直す'}
      onClose={busy ? () => {} : onClose}
      closeOnEsc={!busy}
      closeOnOverlay={false}
      dirty={dirty}
      size="xl"
      footer={<>
        <CancelButton onClick={onClose} disabled={!!busy} />
        <SaveButton action={mode === 'add' ? '登録' : '保存'} label={mode === 'add' ? '入れる' : undefined} savingLabel={busy || undefined} onSave={submit} />
      </>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="種類">
          {([['invoice', '外注・同業者からの請求書'], ['remittance', '山岡建設工業などからの支払内訳書']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={docType === k}
              onClick={() => { setDocType(k); setCompanyId('') }}
              className={`h-9 px-3 rounded-[9px] border text-[0.8125rem] font-bold ${docType === k ? 'bg-hibi-navy text-white border-hibi-navy' : 'border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-gray-500">{remit ? '支払元の会社' : '請求元の外注先'} <span className="text-red-600">必須</span></span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} className={inputCls}>
              <option value="">選んでください</option>
              {companies.filter(c => remit ? c.kind === 'prime' : c.kind !== 'prime').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{remit ? '支払の月（何か月分載っていても1件で）' : '対象月（締めの月）'} <span className="text-red-600">必須</span></span>
            <input type="month" value={ymValue} onChange={e => { const v = e.target.value.replace('-', ''); if (/^\d{6}$/.test(v)) setTargetYm(v) }} className={inputCls} />
          </label>
        </div>

        {mode === 'add' && (
          <div>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
              onClick={() => inputRef.current?.click()}
              className={`rounded-lg border-2 border-dashed p-4 text-center cursor-pointer text-sm transition ${dragOver ? 'border-hibi-navy bg-blue-50 dark:bg-blue-900/20' : 'border-gray-300 dark:border-gray-600 hover:border-hibi-navy'}`}>
              <div className="text-gray-600 dark:text-gray-300">請求書のファイルをここにドラッグ、またはクリックして選ぶ <span className="text-red-600 text-xs">必須</span></div>
              <div className="text-2xs text-gray-400 mt-1">1つ目に請求書（金額が載っているもの）。出面の明細などの添付は2つ目以降に。PDF・JPEG・PNG／{SUBCON_INVOICE_MAX_FILES}個まで／1ファイル20MBまで</div>
              <input ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" className="hidden"
                onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
            </div>
            {files.length > 0 && (
              <ul className="text-xs space-y-1 mt-2">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate"><span className="font-bold">{i === 0 ? '請求書' : '添付'}</span> {f.name}（{fmtSize(f.size)}）</span>
                    <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-red-500 hover:underline shrink-0">外す</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {remit ? (
          <label className="block sm:w-1/3">
            <span className="text-xs text-gray-500">振込額（任意）</span>
            <input inputMode="numeric" value={total} onChange={e => setTotal(e.target.value)} className={`${inputCls} tabular-nums`} />
          </label>
        ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="block col-span-2 sm:col-span-1">
            <span className="text-xs text-gray-500">税込合計 <span className="text-red-600">必須</span></span>
            <input inputMode="numeric" value={total} onChange={e => setTotal(e.target.value)} placeholder="1,234,567" className={`${inputCls} tabular-nums`} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">税抜小計</span>
            <input inputMode="numeric" value={subtotal} onChange={e => setSubtotal(e.target.value)} className={`${inputCls} tabular-nums`} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">消費税</span>
            <input inputMode="numeric" value={tax} onChange={e => setTax(e.target.value)} className={`${inputCls} tabular-nums`} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">請求書番号</span>
            <input value={no} onChange={e => setNo(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">発行日</span>
            <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">支払期日</span>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} />
          </label>
        </div>
        )}

        <label className="block">
          <span className="text-xs text-gray-500">メモ（いつもと違う点・確認したいことなど）</span>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className={inputCls} />
        </label>

        <p className="text-xs text-hibi-sub dark:text-gray-400">{remit ? '月ごとの請求額・差し引き・振込額は入れなくて大丈夫です。経営コックピットが AI で読みます' : '明細（現場・人工・単価）は入れなくて大丈夫です。経営コックピットが請求書を AI で読みます'}</p>

        {err && <div className="text-sm text-red-600">{err}</div>}
      </div>
    </Modal>
  )
}

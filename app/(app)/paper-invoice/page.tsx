'use client'

/**
 * 紙で出した請求書（2026-10-02・代表指示）。仕組みは lib/paper-invoice.ts の冒頭を参照。
 *
 * 応援の請求書はしばらく手作りで発行する。手作りの請求書（PDF・写真）と合計金額をここに入れ、
 * 同じ会社・同じ月のシステムの請求書（下書き or 発行済み）と並べて差を見る。
 * 画面の型: ① 今月の見比べの状況 → ② 1行一覧 → 行を押すと右に見比べの詳細。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { can } from '@/lib/permissions'
import { currentYmJst } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Chip, SidePanel, CloseButton, type ChipTone } from '@/components/ui/PageParts'
import {
  PAPER_INVOICE_ALLOWED_TYPES, PAPER_INVOICE_MAX_FILE_BYTES, PAPER_INVOICE_MAX_FILES,
  sanitizePaperLines, parsePaperNumber, isBlankNumberInput,
  type PaperInvoice, type PaperInvoiceLine, type PaperComparison, type SystemInvoiceFigures,
} from '@/lib/paper-invoice'

interface MonthData {
  records: PaperInvoice[]
  system: Record<string, SystemInvoiceFigures>
  comparisons: Record<string, PaperComparison>
  companies: { id: string; name: string }[]
  storageReady: boolean
}

const yen = (v: number | null | undefined) => (typeof v === 'number' ? '¥' + Math.round(v).toLocaleString() : '—')
const signedYen = (v: number) => (v === 0 ? '±0' : (v > 0 ? '+' : '−') + '¥' + Math.abs(Math.round(v)).toLocaleString())
const num = (v: number | null | undefined) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : '—')
const ymLabelOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月分`
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

function shiftYm(ym: string, delta: number): string {
  let y = parseInt(ym.slice(0, 4)), m = parseInt(ym.slice(4, 6)) + delta
  while (m < 1) { m += 12; y-- }
  while (m > 12) { m -= 12; y++ }
  return `${y}${String(m).padStart(2, '0')}`
}

/** ブラウザが Content-Type を付けない HEIC などを拡張子で補う */
function contentTypeOf(f: File): string {
  if (f.type) return f.type
  const ext = f.name.toLowerCase().split('.').pop()
  if (ext === 'heic') return 'image/heic'
  if (ext === 'heif') return 'image/heif'
  if (ext === 'pdf') return 'application/pdf'
  return ''
}

const SOURCE_LABEL: Record<SystemInvoiceFigures['source'], { label: string; tone: ChipTone }> = {
  issued: { label: 'システム発行済み', tone: 'green' },
  pending: { label: 'システム承認待ち', tone: 'blue' },
  draft: { label: 'システムの下書き', tone: 'gray' },
  none: { label: 'システムに請求なし', tone: 'amber' },
}

function diffChip(cmp: PaperComparison | undefined) {
  if (!cmp) return <Chip tone="gray">—</Chip>
  if (cmp.systemMissing) return <Chip tone="amber">システムに請求なし</Chip>
  if (cmp.match) return <Chip tone="green">一致</Chip>
  return <Chip tone="red">差 {signedYen(cmp.totalDiff)}</Chip>
}

export default function PaperInvoicePage() {
  const { user, ready } = useAuthPassword()
  const canEdit = can(user, 'invoice.paper')
  const canDelete = can(user, 'invoice.approve')
  const [ym, setYm] = useState(() => {
    if (typeof window === 'undefined') return shiftYm(currentYmJst(), -1)
    const q = new URLSearchParams(window.location.search).get('ym')
    // 既定は前月（請求書は月が明けてから出すので）
    return q && /^\d{6}$/.test(q) ? q : shiftYm(currentYmJst(), -1)
  })
  const [data, setData] = useState<MonthData | null>(null)
  const [allMonths, setAllMonths] = useState<{ ym: string; n: number }[]>([])
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; rec: PaperInvoice }>(null)

  const load = useCallback(async () => {
    if (!ready) return
    setData(null); setErr('')
    const [res, allRes] = await Promise.all([
      fetchWithAuth(`/api/paper-invoice?ym=${ym}`),
      fetchWithAuth('/api/paper-invoice?all=1'),
    ])
    const j = await res.json().catch(() => null)
    if (!res.ok || !j) { setErr(j?.error || '読み込みに失敗しました'); return }
    setData(j)
    if (allRes.ok) {
      const a = await allRes.json()
      const counts = new Map<string, number>()
      for (const r of (a.records || []) as PaperInvoice[]) counts.set(r.ym, (counts.get(r.ym) || 0) + 1)
      setAllMonths([...counts.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([k, n]) => ({ ym: k, n })))
    }
  }, [ready, ym])
  useEffect(() => { load() }, [load])
  useEffect(() => { setOpenId(null) }, [ym])

  const records = data?.records || []
  const cmpOf = (id: string) => data?.comparisons[id]
  const matched = records.filter(r => cmpOf(r.id)?.match)
  const differs = records.filter(r => { const c = cmpOf(r.id); return c && !c.match })
  const open = records.find(r => r.id === openId) || null

  const openFile = async (r: PaperInvoice, i: number) => {
    // ポップアップブロックを避けるため、先にタブを開いてから URL を入れる
    const win = window.open('', '_blank')
    try {
      const res = await fetchWithAuth(`/api/paper-invoice?open=${encodeURIComponent(r.id)}&i=${i}`)
      const j = await res.json()
      if (!res.ok || !j.url) throw new Error(j.error || 'ファイルを開けませんでした')
      if (win) win.location.href = j.url
      else window.location.href = j.url
    } catch (e) {
      win?.close()
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (r: PaperInvoice) => {
    if (!confirm(`${r.companyName} ${ymLabelOf(r.ym)}の紙の請求書を削除します。ファイルも消えます。よろしいですか？`)) return
    const res = await postJson('/api/paper-invoice', { action: 'delete', docId: r.id })
    if (!res.ok) { alert(res.error || '削除に失敗しました'); return }
    setOpenId(null)
    load()
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="請求・原価"
        title="紙で出した請求書"
        sub="手作りで出した請求書を入れて、システムの計算と見比べます。応援の請求書はしばらく手作りで発行するので、システムで未発行でも問題ありません"
        actions={
          <>
            <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
              <button type="button" aria-label="前の月" onClick={() => setYm(shiftYm(ym, -1))}
                className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px]">
                <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
              </button>
              <span className="px-1.5 text-[15px] font-bold tabular-nums">{ymLabelOf(ym)}</span>
              <button type="button" aria-label="次の月" onClick={() => setYm(shiftYm(ym, 1))}
                className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px]">
                <Icon name="chevronRight" size={18} strokeWidth={2.2} />
              </button>
            </div>
            {canEdit && (
              <button type="button" onClick={() => setModal({ mode: 'add' })} disabled={!data?.storageReady}
                className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[15px] font-bold hover:bg-hibi-light disabled:opacity-40">
                請求書を入れる
              </button>
            )}
            <a href={`/peer-statement?ym=${ym}`}
              className="h-[42px] px-4 inline-flex items-center rounded-[10px] border border-gray-300 dark:border-gray-600 text-[14px] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
              請求書・支払へ
            </a>
          </>
        }
      />

      {err && <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{err}</div>}
      {!data && !err && <div className="text-center py-12 text-gray-400">読み込み中...</div>}
      {data && !data.storageReady && (
        <div className="bg-amber-50 text-amber-800 rounded-xl p-4 text-sm">ファイルの置き場に接続できないため、いまは請求書を入れられません（サーバー設定を確認してください）</div>
      )}

      {data && (
        <>
          {/* ① この月の見比べの状況 */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TodoCard icon="doc" tone={records.length > 0 ? 'info' : 'ok'} title="入れた請求書"
              big={records.length > 0 ? `${records.length}件` : 'まだありません'}
              sub={records.length > 0 ? `${ymLabelOf(ym)}に入れた手作りの請求書` : `手作りで出した${ymLabelOf(ym)}の請求書を入れてください`}
              action={canEdit && data.storageReady ? '入れる' : undefined}
              onClick={canEdit && data.storageReady ? () => setModal({ mode: 'add' }) : undefined} />
            <TodoCard icon="check" tone="ok" title="システムと一致"
              big={matched.length > 0 ? `${matched.length}件` : '—'}
              sub="税込合計が1円も違わないもの" />
            <TodoCard icon="alert" tone={differs.length > 0 ? 'warn' : 'ok'} title="差がある"
              big={differs.length > 0 ? `${differs.length}件` : 'ありません'}
              sub={differs.length > 0 ? '行を押すと、どこが違うかを右に出します。計算ルールを合わせる材料にします' : '差が出たものはここに出ます'}
              onClick={differs.length > 0 ? () => setOpenId(differs[0].id) : undefined}
              action={differs.length > 0 ? '開く' : undefined} />
          </section>

          {/* ② 1行一覧 */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[17px] font-bold text-gray-900 dark:text-white">{ymLabelOf(ym)}の請求書</h2>
              <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">行を押すと、システムとの見比べが右に開きます</span>
            </div>
            <div className="hidden lg:grid grid-cols-[minmax(0,1fr)_140px_140px_190px_130px] gap-3.5 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
              <span>会社</span><span className="text-right">紙（税込）</span><span className="text-right">システム（税込）</span><span>見比べ</span><span>ファイル</span>
            </div>
            {records.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この月に入れた請求書はありません</div>
            ) : records.map(r => {
              const sys = data.system[r.companyId]
              return (
                <div key={r.id} role="button" tabIndex={0}
                  onClick={() => setOpenId(r.id)}
                  onKeyDown={e => { if (e.key === 'Enter') setOpenId(r.id) }}
                  className="border-t border-hibi-line dark:border-gray-700 first-of-type:border-t-0 px-5 py-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_140px_140px_190px_130px] gap-2 lg:gap-3.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-bold text-gray-900 dark:text-gray-100 truncate">{r.companyName}</span>
                    {r.no && <span className="block text-xs text-hibi-sub dark:text-gray-400">{r.no}</span>}
                  </span>
                  <span className="lg:text-right text-[17px] font-bold tabular-nums text-gray-900 dark:text-white">
                    <span className="lg:hidden mr-2 text-xs font-normal text-hibi-sub dark:text-gray-400">紙</span>{yen(r.total)}
                  </span>
                  <span className="lg:text-right text-[15px] tabular-nums text-gray-700 dark:text-gray-300">
                    <span className="lg:hidden mr-2 text-xs text-hibi-sub dark:text-gray-400">システム</span>{sys && sys.source !== 'none' ? yen(sys.total) : '—'}
                  </span>
                  <span>{diffChip(cmpOf(r.id))}</span>
                  <span className="text-xs text-hibi-sub dark:text-gray-400">{r.files.length}ファイル</span>
                </div>
              )
            })}
          </section>

          {allMonths.length > 0 && (
            <section className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-hibi-sub dark:text-gray-400">これまでに入れた月:</span>
              {allMonths.map(m => (
                <button key={m.ym} type="button" onClick={() => setYm(m.ym)}
                  className={`h-8 px-3 rounded-full border text-[13px] font-bold ${m.ym === ym ? 'bg-hibi-navy text-white border-hibi-navy' : 'border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'}`}>
                  {ymLabelOf(m.ym)}（{m.n}）
                </button>
              ))}
            </section>
          )}

          <p className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed">
            システムの数字は、発行済み（または承認待ち）ならその内容、まだなら出面から作る下書きです。
            応援の請求書は残業を人工に換算して含めるので、手作りが「残業 ◯h」の別行なら、人工と残業の欄で差が出ます。
          </p>
        </>
      )}

      {open && data && (
        <SidePanel label={`${open.companyName} の見比べ`} onClose={() => setOpenId(null)} width="max-w-[760px]">
          <Detail rec={open} sys={data.system[open.companyId]} cmp={cmpOf(open.id)}
            onClose={() => setOpenId(null)} onOpenFile={i => openFile(open, i)}
            onEdit={canEdit ? () => setModal({ mode: 'edit', rec: open }) : undefined}
            onDelete={canDelete ? () => remove(open) : undefined} />
        </SidePanel>
      )}

      {modal && data && (
        <PaperInvoiceModal
          mode={modal.mode} rec={modal.mode === 'edit' ? modal.rec : undefined}
          ym={ym} companies={data.companies}
          onClose={() => setModal(null)}
          onDone={(newYm) => { setModal(null); if (newYm && newYm !== ym) setYm(newYm); else load() }}
        />
      )}
    </div>
  )
}

function Detail({ rec, sys, cmp, onClose, onOpenFile, onEdit, onDelete }: {
  rec: PaperInvoice; sys?: SystemInvoiceFigures; cmp?: PaperComparison
  onClose: () => void; onOpenFile: (i: number) => void; onEdit?: () => void; onDelete?: () => void
}) {
  const rows: { label: string; paper: string; system: string; diff: number | null; isYen: boolean }[] = cmp && sys ? [
    { label: '税抜小計', paper: yen(rec.subtotal), system: yen(sys.subtotal), diff: cmp.subtotalDiff, isYen: true },
    { label: '消費税', paper: yen(rec.tax), system: yen(sys.tax), diff: cmp.taxDiff, isYen: true },
    { label: '税込合計', paper: yen(rec.total), system: yen(sys.total), diff: cmp.totalDiff, isYen: true },
    { label: '人工の合計', paper: num(cmp.paperDays), system: num(cmp.systemDays), diff: cmp.paperDays === null ? null : Math.round((cmp.paperDays - cmp.systemDays) * 100) / 100, isYen: false },
    { label: '残業時間の合計（h）', paper: num(cmp.paperOtHours), system: num(cmp.systemOtHours), diff: cmp.paperOtHours === null ? null : Math.round((cmp.paperOtHours - cmp.systemOtHours) * 100) / 100, isYen: false },
  ] : []
  const src = sys ? SOURCE_LABEL[sys.source] : null

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[22px] font-bold text-gray-900 dark:text-white">{rec.companyName}</h2>
          <div className="text-[13px] text-hibi-sub dark:text-gray-400">
            {ymLabelOf(rec.ym)}{rec.no && ` ／ ${rec.no}`}{rec.issueDate && ` ／ 発行日 ${rec.issueDate}`}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {diffChip(cmp)}
            {src && <Chip tone={src.tone}>{src.label}{sys?.no ? ` ${sys.no}` : ''}</Chip>}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <section className="space-y-2">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">ファイル</h3>
        <div className="flex flex-wrap gap-2">
          {rec.files.map((f, i) => (
            <button key={i} type="button" onClick={() => onOpenFile(i)}
              className="h-9 px-3 rounded-[9px] border border-gray-300 dark:border-gray-600 text-[13px] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 max-w-full truncate">
              {f.name}（{fmtSize(f.size)}）
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">紙とシステムの見比べ</h3>
        {/* スマホ（375px）でもはみ出さないよう、数字の列は最大110pxまで縮む・文字も小さく（2026-10-02） */}
        <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-x-auto text-xs sm:text-sm">
          <div className="grid grid-cols-[minmax(4.5rem,1fr)_repeat(3,minmax(0,110px))] gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 bg-hibi-thead dark:bg-gray-700 text-[11px] sm:text-xs font-bold text-hibi-sub dark:text-gray-300">
            <span>項目</span><span className="text-right">紙</span><span className="text-right">システム</span><span className="text-right">差<span className="hidden sm:inline">（紙−システム）</span></span>
          </div>
          {rows.map(r => (
            <div key={r.label} className="grid grid-cols-[minmax(4.5rem,1fr)_repeat(3,minmax(0,110px))] gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 border-t border-hibi-line dark:border-gray-700 tabular-nums">
              <span className="font-bold break-words">{r.label}</span>
              <span className="text-right break-all">{r.paper}</span>
              <span className="text-right break-all">{r.system}</span>
              <span className={`text-right font-bold break-all ${r.diff === null ? 'text-gray-400' : r.diff === 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                {r.diff === null ? '—' : r.isYen ? signedYen(r.diff) : (r.diff > 0 ? '+' : '') + r.diff}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-hibi-sub dark:text-gray-400">紙の小計・消費税・明細を入れていない項目は「—」です。入れるほど細かく見比べられます</p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <LineList title="紙の明細" lines={(rec.lines || []).map(l => ({ site: l.site, item: l.item, qty: `${num(l.qty)}${l.unit}`, rate: l.rate, amount: l.amount }))}
          empty="明細は入っていません" />
        <LineList title="システムの明細" lines={(sys?.lines || []).map(l => ({ site: l.siteName, item: l.unit === 'h' ? `${l.role} 残業` : l.role, qty: `${num(l.days)}${l.unit === 'h' ? 'h' : '人工'}`, rate: l.rate, amount: l.amount }))}
          empty="システムでは、この月の請求はありません" />
      </section>

      {rec.note && (
        <section className="space-y-1">
          <h3 className="text-base font-bold text-gray-900 dark:text-white">メモ</h3>
          <p className="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">{rec.note}</p>
        </section>
      )}

      {(onEdit || onDelete) && (
        <div className="flex gap-2">
          {onEdit && <button type="button" onClick={onEdit} className="h-10 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-[14px] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">金額・明細を直す</button>}
          {onDelete && <button type="button" onClick={onDelete} className="h-10 px-4 rounded-[10px] text-[14px] font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">削除</button>}
        </div>
      )}
    </div>
  )
}

function LineList({ title, lines, empty }: { title: string; lines: { site: string; item: string; qty: string; rate: number; amount: number }[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-gray-900 dark:text-white">{title}</h3>
      <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-[13px]">
        {lines.length === 0 ? (
          <div className="px-3 py-4 text-center text-hibi-sub dark:text-gray-400">{empty}</div>
        ) : lines.map((l, i) => (
          <div key={i} className="px-3 py-2 border-t first:border-t-0 border-hibi-line dark:border-gray-700">
            <div className="truncate text-hibi-sub dark:text-gray-400 text-xs">{l.site}</div>
            <div className="flex items-baseline gap-2 tabular-nums">
              <span className="font-bold">{l.item}</span>
              <span>{l.qty} × {yen(l.rate)}</span>
              <span className="ml-auto font-bold">{yen(l.amount)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type LineDraft = { site: string; item: string; qty: string; unit: string; rate: string; amount: string }
// 内容は空（placeholder で「鳶…」と見せる）。初期値に「鳶」を入れると、使わなかった行が空行として捨てられず残る
const emptyLine = (): LineDraft => ({ site: '', item: '', qty: '', unit: '人工', rate: '', amount: '' })
/** 全角数字・カンマ・円も読む（サーバと同じ lib/paper-invoice.ts parsePaperNumber）。空欄は 0 */
const toNum = (s: string) => parsePaperNumber(s)
/** 単位の選択肢。「日」は人工として数えない（isManDayUnit）ので出さない */
const UNIT_OPTIONS = ['人工', 'h', '式', '人']

function PaperInvoiceModal({ mode, rec, ym, companies, onClose, onDone }: {
  mode: 'add' | 'edit'; rec?: PaperInvoice; ym: string; companies: { id: string; name: string }[]
  onClose: () => void; onDone: (ym?: string) => void
}) {
  const [companyId, setCompanyId] = useState(rec?.companyId || '')
  const [targetYm, setTargetYm] = useState(rec?.ym || ym)
  const [no, setNo] = useState(rec?.no || '')
  const [issueDate, setIssueDate] = useState(rec?.issueDate || '')
  const [subtotal, setSubtotal] = useState(rec?.subtotal != null ? String(rec.subtotal) : '')
  const [tax, setTax] = useState(rec?.tax != null ? String(rec.tax) : '')
  const [total, setTotal] = useState(rec?.total != null ? String(rec.total) : '')
  const [note, setNote] = useState(rec?.note || '')
  const [lines, setLines] = useState<LineDraft[]>(() => (rec?.lines || []).map((l: PaperInvoiceLine) => ({
    site: l.site, item: l.item, qty: String(l.qty), unit: l.unit, rate: String(l.rate), amount: String(l.amount),
  })))
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list)
    const bad = arr.filter(f => !PAPER_INVOICE_ALLOWED_TYPES.includes(contentTypeOf(f)))
    const big = arr.filter(f => f.size > PAPER_INVOICE_MAX_FILE_BYTES)
    if (bad.length) { setErr(`入れられない形式です: ${bad.map(f => f.name).join('、')}（PDF・写真だけ）`); return }
    if (big.length) { setErr(`25MBを超えています: ${big.map(f => f.name).join('、')}`); return }
    setErr('')
    setFiles(prev => [...prev, ...arr].slice(0, PAPER_INVOICE_MAX_FILES))
  }

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines(prev => prev.map((l, j) => {
    if (j !== i) return l
    const next = { ...l, ...patch }
    // 数量と単価が入っていて金額が空なら、掛け算を入れておく（手で直せる）
    if (('qty' in patch || 'rate' in patch) && !l.amount) {
      const q = toNum(next.qty), r = toNum(next.rate)
      if (q > 0 && r > 0) next.amount = String(Math.round(q * r))
    }
    return next
  }))
  const linesSum = lines.reduce((s, l) => s + (toNum(l.amount) || 0), 0)

  const submit = async () => {
    // アップロードの前に、サーバ（commit）と同じ決まりで確かめる。落ちる内容ならファイルを送らない
    if (!companyId) { setErr('請求先の会社を選んでください'); return }
    if (!(toNum(total) > 0)) { setErr('税込合計を入れてください（数字で）'); return }
    for (const [label, v] of [['税抜小計', subtotal], ['消費税', tax]] as const) {
      if (!isBlankNumberInput(v) && Number.isNaN(toNum(v))) { setErr(`${label}の数字が読めません`); return }
    }
    const lineRows = lines.map(l => ({ site: l.site, item: l.item, unit: l.unit, qty: l.qty, rate: l.rate, amount: l.amount }))
    const lineCheck = sanitizePaperLines(lineRows)
    if (!lineCheck.ok) { setErr(lineCheck.error); return }
    if (mode === 'add' && files.length === 0) { setErr('請求書のファイル（PDF・写真）を選んでください'); return }
    setErr('')
    const fields = { companyId, ym: targetYm, total, subtotal, tax, no, issueDate, note, lines: lineRows }
    let uploadedDocId: string | null = null
    try {
      if (mode === 'edit' && rec) {
        setBusy('保存中...')
        const r = await postJson('/api/paper-invoice', { action: 'update', docId: rec.id, ...fields })
        if (!r.ok) throw new Error(r.error || '保存に失敗しました')
        onDone(targetYm)
        return
      }
      setBusy('準備中...')
      const prep = await postJson<{ docId: string; uploads: { path: string; name: string; contentType: string; size: number; url: string }[] }>(
        '/api/paper-invoice',
        { action: 'prepare', ...fields, files: files.map(f => ({ name: f.name, contentType: contentTypeOf(f), size: f.size })) },
      )
      if (!prep.ok || !prep.data) throw new Error(prep.error || '準備に失敗しました')
      const { docId, uploads } = prep.data
      uploadedDocId = docId
      for (let i = 0; i < uploads.length; i++) {
        setBusy(`アップロード中 ${i + 1}/${uploads.length}...`)
        const res = await fetch(uploads[i].url, { method: 'PUT', headers: { 'Content-Type': uploads[i].contentType }, body: files[i] })
        if (!res.ok) throw new Error(`アップロードに失敗しました: ${files[i].name}（${res.status}）`)
      }
      setBusy('登録中...')
      const commit = await postJson('/api/paper-invoice', {
        action: 'commit', docId, ...fields,
        files: uploads.map(u => ({ path: u.path, name: u.name, contentType: u.contentType, size: u.size })),
      })
      if (!commit.ok) throw new Error(commit.error || '登録に失敗しました')
      uploadedDocId = null
      onDone(targetYm)
    } catch (e) {
      // 登録できなかったら、置いたファイルを片付ける（記録の無いファイルを残さない。記録がある docId はサーバが消さない）
      if (uploadedDocId) await postJson('/api/paper-invoice', { action: 'discard', docId: uploadedDocId }).catch(() => null)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const inputCls = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm'
  const ymValue = `${targetYm.slice(0, 4)}-${targetYm.slice(4, 6)}`

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={busy ? undefined : onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-3xl p-5 my-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-hibi-navy dark:text-white">{mode === 'add' ? '紙で出した請求書を入れる' : '金額・明細を直す'}</h3>
          <button onClick={busy ? undefined : onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="閉じる">×</button>
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-500">請求先の会社 <span className="text-red-600">必須</span></span>
              <select value={companyId} onChange={e => setCompanyId(e.target.value)} className={inputCls}>
                <option value="">選んでください</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">対象月 <span className="text-red-600">必須</span></span>
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
                <div className="text-[11px] text-gray-400 mt-1">PDF・写真（JPEG/PNG/HEIC）／出面明細など添付も一緒に{PAPER_INVOICE_MAX_FILES}個まで／1ファイル25MBまで</div>
                <input ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*" className="hidden"
                  onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
              </div>
              {files.length > 0 && (
                <ul className="text-xs space-y-1 mt-2">
                  {files.map((f, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate">{f.name}（{fmtSize(f.size)}）</span>
                      <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-red-500 hover:underline shrink-0">外す</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <label className="block col-span-2 sm:col-span-1">
              <span className="text-xs text-gray-500">税込合計 <span className="text-red-600">必須</span></span>
              <input inputMode="numeric" value={total} onChange={e => setTotal(e.target.value)} placeholder="4,366,313" className={`${inputCls} tabular-nums`} />
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
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-gray-900 dark:text-white">明細（任意・請求書に書いてあるとおり）</span>
              {lines.length > 0 && <span className="text-xs text-hibi-sub dark:text-gray-400 tabular-nums">金額の合計 {yen(linesSum)}</span>}
            </div>
            {lines.length > 0 && (
              <div className="space-y-2">
                <div className="hidden sm:grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_70px_64px_90px_100px_28px] gap-2 text-[11px] text-gray-500">
                  <span>現場</span><span>内容</span><span>数量</span><span>単位</span><span>単価</span><span>金額</span><span />
                </div>
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_70px_64px_90px_100px_28px] gap-2 items-center">
                    <input value={l.site} onChange={e => setLine(i, { site: e.target.value })} placeholder="現場" className={`${inputCls} col-span-2 sm:col-span-1`} />
                    <input value={l.item} onChange={e => setLine(i, { item: e.target.value })} placeholder="鳶・土工・鳶 残業" className={inputCls} />
                    <input inputMode="decimal" value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} placeholder="数量" className={`${inputCls} tabular-nums`} />
                    <select value={l.unit} onChange={e => setLine(i, { unit: e.target.value })} className={inputCls}>
                      {(UNIT_OPTIONS.includes(l.unit) ? UNIT_OPTIONS : [...UNIT_OPTIONS, l.unit]).map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <input inputMode="numeric" value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} placeholder="単価" className={`${inputCls} tabular-nums`} />
                    <input inputMode="numeric" value={l.amount} onChange={e => setLine(i, { amount: e.target.value })} placeholder="金額" className={`${inputCls} tabular-nums`} />
                    <button type="button" onClick={() => setLines(prev => prev.filter((_, j) => j !== i))} className="text-red-500 text-lg leading-none" aria-label="この行を消す">×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setLines(prev => [...prev, { ...emptyLine(), site: prev[prev.length - 1]?.site || '' }])}
              className="h-9 px-3 rounded-[9px] border border-gray-300 dark:border-gray-600 text-[13px] font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
              ＋ 明細の行を足す
            </button>
          </div>

          <label className="block">
            <span className="text-xs text-gray-500">メモ（計算で気をつけたこと・いつもと違う点など）</span>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className={inputCls} />
          </label>

          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={!!busy} className="h-10 px-4 rounded-[10px] border border-gray-300 dark:border-gray-600 text-[14px] font-bold disabled:opacity-40">やめる</button>
            <button type="button" onClick={submit} disabled={!!busy} className="h-10 px-5 rounded-[10px] bg-hibi-navy text-white text-[14px] font-bold hover:bg-hibi-light disabled:opacity-60">
              {busy || (mode === 'add' ? '入れる' : '保存')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

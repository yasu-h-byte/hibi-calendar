'use client'

/**
 * 応援の請求書（2026-09-25・社長指示）
 *
 * 日比建設が「応援に行った」同業者へ送る請求書。1ページ目が請求書本体、
 * 2ページ目以降が出面明細（誰が・いつ・何人工働いたかの根拠）。
 * ブラウザの印刷（Cmd+P）で PDF 化する。
 *
 * URL: /peer-invoice?company=<取引先id>&ym=YYYYMM
 * 入口は /peer-statement（同業者との請求・支払）の各社カードから。
 *
 * 発行すると `peerInvoices` コレクションにその時点の金額・明細・宛先・自社情報を
 * まるごと凍結して保存する（以後この画面は凍結内容を描画するだけで再計算しない）。
 * 取り消すと欠番のまま履歴に残り、取り消した後だけ新しい番号で作り直せる。
 *
 * 印刷は A4 縦のみで統一している（請求書1ページ目と出面明細を CSS 名前付きページで
 * 縦横混在させる案は Chrome の印刷崩れリスクがあるため見送り。出面明細は31日分を
 * 小さいフォントで縦向きに収める）。
 */
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchWithAuth, postJson } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { HFU_INVOICE_COMPANY_ID } from '@/lib/constants'

// ── API レスポンスと同じ形の型（lib/peer-invoice.ts・lib/peer-invoice-store.ts 参照） ──
interface PeerInvoiceLine { siteId: string; siteName: string; role: '鳶' | '土工'; days: number; rate: number; amount: number; unit?: 'h' }
interface PeerInvoiceDetailCell { md: number; ot?: number; night?: boolean }
interface PeerInvoiceDetailRow { key: string; label: string; isSubcon: boolean; cells: Record<number, PeerInvoiceDetailCell>; total: number }
interface PeerInvoiceSiteDetail { siteId: string; siteName: string; rows: PeerInvoiceDetailRow[]; dayTotals: Record<number, number>; siteTotal: number }
interface PeerInvoiceCompanyInfo { postal: string; address: string; honorific: string }
interface CompanyProfile {
  name: string; nameEn: string; representative?: string; postal: string; address: string; tel: string; fax?: string; email?: string
  invoiceRegNo: string
  bank: { bankName: string; branch: string; accountType: string; accountNo: string; holder: string }
  invoicePrefix: string
}
interface PeerInvoiceDraft {
  /** 'hfu' = HFU → 日比建設（lib/hfu-invoice.ts）。無ければ応援の請求書 */
  kind?: 'peer' | 'hfu'
  companyId: string; companyName: string; company: PeerInvoiceCompanyInfo; ym: string
  period: { from: string; to: string }
  lines: PeerInvoiceLine[]
  subtotal: number; taxRate: number; tax: number; total: number; dueDate: string
  detail: PeerInvoiceSiteDetail[]
}
interface PeerInvoiceRecord extends PeerInvoiceDraft {
  id: string; no: string; issuer: CompanyProfile
  status: 'pending' | 'issued' | 'void' | 'rejected' | 'withdrawn'
  issueDate: string; issuedAt: string; issuedBy: string
  requestedAt?: string; requestedByName?: string
  rejectedAt?: string; rejectReason?: string
  voidedAt?: string; voidedBy?: string; voidReason?: string
}
type ApiResponse =
  | { status: 'issued' | 'pending'; record: PeerInvoiceRecord; history: PeerInvoiceRecord[] }
  | { status: 'draft'; draft: PeerInvoiceDraft; issuer: CompanyProfile | null; history: PeerInvoiceRecord[] }
  | { status: 'empty'; history: PeerInvoiceRecord[] }
  | { error: string }

/** 画面に描く1件。isDraft = 番号がまだ無い（下書き・承認待ち） */
type InvoiceView = PeerInvoiceDraft & {
  isDraft: boolean; no: string; issuer: CompanyProfile; issueDate: string; id: string
  status: 'draft' | PeerInvoiceRecord['status']
  requestedAt?: string; requestedByName?: string
}

const BLANK_ISSUER: CompanyProfile = {
  name: '', nameEn: '', postal: '', address: '', tel: '', fax: '', email: '',
  invoiceRegNo: '', bank: { bankName: '', branch: '', accountType: '普通', accountNo: '', holder: '' }, invoicePrefix: 'HC',
}

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const jpYm = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月`
const jpDate = (iso: string) => {
  if (!iso || iso.length < 10) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}
function shiftYm(ym: string, delta: number): string {
  let y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(4, 6), 10) + delta
  while (m < 1) { m += 12; y-- }
  while (m > 12) { m -= 12; y++ }
  return `${y}${String(m).padStart(2, '0')}`
}
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']
function daysInYm(ym: string): number {
  return new Date(parseInt(ym.slice(0, 4), 10), parseInt(ym.slice(4, 6), 10), 0).getDate()
}
function weekdayOf(ym: string, day: number): number {
  return new Date(parseInt(ym.slice(0, 4), 10), parseInt(ym.slice(4, 6), 10) - 1, day).getDay()
}
function fmtMd(md: number): string {
  return Number.isInteger(md) ? String(md) : String(Math.round(md * 100) / 100)
}

function PeerInvoicePageInner() {
  const params = useSearchParams()
  const companyId = params.get('company') || ''
  const [ym, setYm] = useState(params.get('ym') || currentYm())
  const { user, ready } = useAuthPassword()
  const [data, setData] = useState<ApiResponse | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!ready || !companyId) return
    setData(null); setErr('')
    try {
      const res = await fetchWithAuth(`/api/peer-invoice?ym=${ym}&companyId=${companyId}`)
      const json = await res.json()
      if (!res.ok) { setErr(json.error || '読み込みに失敗しました'); return }
      setData(json)
    } catch {
      setErr('読み込みに失敗しました')
    }
  }, [ready, ym, companyId])
  useEffect(() => { load() }, [load])

  // 承認フロー（2026-09-26）: 事務（森田さん）が申請 → 事業責任者（政仁さん）・管理者が承認して発行
  const canIssue = user?.role === 'admin' || user?.role === 'approver'
  const canRequest = user?.role === 'jimu'

  const post = async (payload: Record<string, unknown>, failMsg: string) => {
    setBusy(true)
    const res = await postJson<{ error?: string }>('/api/peer-invoice', payload)
    setBusy(false)
    if (!res.ok) { alert(res.error || res.data?.error || failMsg); return }
    load()
  }

  const handleIssue = async () => {
    if (!confirm('この内容で発行します。発行すると金額・明細を凍結し、その後は取り消してからでないと作り直せません。よろしいですか？')) return
    post({ action: 'issue', ym, companyId }, '発行に失敗しました')
  }
  const handleRequest = async () => {
    if (!confirm('この内容で発行を申請します。事業責任者が承認すると請求書番号が付いて発行されます。よろしいですか？')) return
    post({ action: 'request', ym, companyId }, '申請に失敗しました')
  }
  const handleApprove = async (id: string) => {
    if (!confirm('この申請を承認して発行します。よろしいですか？')) return
    post({ action: 'approve', id }, '承認に失敗しました')
  }
  const handleReject = async (id: string) => {
    const reason = window.prompt('差し戻す理由（申請した人に表示されます）')
    if (reason === null) return
    post({ action: 'reject', id, reason }, '差し戻しに失敗しました')
  }
  const handleWithdraw = async (id: string) => {
    if (!confirm('この申請を取り下げますか？ 取り下げたあと、内容を直してもう一度申請できます。')) return
    post({ action: 'withdraw', id }, '取り下げに失敗しました')
  }

  const handleVoid = async (id: string) => {
    const reason = window.prompt('取り消し理由（任意・あとで履歴に残ります）') ?? ''
    if (!confirm('この請求書を取り消しますか？ 取り消した番号は欠番のまま残ります。')) return
    setBusy(true)
    const res = await postJson<{ error?: string }>('/api/peer-invoice', { action: 'void', id, reason })
    setBusy(false)
    if (!res.ok) { alert(res.error || res.data?.error || '取り消しに失敗しました'); return }
    load()
  }

  if (!companyId) {
    return (
      <div className="max-w-2xl mx-auto py-10 text-center text-sm text-gray-500">
        会社が指定されていません。<a href="/peer-statement" className="text-hibi-navy underline">同業者との請求・支払</a> のページから開いてください。
      </div>
    )
  }

  const view: InvoiceView | null =
    data && !('error' in data) && data.status !== 'empty'
      ? 'record' in data
        ? { ...data.record, isDraft: data.status === 'pending' }
        : { ...data.draft, issuer: data.issuer || BLANK_ISSUER, isDraft: true, no: '', status: 'draft', issueDate: '', id: '' }
      : null
  const history = data && !('error' in data) ? data.history : []
  const isEmpty = data && !('error' in data) && data.status === 'empty'
  const isHfuInvoice = companyId === HFU_INVOICE_COMPANY_ID
  const isPending = view?.status === 'pending'
  const isFreshDraft = view?.status === 'draft'
  // 直近の差し戻し（その後に申請・発行していなければ、下書きの上に理由を出す）
  const lastRejected = isFreshDraft ? [...history].reverse().find(h => h.status === 'rejected') : undefined

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── 画面のみのツールバー ── */}
      <div className="no-print space-y-3 mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-bold text-hibi-navy dark:text-white">{isHfuInvoice ? 'HFU → 日比建設 の請求書' : '応援の請求書'}</h1>
            {view && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{view.companyName} ／ {jpYm(ym)}分</p>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setYm(shiftYm(ym, -1))} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm">◀</button>
            <span className="text-sm font-bold tabular-nums">{jpYm(ym)}</span>
            <button onClick={() => setYm(shiftYm(ym, 1))} className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm">▶</button>
          </div>
        </div>

        {view && (
          <div className={`rounded-lg px-3 py-2 text-sm font-bold ${isPending ? 'bg-blue-50 text-blue-800 border border-blue-300' : view.isDraft ? 'bg-amber-50 text-amber-800 border border-amber-300' : 'bg-emerald-50 text-emerald-800 border border-emerald-300'}`}>
            {isPending
              ? `承認待ち — ${view.requestedByName || ''}さんが ${jpDate(view.requestedAt || '')} に申請。申請した時点の内容で表示しています`
              : view.isDraft ? '下書き（未発行）— 出面の実績から見込みを計算しています' : `発行済み ${view.no}（${jpDate(view.issueDate)}）`}
          </div>
        )}
        {lastRejected && (
          <div className="rounded-lg px-3 py-2 text-sm bg-red-50 text-red-800 border border-red-300">
            差し戻されました（{jpDate(lastRejected.rejectedAt || '')}）{lastRejected.rejectReason ? `: ${lastRejected.rejectReason}` : ''}。直してからもう一度申請してください。
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => window.print()} disabled={!view}
            className="px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:bg-hibi-light transition disabled:opacity-40">
            🖨 印刷 / PDF保存
          </button>
          {isFreshDraft && canIssue && (
            <button onClick={handleIssue} disabled={busy}
              className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold hover:bg-amber-600 transition disabled:opacity-40">
              この内容で発行
            </button>
          )}
          {isFreshDraft && canRequest && (
            <button onClick={handleRequest} disabled={busy}
              className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold hover:bg-amber-600 transition disabled:opacity-40">
              発行を申請（承認へ回す）
            </button>
          )}
          {view && isPending && canIssue && (
            <>
              <button onClick={() => handleApprove(view.id)} disabled={busy}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700 transition disabled:opacity-40">
                承認して発行
              </button>
              <button onClick={() => handleReject(view.id)} disabled={busy}
                className="px-4 py-2 bg-white text-red-600 border border-red-300 rounded-lg text-sm font-bold hover:bg-red-50 transition disabled:opacity-40">
                差し戻し
              </button>
            </>
          )}
          {view && isPending && canRequest && (
            <button onClick={() => handleWithdraw(view.id)} disabled={busy}
              className="px-4 py-2 bg-white text-gray-600 border border-gray-300 rounded-lg text-sm font-bold hover:bg-gray-50 transition disabled:opacity-40">
              申請を取り下げ
            </button>
          )}
          {view && view.status === 'issued' && canIssue && (
            <button onClick={() => handleVoid(view.id)} disabled={busy}
              className="px-4 py-2 bg-white text-red-600 border border-red-300 rounded-lg text-sm font-bold hover:bg-red-50 transition disabled:opacity-40">
              取り消し
            </button>
          )}
          {isFreshDraft && !canIssue && !canRequest && (
            <span className="text-xs text-gray-400">発行の申請は事務、承認は事業責任者・管理者が行います</span>
          )}
        </div>

        {history.length > 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg p-2">
            この会社・この月の発行履歴: {history.map(h => (
              <span key={h.id} className={`inline-block mr-2 ${h.status === 'issued' || h.status === 'pending' ? '' : 'line-through text-gray-400'}`}>
                {h.no || '番号なし'}（{
                  h.status === 'void' ? `取消 ${jpDate(h.voidedAt || '')}`
                  : h.status === 'pending' ? `承認待ち ${jpDate(h.requestedAt || '')}`
                  : h.status === 'rejected' ? `差し戻し ${jpDate(h.rejectedAt || '')}`
                  : h.status === 'withdrawn' ? `取り下げ ${jpDate(h.rejectedAt || '')}`
                  : jpDate(h.issueDate)
                }）
              </span>
            ))}
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}
        {!data && !err && <p className="text-sm text-gray-400">読み込み中…</p>}
        {isEmpty && <p className="text-sm text-gray-400">{isHfuInvoice ? 'この月は HFU の人工がありません。' : 'この会社・この月は応援の請求がありません。'}</p>}
      </div>

      {/* ── 印刷対象 ── */}
      {view && <PeerInvoiceDocument view={view} />}

      <style jsx global>{`
        @media print {
          aside, header, nav, .no-print { display: none !important; }
          @page { size: A4 portrait; margin: 12mm; }
          .pi-page { page-break-after: always; }
          .pi-page:last-child { page-break-after: auto; }
          .pi-detail-table thead { display: table-header-group; }
          .pi-detail-table tr { page-break-inside: avoid; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          main, .pi-root { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
        }
        .pi-root {
          background: white; color: #1a1a1a;
          font-family: -apple-system, "Hiragino Sans", "Noto Sans CJK JP", "Yu Gothic", sans-serif;
        }
        .pi-page { position: relative; width: 100%; max-width: 190mm; margin: 0 auto 16px; padding: 10mm 12mm; background: white; }
        .pi-accent { height: 3px; background: linear-gradient(90deg, #F5A623, #DD9314); border-radius: 2px; }
        .pi-watermark {
          position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%) rotate(-18deg);
          font-size: 64px; font-weight: 800; color: rgba(220, 38, 38, 0.14); letter-spacing: 8px;
          pointer-events: none; white-space: nowrap; z-index: 0;
        }
        .pi-detail-table { border-collapse: collapse; width: 100%; font-size: 6.4px; }
        .pi-detail-table th, .pi-detail-table td { border: 0.5px solid #999; padding: 1px 2px; text-align: center; }
        .pi-detail-table th { background: #F2F4F9; font-weight: 700; }
        .pi-detail-table td.pi-label { text-align: left; font-size: 7px; white-space: nowrap; padding-left: 3px; }
        .pi-detail-table td.pi-weekend, .pi-detail-table th.pi-weekend { background: #FFF3E0; }
        .pi-detail-table td.pi-night { background: #E8ECF5; font-weight: 700; }
        .pi-detail-table td.pi-total, .pi-detail-table th.pi-total { font-weight: 700; background: #F2F4F9; }
      `}</style>
    </div>
  )
}

function PeerInvoiceDocument({ view }: { view: InvoiceView }) {
  const isHfu = view.kind === 'hfu'
  const nDays = daysInYm(view.ym)
  const days = Array.from({ length: nDays }, (_, i) => i + 1)

  return (
    <div className="pi-root">
      {/* ── ページ1: 請求書本体 ── */}
      <div className="pi-page">
        {view.isDraft && <div className="pi-watermark">{view.status === 'pending' ? '承認待ち' : 'DRAFT 下書き'}</div>}
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1B2A4A' }}>{view.issuer.name || (isHfu ? '（HFU の会社名 未入力）' : '株式会社日比建設')}</div>
              <div style={{ fontSize: 10, letterSpacing: 2, color: '#666' }}>{view.issuer.nameEn || (isHfu ? '' : 'HIBI CONSTRUCTION')}</div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#1B2A4A' }}>請求書</div>
          </div>
          <div className="pi-accent" style={{ marginTop: 6, marginBottom: 12 }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ fontSize: 12 }}>
              {view.company.postal && <div>〒{view.company.postal}</div>}
              <div>{view.company.address}</div>
              <div style={{ fontSize: 16, fontWeight: 800, marginTop: 4, borderBottom: '2px solid #1B2A4A', display: 'inline-block', paddingBottom: 2 }}>
                {view.companyName} {view.company.honorific}
              </div>
            </div>
            <table style={{ fontSize: 10.5, height: 'fit-content' }}>
              <tbody>
                <tr><td style={{ color: '#666', paddingRight: 8 }}>請求番号</td><td style={{ fontWeight: 700 }}>{view.no || '（未発行）'}</td></tr>
                <tr><td style={{ color: '#666', paddingRight: 8 }}>発行日</td><td>{view.issueDate ? jpDate(view.issueDate) : '（未発行）'}</td></tr>
                <tr><td style={{ color: '#666', paddingRight: 8 }}>支払期日</td><td style={{ fontWeight: 700 }}>{jpDate(view.dueDate)}</td></tr>
                <tr><td style={{ color: '#666', paddingRight: 8 }}>対象期間</td><td>{jpDate(view.period.from)}〜{jpDate(view.period.to)}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 10, fontSize: 12 }}>件名: {jpYm(view.ym)}分 {isHfu ? '作業費' : '応援作業費'}</div>

          <div style={{
            marginTop: 12, padding: '10px 16px', background: '#1B2A4A', color: 'white', borderRadius: 8,
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>ご請求金額（税込）</span>
            <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: 1 }}>{yen(view.total)}</span>
          </div>

          <table style={{ width: '100%', marginTop: 14, borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#F2F4F9' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #1B2A4A' }}>現場</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #1B2A4A' }}>内容</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '2px solid #1B2A4A' }}>{isHfu ? '数量' : '数量（人工）'}</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '2px solid #1B2A4A' }}>単価</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '2px solid #1B2A4A' }}>金額</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #E6E9F0' }}>
                  <td style={{ padding: '6px 8px' }}>{l.siteName}</td>
                  <td style={{ padding: '6px 8px' }}>{l.unit === 'h' ? `${l.role} 残業` : l.role}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMd(l.days)}{l.unit === 'h' ? ' h' : isHfu ? ' 人工' : ''}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(l.rate)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{yen(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <table style={{ fontSize: 11, minWidth: 220 }}>
              <tbody>
                <tr><td style={{ padding: '3px 10px 3px 0', color: '#666' }}>小計</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(view.subtotal)}</td></tr>
                <tr><td style={{ padding: '3px 10px 3px 0', color: '#666' }}>消費税（{Math.round(view.taxRate * 100)}%）</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(view.tax)}</td></tr>
                <tr style={{ borderTop: '2px solid #1B2A4A' }}><td style={{ padding: '4px 10px 0 0', fontWeight: 800 }}>合計（税込）</td><td style={{ textAlign: 'right', fontWeight: 800, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{yen(view.total)}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 18, padding: 10, background: '#F6F7FA', borderRadius: 8, fontSize: 10.5 }}>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>お振込先</div>
            {view.issuer.bank.bankName
              ? <div>{view.issuer.bank.bankName} {view.issuer.bank.branch}支店　{view.issuer.bank.accountType}　{view.issuer.bank.accountNo}　名義　{view.issuer.bank.holder}</div>
              : <div style={{ color: '#b91c1c' }}>振込先が未登録です（設定 → {isHfu ? 'HFU → 日比建設 の請求書' : '請求書の自社情報'}）</div>}
            <div style={{ color: '#666', marginTop: 3 }}>恐れ入りますが、振込手数料は貴社にてご負担いただけますと幸いです。</div>
          </div>

          <div style={{ marginTop: 14, paddingTop: 8, borderTop: '1px solid #E6E9F0', fontSize: 9.5, color: '#444', display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{view.issuer.name || '（自社情報 未入力）'}{view.issuer.nameEn && `（${view.issuer.nameEn}）`}</div>
              {view.issuer.representative && <div>{view.issuer.representative}</div>}
              {view.issuer.postal && <div>〒{view.issuer.postal} {view.issuer.address}</div>}
              <div>{view.issuer.tel && `TEL ${view.issuer.tel}`} {view.issuer.fax && `　FAX ${view.issuer.fax}`}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>登録番号</div>
              <div style={{ fontWeight: 700 }}>{view.issuer.invoiceRegNo || '—'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── ページ2以降: 出面明細 ── */}
      {view.detail.map(site => (
        <div key={site.siteId} className="pi-page">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#1B2A4A' }}>出面明細　{site.siteName}</div>
            <div style={{ fontSize: 10, color: '#666' }}>{jpYm(view.ym)}分　{view.companyName} 御中</div>
          </div>
          <div className="pi-accent" style={{ marginBottom: 8 }} />
          <div style={{ overflowX: 'auto' }}>
            <table className="pi-detail-table">
              <thead>
                <tr>
                  <th className="pi-label" style={{ minWidth: 44 }}>氏名 / 会社</th>
                  {days.map(d => {
                    const wd = weekdayOf(view.ym, d)
                    return <th key={d} className={wd === 0 || wd === 6 ? 'pi-weekend' : ''}>{d}<br />{WEEKDAY_JA[wd]}</th>
                  })}
                  <th className="pi-total">残業計(h)</th>
                  <th className="pi-total">合計人工</th>
                </tr>
              </thead>
              <tbody>
                {site.rows.map(row => {
                  const otTotal = Object.values(row.cells).reduce((s, c) => s + (c.ot || 0), 0)
                  return (
                    <tr key={row.key}>
                      <td className="pi-label">{row.label}</td>
                      {days.map(d => {
                        const cell = row.cells[d]
                        const wd = weekdayOf(view.ym, d)
                        const cls = [cell?.night ? 'pi-night' : '', (wd === 0 || wd === 6) && !cell?.night ? 'pi-weekend' : ''].filter(Boolean).join(' ')
                        return <td key={d} className={cls}>{cell ? fmtMd(cell.md) : ''}</td>
                      })}
                      <td className="pi-total">{otTotal > 0 ? fmtMd(Math.round(otTotal * 10) / 10) : ''}</td>
                      <td className="pi-total">{fmtMd(row.total)}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="pi-label" style={{ fontWeight: 700 }}>現場合計</td>
                  {days.map(d => <td key={d} className="pi-total">{site.dayTotals[d] ? fmtMd(site.dayTotals[d]) : ''}</td>)}
                  <td className="pi-total" />
                  <td className="pi-total">{fmtMd(site.siteTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 8, color: '#888', marginTop: 6 }}>
            人工は 1=日勤／0.5=半日／1.5=夜勤／2.5=日勤+夜勤 の単位です（背景色のセルは夜勤を含む日）。
            {isHfu
              ? '残業計の時間は、請求書本体の「残業」の行（時間 × 残業単価）に載せています。'
              : '残業計の時間は 7時間（日本人・外注は8時間）で1人工に換算し、請求書本体の人工に含めています。「（外注）」は応援先へ連れて行った外注先の人工です。'}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function PeerInvoicePage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中…</div>}>
      <PeerInvoicePageInner />
    </Suspense>
  )
}

'use client'

/**
 * 同業者との請求・支払（2026-09-15）
 *
 * 二次業者同士の人の貸し借りは相殺せず、互いに請求書を送り合う。
 * 月ごと・会社ごとに「請求する側」と「支払う側」を分けて並べ、届いた請求書・送る請求書と突き合わせる。
 * 金額は出面の実績から出した見込み。
 *
 * 2026-10-01 改修（UI順次改修 波2・見本キャンバス9段目）:
 *   旧: 会社ごとの大きな表が縦に並び、請求書を作ったかどうかは小さな札だけ。
 *   新: ① 上に「今やること」（請求書を作る・承認待ち・差し戻し／取り下げ・発行済み）
 *       ② 合計3枚（請求する・支払う・HFU→日比建設）
 *       ③ 会社ごとに1行（請求額・支払額・請求書の状態・次の操作）。行を押すと右に現場ごとの内訳
 *   金額の計算・請求書の状態の決め方は変えない（見せ方だけ）。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchWithAuth } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { shiftYm } from '@/lib/month-nav'
import type { PeerStatement } from '@/lib/peer-statement'
import { HFU_INVOICE_COMPANY_ID } from '@/lib/constants'
import { latestPeerInvoiceRecord } from '@/lib/peer-invoice-latest'
import { currentYmJst } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Segment, Chip, SidePanel, CloseButton, type ChipTone } from '@/components/ui/PageParts'
import InvoiceNav from '@/components/invoice/InvoiceNav'

/** その月に発行・取り消しされた応援の請求書（app/api/peer-invoice） */
interface PeerInvoiceSummary {
  id: string; no: string; companyId: string; total: number; status: 'pending' | 'issued' | 'void' | 'rejected' | 'withdrawn'
  issuedAt?: string; requestedAt?: string; rejectedAt?: string; voidedAt?: string
}

type InvState = 'issued' | 'pending' | 'returned' | 'paper' | 'none'
type Filter = 'all' | 'billing' | 'payment'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

export default function PeerStatementPage() {
  const { ready } = useAuthPassword()
  // 請求書の画面から「戻る」で来たときは、その月を開く（?ym=YYYYMM）
  const [ym, setYm] = useState(() => {
    if (typeof window === 'undefined') return currentYmJst()
    const q = new URLSearchParams(window.location.search).get('ym')
    return q && /^\d{6}$/.test(q) ? q : currentYmJst()
  })
  const [rows, setRows] = useState<PeerStatement[] | null>(null)
  const [err, setErr] = useState('')
  const [invoices, setInvoices] = useState<PeerInvoiceSummary[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  /** 紙（手作り）で出した請求書を入れた会社（app/api/paper-invoice・2026-10-02） */
  const [paperCos, setPaperCos] = useState<Map<string, string>>(new Map())  // companyId → 会社名

  // 月を素早く切り替えたとき、前の月の応答をあとから画面に出さない（lib/hooks/useLatestRequest・2026-10-02）
  const latest = useLatestRequest()
  const load = useCallback(async () => {
    if (!ready) return
    setRows(null); setErr('')
    const req = latest.begin()
    let stmtRes: Response, invRes: Response, paperRes: Response
    try {
      ;[stmtRes, invRes, paperRes] = await Promise.all([
        fetchWithAuth(`/api/peer-statement?ym=${ym}`, { signal: req.signal }),
        fetchWithAuth(`/api/peer-invoice?ym=${ym}`, { signal: req.signal }),
        fetchWithAuth(`/api/paper-invoice?ym=${ym}&lite=1`, { signal: req.signal }),
      ])
    } catch (e) {
      if (latest.isAbort(e) || !req.isCurrent()) return
      setErr('読み込みに失敗しました'); return
    }
    if (!req.isCurrent()) return
    if (!stmtRes.ok) { setErr('読み込みに失敗しました'); return }
    const data = await stmtRes.json()
    setRows(data.statements || [])
    if (invRes.ok) {
      const invData = await invRes.json()
      setInvoices(invData.invoices || [])
    } else {
      setInvoices([])
    }
    if (paperRes.ok) {
      const p = await paperRes.json()
      setPaperCos(new Map(((p.records || []) as { companyId: string; companyName: string }[]).map(r => [r.companyId, r.companyName])))
    } else {
      setPaperCos(new Map())
    }
  }, [ready, ym, latest])
  useEffect(() => { load() }, [load])
  useEffect(() => { setOpenId(null) }, [ym])

  /**
   * 会社の請求書の状態（発行済み → 承認待ち → 紙で発行済み → 差し戻し・取り下げ → まだ）。事務が申請 → 事業責任者が承認（2026-09-26）
   * 紙は差し戻しより先に見る: システムの申請を差し戻したあと手作りで出した月は、もう「直して再申請」ではない（2026-10-02）
   */
  const invStateOf = (companyId: string): { state: InvState; issued?: PeerInvoiceSummary } => {
    const issued = invoices.find(i => i.companyId === companyId && i.status === 'issued')
    if (issued) return { state: 'issued', issued }
    if (invoices.some(i => i.companyId === companyId && i.status === 'pending')) return { state: 'pending' }
    // 応援の請求書はしばらく手作りで発行する（2026-10-02 代表）。紙の請求書を入れた月は「作っていない」扱いにしない
    if (paperCos.has(companyId)) return { state: 'paper' }
    // 差し戻し・取り下げは「最後の動き」がそうなときだけ（その後に発行→取り消しなら作り直し＝まだ）
    const latest = latestPeerInvoiceRecord(invoices.filter(i => i.companyId === companyId))
    if (latest && (latest.status === 'rejected' || latest.status === 'withdrawn')) return { state: 'returned' }
    return { state: 'none' }
  }
  const hrefOf = (companyId: string) => `/peer-invoice?company=${companyId}&ym=${ym}`
  const STATE: Record<InvState, { label: string; tone: ChipTone }> = {
    issued: { label: '発行済み', tone: 'green' },
    pending: { label: '承認待ち', tone: 'blue' },
    returned: { label: '差し戻し・取り下げ', tone: 'amber' },
    paper: { label: '紙で発行済み', tone: 'cyan' },
    none: { label: 'まだ作っていない', tone: 'red' },
  }

  const list = rows || []
  const billingSum = list.reduce((s, r) => s + r.billingTotal, 0)
  const paymentSum = list.reduce((s, r) => s + r.paymentTotal, 0)
  const billingCos = list.filter(r => r.billingTotal > 0)
  const hfu = invStateOf(HFU_INVOICE_COMPANY_ID)
  // 請求書の対象: 請求のある会社 ＋ HFU → 日比建設 ＋ 紙の請求書だけある会社（出面上は請求が無くても、出した請求書は数える）
  const targets = [...billingCos.map(r => ({ id: r.companyId, name: r.companyName })), { id: HFU_INVOICE_COMPANY_ID, name: 'HFU → 日比建設' }]
  for (const [id, name] of paperCos) {
    if (!targets.some(t => t.id === id)) targets.push({ id, name })
  }
  const byState = (st: InvState) => targets.filter(t => invStateOf(t.id).state === st)
  const toMake = byState('none'), pending = byState('pending'), returned = byState('returned'), issued = byState('issued'), paper = byState('paper')
  const names = (xs: { name: string }[]) => xs.slice(0, 3).map(x => x.name).join('・') + (xs.length > 3 ? ` ほか${xs.length - 3}社` : '')
  const ymLabel = `${parseInt(ym.slice(4, 6))}月`

  const shown = list.filter(r => filter === 'all' || (filter === 'billing' ? r.billingTotal > 0 : r.paymentTotal > 0))
  const open = list.find(r => r.companyId === openId) || null

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="請求・原価"
        title="請求・支払の一覧"
        sub="応援に出した分は請求、来てもらった分は支払。出面から計算した金額です（相殺しません）"
        actions={
          <>
          <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
            <button type="button" aria-label="前の月" onClick={() => setYm(shiftYm(ym, -1))}
              className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px]">
              <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
            </button>
            <span className="px-1.5 text-[0.9375rem] font-bold tabular-nums">{ym.slice(0, 4)}年{parseInt(ym.slice(4, 6))}月分</span>
            <button type="button" aria-label="次の月" onClick={() => setYm(shiftYm(ym, 1))}
              className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px]">
              <Icon name="chevronRight" size={18} strokeWidth={2.2} />
            </button>
          </div>
          </>
        }
      />
      <InvoiceNav current="list" />

      {err && <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{err}</div>}
      {!rows && !err && <div className="text-center py-12 text-gray-400">集計中...</div>}

      {rows && (
        <>
          {/* ① 今やること */}
          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {/* 応援の請求書はしばらく手作りで発行する（2026-10-02 代表）ので、未作成は赤（急ぎ）にしない */}
            <TodoCard icon="doc" tone={toMake.length > 0 ? 'info' : 'ok'} title="請求書を作る"
              big={toMake.length > 0 ? `${toMake.length}社` : 'ありません'}
              sub={toMake.length > 0 ? `${names(toMake)}の${ymLabel}分。手作りで出したら「紙で出した請求書」に入れてください` : `${ymLabel}分はすべて作成済みです`}
              action={toMake.length > 0 ? '作る' : undefined}
              onClick={toMake.length > 0 ? () => { window.location.href = hrefOf(toMake[0].id) } : undefined} />
            <TodoCard icon="check" tone={pending.length > 0 ? 'info' : 'ok'} title="承認待ち"
              big={pending.length > 0 ? `${pending.length}件` : 'ありません'}
              sub={pending.length > 0 ? `${names(pending)}。事務が申請した請求書を、政仁さん・代表が承認して発行` : '事務が発行を申請するとここに出ます'}
              action={pending.length > 0 ? '開く' : undefined}
              onClick={pending.length > 0 ? () => { window.location.href = hrefOf(pending[0].id) } : undefined} />
            <TodoCard icon="alert" tone={returned.length > 0 ? 'warn' : 'ok'} title="差し戻し・取り下げ"
              big={returned.length > 0 ? `${returned.length}件` : 'ありません'}
              sub={returned.length > 0 ? `${names(returned)}。理由を見て直し、もう一度申請` : '差し戻されると、ここに出ます'}
              action={returned.length > 0 ? '開く' : undefined}
              onClick={returned.length > 0 ? () => { window.location.href = hrefOf(returned[0].id) } : undefined} />
            <TodoCard icon="check" tone="ok" title="発行済み"
              big={issued.length + paper.length > 0 ? `${issued.length + paper.length}件` : 'まだありません'}
              sub={issued.length + paper.length > 0
                ? [issued.length > 0 ? names(issued) : '', paper.length > 0 ? `紙: ${names(paper)}` : ''].filter(Boolean).join(' ／ ')
                : `${ymLabel}分で発行した請求書がここに出ます`}
              action={paper.length > 0 ? '紙の請求書' : undefined}
              onClick={paper.length > 0 ? () => { window.location.href = `/paper-invoice?ym=${ym}` } : undefined} />
          </section>

          {/* ② 合計 */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Stat label={`請求する（${billingCos.length}社）`} value={yen(billingSum)} sub="応援に出した人工 × 単価（税抜）" />
            <Stat label={`支払う（${list.filter(r => r.paymentTotal > 0).length}社）`} value={yen(paymentSum)} sub="来てもらった人工 × 単価（税抜）" />
            <a href={hrefOf(HFU_INVOICE_COMPANY_ID)} className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4 flex flex-col gap-1 hover:border-hibi-navy dark:hover:border-blue-400 transition">
              <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">HFU → 日比建設</span>
              <span className="text-[1.625rem] font-bold tabular-nums text-gray-900 dark:text-white">{hfu.issued ? yen(hfu.issued.total) : '—'}</span>
              <span className="flex items-center gap-2 text-xs text-hibi-sub dark:text-gray-400">
                <Chip tone={STATE[hfu.state].tone}>{STATE[hfu.state].label}{hfu.issued ? ` ${hfu.issued.no}` : ''}</Chip>
                グループ内の請求。上の合計には入れない
              </span>
            </a>
          </section>

          {/* ③ 会社ごと */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">会社ごと（{ymLabel}分）</h2>
              <Segment value={filter} onChange={setFilter} items={[
                ['all', `すべて ${list.length}`], ['billing', `請求あり ${billingCos.length}`], ['payment', `支払あり ${list.filter(r => r.paymentTotal > 0).length}`],
              ]} />
              <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">行を押すと、現場ごとの内訳が右に開きます</span>
            </div>
            <div className="hidden lg:grid grid-cols-[minmax(0,1fr)_150px_150px_200px_150px] gap-3.5 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
              <span>会社</span><span className="text-right">請求する</span><span className="text-right">支払う</span><span>請求書</span><span />
            </div>
            {list.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この月の貸し借りはありません</div>
            ) : shown.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この絞り込みに当てはまる会社はありません</div>
            ) : shown.map(r => {
              const st = r.billingTotal > 0 || paperCos.has(r.companyId) ? invStateOf(r.companyId) : null
              return (
                <div key={r.companyId} role="button" tabIndex={0}
                  onClick={() => setOpenId(r.companyId)}
                  onKeyDown={e => { if (e.key === 'Enter') setOpenId(r.companyId) }}
                  className="border-t border-hibi-line dark:border-gray-700 first-of-type:border-t-0 px-5 py-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_150px_150px_200px_150px] gap-2 lg:gap-3.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition">
                  <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100">{r.companyName}</span>
                  <span className="lg:text-right text-[1.0625rem] font-bold tabular-nums text-gray-900 dark:text-white">{r.billingTotal > 0 ? yen(r.billingTotal) : <span className="text-gray-300 dark:text-gray-600">—</span>}</span>
                  <span className="lg:text-right text-[1.0625rem] font-bold tabular-nums text-gray-900 dark:text-white">{r.paymentTotal > 0 ? yen(r.paymentTotal) : <span className="text-gray-300 dark:text-gray-600">—</span>}</span>
                  <span>{st ? <Chip tone={STATE[st.state].tone}>{STATE[st.state].label}{st.issued ? ` ${st.issued.no}` : ''}</Chip> : <Chip tone="gray">支払のみ</Chip>}</span>
                  <span className="lg:text-right" onClick={e => e.stopPropagation()}>
                    {st && (
                      <a href={st.state === 'paper' ? `/paper-invoice?ym=${ym}` : hrefOf(r.companyId)}
                        className={`inline-flex items-center h-9 px-3.5 rounded-[9px] text-[0.8125rem] font-bold whitespace-nowrap ${
                          st.state === 'none' ? 'bg-hibi-navy text-white hover:bg-hibi-light'
                          : st.state === 'pending' ? 'bg-green-700 text-white hover:bg-green-800'
                          : 'border border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'
                        }`}>
                        {st.state === 'none' ? '請求書を作る' : st.state === 'pending' ? '開いて承認' : st.state === 'paper' ? '紙の請求書を見る' : '請求書を開く'}
                      </a>
                    )}
                  </span>
                </div>
              )
            })}
          </section>

          <p className="text-xs text-hibi-sub dark:text-gray-400 leading-relaxed">
            請求の人工には、その応援現場へ連れて行った外注の人工も含みます。残業は時間を人工に換算して加えています（鳶・外注は8時間、外国人は7時間で1人工）。
            単価は現場マスタの単価タブ（工種ごと）の受取単価、支払は出面の外注原価（借りる単価）です。
          </p>
        </>
      )}

      {/* 会社の内訳（右から開く） */}
      {open && (
        <SidePanel label={`${open.companyName} の内訳`} onClose={() => setOpenId(null)}>
          <div className="p-6 space-y-6">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white">{open.companyName}</h2>
                <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                  {ym.slice(0, 4)}年{ymLabel}分{open.billingTotal > 0 && ` ／ 請求 ${yen(open.billingTotal)}`}{open.paymentTotal > 0 && ` ／ 支払 ${yen(open.paymentTotal)}`}（税抜）
                </div>
              </div>
              <CloseButton onClick={() => setOpenId(null)} />
            </div>

            {open.billing.length > 0 && (() => {
              const st = invStateOf(open.companyId)
              return (
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-gray-900 dark:text-white">請求する（応援に出した分）</h3>
                    <Chip tone={STATE[st.state].tone}>{STATE[st.state].label}{st.issued ? ` ${st.issued.no}` : ''}</Chip>
                  </div>
                  <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-sm">
                    <div className="grid grid-cols-[minmax(0,1fr)_56px_76px_56px_76px_100px] gap-2 px-3 py-2 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
                      <span>現場（工種）</span><span className="text-right">鳶 人工</span><span className="text-right">単価</span><span className="text-right">土工</span><span className="text-right">単価</span><span className="text-right">金額</span>
                    </div>
                    {open.billing.map(l => (
                      <div key={l.siteId} className="grid grid-cols-[minmax(0,1fr)_56px_76px_56px_76px_100px] gap-2 px-3 py-2 border-t border-hibi-line dark:border-gray-700 tabular-nums">
                        <span className="font-bold truncate">{l.siteName}</span>
                        <span className="text-right">{l.tobiDays || '—'}</span>
                        <span className="text-right text-hibi-sub">{l.tobiDays ? yen(l.tobiRate) : '—'}</span>
                        <span className="text-right">{l.dokoDays || '—'}</span>
                        <span className="text-right text-hibi-sub">{l.dokoDays ? yen(l.dokoRate) : '—'}</span>
                        <span className="text-right font-bold">{yen(l.amount)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between px-3 py-2.5 border-t-2 border-gray-300 dark:border-gray-600">
                      <span className="font-bold">合計</span><span className="text-lg font-bold tabular-nums">{yen(open.billingTotal)}</span>
                    </div>
                  </div>
                  <a href={hrefOf(open.companyId)}
                    className={`flex items-center justify-center h-11 rounded-[10px] text-[0.9375rem] font-bold ${st.state === 'none' ? 'bg-hibi-navy text-white hover:bg-hibi-light' : st.state === 'pending' ? 'bg-green-700 text-white hover:bg-green-800' : 'border border-gray-300 dark:border-gray-600 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'}`}>
                    {st.state === 'none' ? '請求書を作る（下書きを開く）' : st.state === 'pending' ? '請求書を開いて承認する' : '請求書を開く'}
                  </a>
                  <p className="text-xs text-hibi-sub dark:text-gray-400">事務は「発行を申請」、政仁さん・代表は「承認して発行」。発行すると番号が付き、内容が固定されます</p>
                </section>
              )
            })()}

            {open.payments.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-base font-bold text-gray-900 dark:text-white">支払う（来てもらった分）</h3>
                <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-sm">
                  <div className="grid grid-cols-[minmax(0,1fr)_64px_72px_110px] gap-2 px-3 py-2 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
                    <span>現場（工種）</span><span className="text-right">人工</span><span className="text-right">残業(h)</span><span className="text-right">金額</span>
                  </div>
                  {open.payments.map(l => (
                    <div key={l.siteId} className="grid grid-cols-[minmax(0,1fr)_64px_72px_110px] gap-2 px-3 py-2 border-t border-hibi-line dark:border-gray-700 tabular-nums">
                      <span className="font-bold truncate">{l.siteName}</span>
                      <span className="text-right">{l.days}</span>
                      <span className="text-right text-hibi-sub">{l.otHours || '—'}</span>
                      <span className="text-right font-bold">{yen(l.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between px-3 py-2.5 border-t-2 border-gray-300 dark:border-gray-600">
                    <span className="font-bold">合計</span><span className="text-lg font-bold tabular-nums">{yen(open.paymentTotal)}</span>
                  </div>
                </div>
                <p className="text-xs text-hibi-sub dark:text-gray-400">相手の会社から届く請求書と、この金額を突き合わせてください</p>
              </section>
            )}
          </div>
        </SidePanel>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4 flex flex-col gap-1">
      <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{label}</span>
      <span className="text-[1.625rem] font-bold tabular-nums text-gray-900 dark:text-white">{value}</span>
      <span className="text-xs text-hibi-sub dark:text-gray-400">{sub}</span>
    </div>
  )
}

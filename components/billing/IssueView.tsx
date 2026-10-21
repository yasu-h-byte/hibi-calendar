'use client'

/**
 * 「請求・原価」のタブ②「出す請求書」（2026-10-20・代表「請求と原価の画面を統合」）。
 *
 * その月に日比建設が出す請求書を1つの表にする:
 *   - 山岡への請求書（自社現場・大林組の控えから作る・lib/prime-invoice.ts）: 現場ごとに1件
 *   - 応援の請求書（同業者へ・lib/peer-invoice.ts）: 会社ごとに1件（金額は出面からの見込み。発行済みなら凍結額）
 *   - HFU → 日比建設 の請求書（lib/hfu-invoice.ts）
 * 作る・確認する・印刷するのは各請求書の画面（/prime-invoice・/peer-invoice）。ここは状態の一覧と入口。
 * 旧「請求・支払の一覧」（/peer-statement）の請求する側を引き継いだ。支払う側はタブ③へ。
 */
import { useCallback, useEffect, useState } from 'react'
import { fmtYen as yen } from '@/lib/format'
import { fetchWithAuth } from '@/lib/api-client'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { can } from '@/lib/permissions'
import type { PeerStatement } from '@/lib/peer-statement'
import { HFU_INVOICE_COMPANY_ID } from '@/lib/constants'
import { latestPeerInvoiceRecord } from '@/lib/peer-invoice-latest'
import { TodoCard, Chip, type ChipTone } from '@/components/ui/PageParts'

interface PeerInvoiceSummary {
  id: string; no: string; companyId: string; total: number; status: 'pending' | 'issued' | 'void' | 'rejected' | 'withdrawn'
  issuedAt?: string; requestedAt?: string; rejectedAt?: string; voidedAt?: string
}
interface PrimeSummary { id: string; siteId: string; siteName: string; companyId: string; companyName: string; status: string; total: number; no: string; sheets: { length: number } | unknown[] }

type InvState = 'issued' | 'pending' | 'checked' | 'returned' | 'paper' | 'draft' | 'none'
const STATE: Record<InvState, { label: string; tone: ChipTone }> = {
  issued: { label: '発行済み', tone: 'green' },
  pending: { label: '確認1待ち', tone: 'blue' },
  checked: { label: '確認2待ち', tone: 'cyan' },
  draft: { label: '下書き', tone: 'gray' },
  paper: { label: '紙で発行済み', tone: 'cyan' },
  returned: { label: '差し戻し・取り下げ', tone: 'amber' },
  none: { label: 'まだ', tone: 'amber' },
}

interface Row {
  key: string
  kind: '山岡' | '応援' | 'HFU'
  title: string
  sub: string
  state: InvState
  /** 税抜の見込み（応援）／税込の額（山岡・発行済み） */
  amount: number | null
  amountLabel: string
  no: string
  href: string
  action: string
}

export default function IssueView({ ym }: { ym: string }) {
  const { user, ready } = useAuthPassword()
  const canRequest = can(user, 'invoice.request')
  const [stmts, setStmts] = useState<PeerStatement[] | null>(null)
  const [invoices, setInvoices] = useState<PeerInvoiceSummary[]>([])
  const [paperCos, setPaperCos] = useState<Map<string, string>>(new Map())
  const [prime, setPrime] = useState<{ records: PrimeSummary[]; companies: { id: string; name: string }[]; sites: Record<string, { id: string; name: string }[]> } | null>(null)
  const [err, setErr] = useState('')

  const latest = useLatestRequest()
  const load = useCallback(async () => {
    if (!ready) return
    setStmts(null); setErr('')
    const req = latest.begin()
    let a: Response, b: Response, c: Response, d: Response
    try {
      ;[a, b, c, d] = await Promise.all([
        fetchWithAuth(`/api/peer-statement?ym=${ym}`, { signal: req.signal }),
        fetchWithAuth(`/api/peer-invoice?ym=${ym}`, { signal: req.signal }),
        fetchWithAuth(`/api/paper-invoice?ym=${ym}&lite=1`, { signal: req.signal }),
        fetchWithAuth(`/api/prime-invoice?ym=${ym}`, { signal: req.signal }),
      ])
    } catch (e) {
      if (latest.isAbort(e) || !req.isCurrent()) return
      setErr('読み込みに失敗しました'); return
    }
    if (!req.isCurrent()) return
    if (!a.ok) { setErr('読み込みに失敗しました'); return }
    const sj = await a.json()
    setStmts(sj.statements || [])
    setInvoices(b.ok ? ((await b.json()).invoices || []) : [])
    if (c.ok) {
      const p = await c.json()
      setPaperCos(new Map(((p.records || []) as { companyId: string; companyName: string }[]).map(r => [r.companyId, r.companyName])))
    } else setPaperCos(new Map())
    if (d.ok) {
      const p = await d.json()
      setPrime({ records: p.records || [], companies: p.companies || [], sites: p.sites || {} })
    } else setPrime(null)
  }, [ready, ym, latest])
  useEffect(() => { load() }, [load])

  const peerStateOf = (companyId: string): { state: InvState; issued?: PeerInvoiceSummary } => {
    const issued = invoices.find(i => i.companyId === companyId && i.status === 'issued')
    if (issued) return { state: 'issued', issued }
    if (invoices.some(i => i.companyId === companyId && i.status === 'pending')) return { state: 'pending' }
    if (paperCos.has(companyId)) return { state: 'paper' }
    const last = latestPeerInvoiceRecord(invoices.filter(i => i.companyId === companyId))
    if (last && (last.status === 'rejected' || last.status === 'withdrawn')) return { state: 'returned' }
    return { state: 'none' }
  }

  const rows: Row[] = []
  // ── 山岡への請求書（自社現場）: 現場ごと ──
  if (prime) {
    for (const co of prime.companies) {
      for (const site of prime.sites[co.id] || []) {
        const live = prime.records.filter(r => r.siteId === site.id && r.companyId === co.id && r.status !== 'void')
        const rec = live.find(r => r.status === 'issued') || live[0]
        const state: InvState = !rec ? 'none' : rec.status === 'issued' ? 'issued' : rec.status === 'pending' ? 'pending' : rec.status === 'checked' ? 'checked' : 'draft'
        rows.push({
          key: `prime_${co.id}_${site.id}`, kind: '山岡', title: site.name, sub: `${co.name} へ（大林組の控えから）`,
          state, amount: rec ? rec.total : null, amountLabel: '税込', no: rec?.no || '',
          href: rec ? `/prime-invoice?ym=${ym}&id=${rec.id}` : `/prime-invoice?ym=${ym}`,
          action: !rec ? '控えを入れて作る' : state === 'pending' ? '確認1へ' : state === 'checked' ? '確認2へ' : state === 'draft' ? '続きを作る' : '開く・印刷',
        })
      }
    }
  }
  // ── 応援の請求書（同業者へ）: 会社ごと ──
  const billingCos = (stmts || []).filter(r => r.billingTotal > 0)
  const peerTargets = [...billingCos.map(r => ({ id: r.companyId, name: r.companyName, estimate: r.billingTotal }))]
  for (const [id, name] of paperCos) if (!peerTargets.some(t => t.id === id) && id !== HFU_INVOICE_COMPANY_ID) peerTargets.push({ id, name, estimate: 0 })
  for (const t of peerTargets) {
    const st = peerStateOf(t.id)
    rows.push({
      key: `peer_${t.id}`, kind: '応援', title: t.name, sub: '応援に出した人工 × 単価',
      state: st.state, amount: st.issued ? st.issued.total : t.estimate || null, amountLabel: st.issued ? '税込' : '税抜・見込み', no: st.issued?.no || '',
      href: st.state === 'paper' ? `/paper-invoice?ym=${ym}` : `/peer-invoice?company=${t.id}&ym=${ym}`,
      action: st.state === 'none' ? '請求書を作る' : st.state === 'pending' ? '開いて承認' : st.state === 'paper' ? '紙の控えを見る' : st.state === 'returned' ? '直して再申請' : '開く・印刷',
    })
  }
  // ── HFU → 日比建設 ──
  {
    const st = peerStateOf(HFU_INVOICE_COMPANY_ID)
    rows.push({
      key: 'hfu', kind: 'HFU', title: 'HFU → 日比建設', sub: 'グループ内の請求（HFU 所属の人工 × 社内単価）',
      state: st.state, amount: st.issued ? st.issued.total : null, amountLabel: st.issued ? '税込' : '', no: st.issued?.no || '',
      href: st.state === 'paper' ? `/paper-invoice?ym=${ym}` : `/peer-invoice?company=${HFU_INVOICE_COMPANY_ID}&ym=${ym}`,
      action: st.state === 'none' ? '請求書を作る' : st.state === 'pending' ? '開いて承認' : st.state === 'paper' ? '紙の控えを見る' : st.state === 'returned' ? '直して再申請' : '開く・印刷',
    })
  }

  const count = (s: InvState[]) => rows.filter(r => s.includes(r.state)).length
  const names = (s: InvState[]) => { const xs = rows.filter(r => s.includes(r.state)); return xs.slice(0, 3).map(x => x.title).join('・') + (xs.length > 3 ? ` ほか${xs.length - 3}件` : '') }
  const issuedTotal = rows.filter(r => r.state === 'issued' && r.kind !== 'HFU').reduce((t, r) => t + (r.amount || 0), 0)
  const ymLabel = `${parseInt(ym.slice(4, 6))}月`

  return (
    <div className="space-y-5">
      <p className="text-sm text-hibi-sub dark:text-gray-400">
        この月に日比建設が出す請求書。山岡への請求書は大林組の控えから自動で作り（森田さん → 政仁さんが確認1 → 代表が確認2して発行）、応援の請求書は出面から見込みを出します（しばらく手作りで発行し、紙の控えを入れます）。
      </p>
      {err && <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{err}</div>}
      {!stmts && !err && <div className="text-center py-12 text-gray-400">集計中...</div>}
      {stmts && (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <TodoCard icon="doc" tone={count(['none', 'draft', 'returned']) > 0 ? 'info' : 'ok'} title="作る・続きを作る"
              big={count(['none', 'draft', 'returned']) > 0 ? `${count(['none', 'draft', 'returned'])}件` : 'ありません'}
              sub={count(['none', 'draft', 'returned']) > 0 ? `${names(['none', 'draft', 'returned'])}の${ymLabel}分` : `${ymLabel}分はすべて作成済みです`} />
            <TodoCard icon="bell" tone={count(['pending', 'checked']) > 0 ? 'warn' : 'ok'} title="確認待ち"
              big={count(['pending', 'checked']) > 0 ? `${count(['pending', 'checked'])}件` : 'ありません'}
              sub={count(['pending', 'checked']) > 0 ? `${names(['pending', 'checked'])}。政仁さんの確認1 → 代表の確認2で発行` : '申請されるとここに出ます'} />
            <TodoCard icon="check" tone="ok" title="発行済み（紙を含む）"
              big={count(['issued', 'paper']) > 0 ? `${count(['issued', 'paper'])}件` : 'まだありません'}
              sub={count(['issued', 'paper']) > 0 ? names(['issued', 'paper']) : `${ymLabel}分で発行した請求書がここに出ます`} />
            <TodoCard icon="yen" tone="info" title="発行済みの請求額（税込）" big={issuedTotal > 0 ? yen(issuedTotal) : '—'} sub="山岡・応援の発行済み（HFU → 日比建設 は含めない）" />
          </section>

          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">出す請求書（{ymLabel}分）</h2>
              <span className="text-xs text-hibi-sub dark:text-gray-400">応援の請求書は手作りで出したら「紙で出した控え」に入れます</span>
              {canRequest && (
                <a href={`/paper-invoice?ym=${ym}`} className="ml-auto inline-flex items-center h-9 px-3.5 rounded-[9px] text-[0.8125rem] font-bold whitespace-nowrap border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                  紙で出した請求書（応援）を入れる
                </a>
              )}
            </div>
            <div className="hidden lg:grid grid-cols-[90px_minmax(0,1fr)_170px_150px_170px] gap-3.5 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
              <span>種類</span><span>宛先・現場</span><span className="text-right">金額</span><span>状態</span><span />
            </div>
            {rows.length === 0 && <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この月に出す請求書はありません</div>}
            {rows.map(r => (
              <div key={r.key} className="border-t border-hibi-line dark:border-gray-700 px-5 py-3 grid grid-cols-1 lg:grid-cols-[90px_minmax(0,1fr)_170px_150px_170px] gap-2 lg:gap-3.5 items-center">
                <span><Chip tone={r.kind === '山岡' ? 'blue' : r.kind === '応援' ? 'gray' : 'cyan'}>{r.kind === '山岡' ? '山岡へ' : r.kind === '応援' ? '応援' : 'グループ内'}</Chip></span>
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{r.title}</span>
                  <span className="block text-xs text-hibi-sub dark:text-gray-400 truncate">{r.sub}{r.no ? `・${r.no}` : ''}</span>
                </span>
                <span className="lg:text-right text-[1.0625rem] font-bold tabular-nums text-gray-900 dark:text-white">
                  {r.amount ? yen(r.amount) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  {r.amount && r.amountLabel ? <span className="block lg:inline text-2xs font-normal text-hibi-sub dark:text-gray-400 lg:ml-1">{r.amountLabel}</span> : null}
                </span>
                <span><Chip tone={STATE[r.state].tone}>{STATE[r.state].label}</Chip></span>
                <span className="lg:text-right flex lg:justify-end gap-2 flex-wrap">
                  {(canRequest || r.state !== 'none') && (
                    <a href={r.href} className={`inline-flex items-center h-9 px-3.5 rounded-[9px] text-[0.8125rem] font-bold whitespace-nowrap ${
                      r.state === 'none' || r.state === 'draft' || r.state === 'returned' ? 'bg-hibi-navy text-white hover:bg-hibi-light'
                      : r.state === 'pending' || r.state === 'checked' ? 'bg-green-700 text-white hover:bg-green-800'
                      : 'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700'}`}>
                      {r.kind === '応援' && (r.state === 'none' || r.state === 'returned') ? 'システムで作る' : r.action}
                    </a>
                  )}
                  {/* 応援の請求書はしばらく手作り（2026-10-02 代表）。手作りで出したら紙の控えを入れる入口をここにも */}
                  {canRequest && r.kind === '応援' && (r.state === 'none' || r.state === 'returned') && (
                    <a href={`/paper-invoice?ym=${ym}`} className="inline-flex items-center h-9 px-3.5 rounded-[9px] text-[0.8125rem] font-bold whitespace-nowrap border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                      紙の控えを入れる
                    </a>
                  )}
                </span>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

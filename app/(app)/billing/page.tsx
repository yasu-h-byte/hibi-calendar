'use client'

/**
 * 請求・原価（2026-10-20・代表「請求と原価の2画面を統合」）。
 *
 * お金の向きで3つのタブに分け、月を共通の軸にする:
 *   ① 現場ごと（売上・原価・粗利）  … 旧 原価・収益（components/billing/CostView.tsx）。売上は請求書とつながった額
 *   ② 出す請求書                     … 旧 請求・支払の一覧の請求する側＋山岡への請求書の一覧（components/billing/IssueView.tsx）
 *   ③ 受け取る（支払・入金）         … 旧 受け取った請求書（components/billing/ReceiveView.tsx）＋ 支払う側の見込み（PaymentsPreview）
 * 請求書そのものの画面（/prime-invoice・/peer-invoice・/paper-invoice）はそのまま。②の行から開く。
 * 旧 URL（/cost・/peer-statement・/subcon-invoice）は next.config.js で転送。
 */
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuthPassword } from '@/lib/hooks/useAuthPassword'
import { can } from '@/lib/permissions'
import { shiftYm } from '@/lib/month-nav'
import { currentYmJst, todayJstDate } from '@/lib/date-utils'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, UnderlineTabs } from '@/components/ui/PageParts'
import CostView from '@/components/billing/CostView'
import IssueView from '@/components/billing/IssueView'
import ReceiveView from '@/components/billing/ReceiveView'
import PaymentsPreview from '@/components/billing/PaymentsPreview'

type Tab = 'sites' | 'issue' | 'receive'

/** 最初に開く月: 毎月10日までは前の月（月初は今月の数字がほとんどなく、請求書も前月分を作る時期のため） */
function defaultYm(): string {
  const today = todayJstDate()
  if (today.getDate() > 10) return currentYmJst()
  return shiftYm(currentYmJst(), -1)
}

function BillingPageInner() {
  const sp = useSearchParams()
  const { user, ready } = useAuthPassword()
  const canCost = can(user, 'cost.view')
  const canInvoice = can(user, 'invoice.view')
  const [ym, setYm] = useState(() => { const q = sp.get('ym'); return q && /^\d{6}$/.test(q) ? q : defaultYm() })
  const [tab, setTab] = useState<Tab>(() => { const t = sp.get('tab'); return t === 'issue' || t === 'receive' || t === 'sites' ? t : 'sites' })

  // 権限に合わせて開けるタブ（原価を見られない人は②から）
  useEffect(() => {
    if (!ready) return
    if (tab === 'sites' && !canCost) setTab('issue')
  }, [ready, canCost, tab])

  // URL に月とタブを残す（ブックマーク・戻る・通知ベルのリンク）
  useEffect(() => {
    if (typeof window === 'undefined') return
    const u = new URL(window.location.href)
    u.searchParams.set('tab', tab); u.searchParams.set('ym', ym)
    window.history.replaceState(null, '', u.toString())
  }, [tab, ym])

  const tabs: { key: Tab; label: string }[] = [
    ...(canCost ? [{ key: 'sites' as const, label: '現場ごと（売上・原価・粗利）' }] : []),
    ...(canInvoice ? [{ key: 'issue' as const, label: '出す請求書' }, { key: 'receive' as const, label: '受け取る（支払・入金）' }] : []),
  ]
  const ymLabel = `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月分`

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="請求・原価"
        title="請求・原価"
        sub="現場ごとの儲けを見る・請求書を出す・届いた請求書と支払内訳書を入れる。金額は税抜（請求書の額は税込も出ます）"
        actions={
          <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
            <button type="button" aria-label="前の月" onClick={() => setYm(shiftYm(ym, -1))}
              className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px]">
              <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
            </button>
            <span className="px-1.5 text-[0.9375rem] font-bold tabular-nums whitespace-nowrap">{ymLabel}</span>
            <button type="button" aria-label="次の月" onClick={() => setYm(shiftYm(ym, 1))}
              className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px]">
              <Icon name="chevronRight" size={18} strokeWidth={2.2} />
            </button>
          </div>
        }
      />
      {tabs.length > 0 && <UnderlineTabs tabs={tabs} active={tab} onChange={setTab} label="請求・原価のタブ" />}
      {ready && tab === 'sites' && canCost && <CostView ym={ym} onYmChange={setYm} />}
      {ready && tab === 'issue' && canInvoice && <IssueView ym={ym} />}
      {ready && tab === 'receive' && canInvoice && (
        <div className="space-y-5">
          <PaymentsPreview ym={ym} />
          <ReceiveView ym={ym} onYmChange={setYm} />
        </div>
      )}
    </div>
  )
}

export default function BillingPage() {
  return <Suspense fallback={<div className="text-center py-12 text-gray-400">読み込み中...</div>}><BillingPageInner /></Suspense>
}
